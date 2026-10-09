# Glasses UX

Display: 576×288, monochrome green, one firmware font (not monospaced,
unsupported glyphs are dropped, so stick to ASCII). Input: ring or either
temple: click, double-click, scroll up/down, long-press/release.

Global conventions

- Scroll moves the list highlight or scrolls text.
- Click selects or opens the action menu.
- Double-click goes back one screen. On Home it does nothing.
- Long-press anywhere in a thread starts voice capture; release stops it.

Attention markers (ASCII, prefixed to list rows)

| Marker | Meaning |
|---|---|
| `[!]` | approval waiting |
| `[?]` | question waiting |
| `[x]` | failed |
| `[>]` | running |
| `[.]` | done, unsettled |
| (none) | idle |

## Screens

1. **Home**: list. First row `Inbox (N)` = all environments' threads that need
   attention. Then one row per environment: `[!2 ?1 >3] M4 Studio` or
   `(offline) M1 Worker`. A one-line status text at the bottom shows bridge
   connection state.
2. **Threads**: list of up to 20 threads, attention-sorted:
   `[!] project: title`. Click opens the thread.
3. **Thread**: top text container (event-capturing, scrollable) shows the
   latest messages, newest at the bottom, as `> user text` and plain assistant
   text, plus the current activity line while running. A bottom status line
   shows `status · env`. Click opens the action menu.
4. **Action menu** (context menu, max 10 items, 32 bytes each), contents depend
   on state:
   - pending approval: `Approve`, `Approve for session`, `Deny` (only the
     options the request advertises), then `Show request`
   - pending question: one item per option label of the first question
     (truncated), plus `Dictate answer`
   - always: `Reply by voice`, `Interrupt` (when running), `Refresh`, `Back`
5. **Voice**: while recording show `Listening... release to stop`. After
   transcription show the text with `Click: send  Double: cancel`.
6. **Confirm**: after an action show `Sent` / `Approved` / error text briefly,
   then return to the thread.

## Refresh

Poll the current screen every 3 s while in foreground (or use `/api/events`).
Use `textContainerUpgrade` for in-place text changes; rebuild the page only
when the layout changes. Pause polling on `FOREGROUND_EXIT_EVENT`.

## Phone-side settings

The WebView page itself (visible in the Even app on the phone) shows a small
settings form: bridge URL and glasses token, saved with
`bridge.setLocalStorage`. Build-time defaults come from `VITE_BRIDGE_URL` and
`VITE_BRIDGE_TOKEN`.
