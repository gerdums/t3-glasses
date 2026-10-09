/** HTTP API for the glasses app; see packages/protocol for the contract. */
import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  PROTOCOL_VERSION,
  type AnswerRequest,
  type ApprovalDecision,
  type ApprovalRequest,
  type BridgeEvent,
  type HealthResponse,
  type SendMessageRequest,
} from "@t3-glasses/protocol";
import type { BridgeConfig } from "./config.js";
import { NotFoundError, type Hub } from "./hub.js";
import { transcribe, transcriptionAvailable } from "./stt.js";

export const VERSION = "0.1.0";
const MAX_JSON_BYTES = 64 * 1024;
const MAX_AUDIO_BYTES = 16_000 * 2 * 180; // three minutes of 16 kHz s16le mono
const DECISIONS = new Set<ApprovalDecision>(["accept", "acceptForSession", "acceptAlways", "decline", "cancel"]);

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function tokensMatch(presented: string | null | undefined, expected: string): boolean {
  if (!presented) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function readBody(request: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new HttpError(413, "Request body too large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

async function readJson<T>(request: IncomingMessage): Promise<T> {
  const body = await readBody(request, MAX_JSON_BYTES);
  try {
    return JSON.parse(body.toString("utf8") || "{}") as T;
  } catch {
    throw new HttpError(400, "Body must be JSON");
  }
}

function send(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

export function createBridgeServer(hub: Hub, config: () => BridgeConfig): Server {
  const sseClients = new Set<ServerResponse>();

  const broadcast = (event: BridgeEvent) => {
    const frame = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
    for (const client of sseClients) client.write(frame);
  };
  hub.on("change", () => broadcast({ type: "envs", envs: hub.envs() }));
  const heartbeat = setInterval(() => {
    for (const client of sseClients) client.write(": ping\n\n");
  }, 15_000);
  heartbeat.unref();

  const server = createServer(async (request, response) => {
    const current = config();
    const origin = request.headers.origin;
    const allowAny = current.allowedOrigins.includes("*");
    if (origin && (allowAny || current.allowedOrigins.includes(origin))) {
      response.setHeader("access-control-allow-origin", origin);
      response.setHeader("vary", "origin");
    }
    response.setHeader("access-control-allow-headers", "authorization, content-type");
    response.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
    response.setHeader("access-control-allow-private-network", "true");
    response.setHeader("access-control-max-age", "600");
    if (request.method === "OPTIONS") {
      response.writeHead(204).end();
      return;
    }

    const url = new URL(request.url ?? "/", "http://bridge");
    try {
      if (url.pathname === "/" && request.method === "GET") {
        response.writeHead(200, { "content-type": "text/plain" }).end("t3-glasses bridge\n");
        return;
      }

      const bearer = request.headers.authorization?.startsWith("Bearer ")
        ? request.headers.authorization.slice(7).trim()
        : url.searchParams.get("token");
      if (!tokensMatch(bearer, current.glassesToken)) throw new HttpError(401, "Invalid glasses token");

      const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
      const route = `${request.method} /${parts.join("/")}`;

      if (route === "GET /api/health") {
        const body: HealthResponse = {
          ok: true,
          version: VERSION,
          protocol: PROTOCOL_VERSION,
          transcription: transcriptionAvailable(current.transcription),
        };
        send(response, 200, body);
        return;
      }
      if (route === "GET /api/envs") {
        send(response, 200, { envs: hub.envs() });
        return;
      }
      if (route === "GET /api/threads") {
        const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 20, 1), 50);
        send(response, 200, { threads: hub.threads(url.searchParams.get("env") || undefined, limit) });
        return;
      }
      if (route === "GET /api/events") {
        response.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-store",
          connection: "keep-alive",
        });
        response.write(`event: envs\ndata: ${JSON.stringify({ type: "envs", envs: hub.envs() })}\n\n`);
        sseClients.add(response);
        request.on("close", () => sseClients.delete(response));
        return;
      }
      if (route === "POST /api/transcribe") {
        const audio = await readBody(request, MAX_AUDIO_BYTES);
        send(response, 200, { text: await transcribe(audio, current.transcription) });
        return;
      }

      // /api/envs/:env/threads/:thread[/action]
      if (parts[0] === "api" && parts[1] === "envs" && parts[3] === "threads" && parts[2] && parts[4]) {
        const env = parts[2];
        const thread = parts[4];
        const action = parts[5];
        if (request.method === "GET" && !action) {
          send(response, 200, await hub.thread(env, thread));
          return;
        }
        if (request.method === "POST" && action === "messages") {
          const body = await readJson<SendMessageRequest>(request);
          if (typeof body.text !== "string") throw new HttpError(400, "text is required");
          await hub.send(env, thread, body.text, body.mode === "queue" ? "queue" : "auto");
          send(response, 200, { ok: true });
          return;
        }
        if (request.method === "POST" && action === "approval") {
          const body = await readJson<ApprovalRequest>(request);
          if (!body.requestId || !DECISIONS.has(body.decision)) throw new HttpError(400, "requestId and a valid decision are required");
          await hub.approve(env, thread, body.requestId, body.decision);
          send(response, 200, { ok: true });
          return;
        }
        if (request.method === "POST" && action === "answer") {
          const body = await readJson<AnswerRequest>(request);
          if (!body.requestId || !body.answers || typeof body.answers !== "object") {
            throw new HttpError(400, "requestId and answers are required");
          }
          await hub.answer(env, thread, body.requestId, body.answers);
          send(response, 200, { ok: true });
          return;
        }
        if (request.method === "POST" && action === "interrupt") {
          const interrupted = await hub.interrupt(env, thread);
          send(response, 200, { ok: true, interrupted });
          return;
        }
      }
      throw new HttpError(404, "Not found");
    } catch (error) {
      const status = error instanceof HttpError ? error.status : error instanceof NotFoundError ? 404 : 502;
      const message = error instanceof Error ? error.message : String(error);
      if (!response.headersSent) send(response, status, { ok: false, error: message });
      else response.end();
    }
  });

  server.on("close", () => {
    clearInterval(heartbeat);
    for (const client of sseClients) client.end();
  });
  return server;
}
