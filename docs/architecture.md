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

The bridge signs in to your T3 account once and sees the same environments as
the T3 phone app:

1. `t3-glasses setup` signs in through Clerk's Frontend API in native mode
   (email code) and keeps its own Clerk client, separate from your devices.
2. For each request it mints a Clerk session JWT from the `t3-relay` template
   and lists environments at `GET https://relay.t3.codes/v1/environments`.
3. It exchanges the JWT for a DPoP-bound relay token
   (`POST /v1/client/dpop-token`, `client_id=t3-web`, 30 min), asks the relay
   for a single-use bootstrap credential per environment
   (`POST /v1/environments/:id/connect`), and trades that at the environment's
   `/oauth/token` for a 1 h DPoP session scoped to
   `orchestration:read orchestration:operate`.
4. Every environment request carries `Authorization: DPoP <token>` and a fresh
   ES256 proof (`htm`, `htu`, `ath`). Sessions renew by repeating the chain.

Machines not linked through T3 Connect can still be paired directly with a
pairing link (`t3-glasses pair`), which yields a 30-day bearer session.

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

- The T3 sign-in, DPoP key, session tokens, and glasses token live in the
  bridge config file with mode 0600. Only the glasses token reaches the phone,
  delivered by a single-use 6-digit pairing code.
- Only expose the bridge over HTTPS on a private network such as your tailnet.
- The bridge holds `orchestration:operate` on each paired environment: anyone
  with the glasses token can message threads and answer approvals. Rotate it
  with `t3-glasses token --rotate`.
