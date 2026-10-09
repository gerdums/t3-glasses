# Glasses UX

The design follows Even Terminal, Even's own agent view for the G2: one rounded
panel, a title row, hairline dividers, and a footer with status on the left and
a dim bracketed hint on the right. Choices appear in an inset card with the
firmware's native list selection box.

```
╭──────────────────────────────────────────────╮
│ Fix the flaky login test          M4 Studio  │  title · meta (dim)
│ ──────────────────────────────────────────── │
│ › Please fix the flaky login test.           │  conversation, newest
│ Looking at it now...                         │  page visible first
│ ──────────────────────────────────────────── │
│ ◆ Needs approval              [Tap respond]  │  status · hint (dim)
╰──────────────────────────────────────────────╯
```

## Screens

1. **Home**: every computer's threads, attention first (approvals and
   questions, then running, failed, finished, idle), then a final
   `› Computers` row. Title meta shows the thread count.
2. **Computers**: one row per machine with its counts, or `offline`.
3. **Threads**: one computer's threads.
4. **Thread**: the conversation as prose (Markdown stripped), user turns
   marked `›`. Scrolling past either end pages through older history; the
   footer shows the live activity line while the agent works.
5. **Cards** over a thread:
   - actions: an approval's prompt and its provider options, a question and
     its choices plus `Speak an answer`, then `Reply by voice`, `Interrupt`
     (while running), `Back`
   - voice: `Listening… release to stop`, then the quoted transcript with
     `Send` / `Cancel`
   - notice: `• Approved`, `• Sent`, or an error, for 1.6 s

## Input

| Gesture | Lists | Thread | Card |
|---|---|---|---|
| Scroll | move selection | page history | move selection |
| Tap | open | open actions | choose |
| Double-tap | back | back to list | close card |
| Hold / release | | record / transcribe | |

The same actions are also registered as the native context menu.

## Vocabulary

`◆` needs you · `»` running · `×` failed · `•` finished · `·` idle · `›` user
turn or drill-in. Only glyphs present in the firmware font are used
(`@evenrealities/pretext` reports zero width for missing ones).

## Refresh

The app polls the current screen every 3 s in the foreground and pauses on
`FOREGROUND_EXIT`. When only text changed it uses `textContainerUpgrade`, so
updates don't flicker; layout changes rebuild the page.

## Phone page

The WebView page on the phone uses the Even app's dark design tokens: bridge
address (baked into private builds) and a 6-digit pairing code. The raw glasses
token sits under Advanced.
