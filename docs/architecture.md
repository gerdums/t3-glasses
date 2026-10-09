# Architecture

```
 G2 glasses + R1 ring
        │ BLE (Even app)
        ▼
 Even app WebView ── apps/glasses (Even Hub app, TypeScript)
        │ HTTPS (Tailscale Serve or another HTTPS route), bearer token
        ▼
 packages/bridge (Node, runs on one of your computers)
        │ one paired session per T3 environment
        ├── HTTP  GET /api/orchestration/shell, /api/orchestration/threads/:id
        └── WS    /ws  Effect RPC: subscribeShell, getThreadProjection, dispatchCommand
        ▼
 T3 Code environments (local, LAN, Tailscale, or T3 Connect addresses)
```

## Why a bridge

The glasses app runs in a phone WebView with a strict network whitelist and a
tiny display. The bridge keeps one live subscription per T3 environment, merges
all environments into one attention-sorted inbox, trims payloads to what fits
on a 576×288 display, and turns microphone PCM into text.

## Reaching your environments

T3 Code's mobile app lists environments through T3 Connect with a first-party
sign-in that third-party clients cannot use. The bridge instead pairs once with
each environment, the same way any other T3 client does:

1. In T3 Code, open **Settings → Connections** for the environment and create a
   pairing link (or run `t3 auth pairing create` on that host).
2. Run `t3-glasses pair '<pairing link>'` on the bridge computer.
3. The bridge exchanges the one-time pairing token at `<env>/oauth/token` for a
   30-day bearer session scoped to `orchestration:read orchestration:operate`.

The session works over whatever address the link uses: `localhost`, LAN,
Tailscale, or the environment's T3 Connect hostname. Re-pair before it expires.

## T3 protocol notes

Verified against T3 Code server 0.0.46 (orchestration protocol 2).

- HTTP reads need `Authorization: Bearer <token>` and
  `x-t3-orchestration-protocol: 2`.
- WebSocket: `POST /api/auth/websocket-ticket` → `{ticket}`, then connect to
  `/ws?orchestrationProtocol=2&clientSurface=mobile&wsTicket=<ticket>`.
- Frames are JSON Effect RPC messages:
  - request: `{"_tag":"Request","id":"1","tag":"<method>","payload":{…},"headers":[]}`
  - stream chunk: `{"_tag":"Chunk","requestId":"1","values":[…]}` → reply `{"_tag":"Ack","requestId":"1"}`
  - completion: `{"_tag":"Exit","requestId":"1","exit":{"_tag":"Success","value":…}}`
    or `{"_tag":"Failure","cause":[…]}`
  - keepalive: `Ping` → `Pong`
- Commands go through `orchestration.dispatchCommand`:
  - `message.dispatch` with `createdBy:"user"`, `creationSource:"mobile"`,
    `dispatchMode:{type:"start_immediately"}`, `deliveryIntent:"auto"`
  - `runtime-request.respond` with `decision` (approvals) or `answers`
    (questions, keyed by question id, value = chosen label)
  - `run.interrupt` with the active `runId`

## Security

- T3 session tokens and the glasses token live in the bridge config file with
  mode 0600. They never reach the glasses app beyond the glasses token.
- Only expose the bridge over HTTPS on a private network such as your tailnet.
- The bridge holds `orchestration:operate` on each paired environment: anyone
  with the glasses token can message threads and answer approvals. Rotate it
  with `t3-glasses token --rotate`.
