import { describe, expect, it } from "vitest";
import { RpcClient, type SocketLike } from "../src/rpc.js";

class FakeSocket implements SocketLike {
  readyState = 0;
  sent: Record<string, unknown>[] = [];
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close(code = 1000, reason = "") {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
  receive(frame: unknown) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}

async function connected() {
  const socket = new FakeSocket();
  const client = new RpcClient(() => socket);
  const opening = client.connect("ws://test");
  socket.open();
  await opening;
  return { socket, client };
}

describe("RpcClient", () => {
  it("frames requests and resolves on a successful exit", async () => {
    const { socket, client } = await connected();
    const result = client.request("orchestration.getThreadProjection", { threadId: "t" });
    expect(socket.sent[0]).toEqual({ _tag: "Request", id: "1", tag: "orchestration.getThreadProjection", payload: { threadId: "t" }, headers: [] });
    socket.receive({ _tag: "Exit", requestId: "1", exit: { _tag: "Success", value: { ok: 1 } } });
    await expect(result).resolves.toEqual({ ok: 1 });
  });

  it("acknowledges stream chunks and delivers each value", async () => {
    const { socket, client } = await connected();
    const values: unknown[] = [];
    const stream = client.stream("orchestration.subscribeShell", {}, (value) => values.push(value));
    socket.receive({ _tag: "Chunk", requestId: "1", values: [{ kind: "snapshot" }, { kind: "synchronized" }] });
    expect(values).toEqual([{ kind: "snapshot" }, { kind: "synchronized" }]);
    expect(socket.sent.at(-1)).toEqual({ _tag: "Ack", requestId: "1" });
    socket.receive({ _tag: "Exit", requestId: "1", exit: { _tag: "Success", value: null } });
    await expect(stream.done).resolves.toBeUndefined();
  });

  it("rejects with the server's error message and answers pings", async () => {
    const { socket, client } = await connected();
    const result = client.request("orchestration.dispatchCommand", {});
    socket.receive([
      { _tag: "Ping" },
      { _tag: "Exit", requestId: "1", exit: { _tag: "Failure", cause: [{ _tag: "Fail", error: { _tag: "NotFound", message: "no such thread" } }] } },
    ]);
    await expect(result).rejects.toThrow("NotFound: no such thread");
    expect(socket.sent).toContainEqual({ _tag: "Pong" });
  });

  it("fails pending requests when the socket closes", async () => {
    const { socket, client } = await connected();
    const result = client.request("x", {});
    socket.close(1006, "gone");
    await expect(result).rejects.toThrow("socket closed (1006: gone)");
    expect(client.isOpen).toBe(false);
  });
});
