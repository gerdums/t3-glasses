# t3-glasses

Your [T3 Code](https://t3.codes) threads on Even Realities G2 glasses. Sign in
once, and the glasses show the same threads your phone does, from every
computer on your T3 account: read the latest messages, approve or deny tool
requests, answer questions, interrupt runs, and reply by voice with the R1 ring
or temple touch.

> Unofficial. Not affiliated with T3 Code or Even Realities. Account sign-in
> uses T3's public web client id with the T3 Connect relay, which T3 does not
> document for third-party apps; a T3 update could break it.

```
G2 + R1  ──BLE──  Even app (phone)  ──HTTPS/tailnet──  t3-glasses bridge  ──T3 Connect──  your T3 environments
```

## What you need

- Even Realities G2 glasses (R1 ring optional), Even app 2.2.10 or later
- A computer that stays on (macOS for the login service), Node.js 22+
- [Tailscale](https://tailscale.com) on that computer and your phone
- A T3 Code account with your computers linked through T3 Connect

## Set up

```sh
git clone https://github.com/gerdums/t3-glasses && cd t3-glasses
npm install && npm run build
npm link -w @t3-glasses/bridge        # puts `t3-glasses` on your PATH

t3-glasses setup                      # email code sign-in; lists your computers
t3-glasses expose                     # HTTPS on your tailnet; prints the bridge URL
t3-glasses service install            # run the bridge at login and keep it running
```

Voice replies need speech-to-text. Local and private (macOS):

```sh
brew install whisper-cpp
mkdir -p ~/.local/share/t3-glasses/models
curl -L -o ~/.local/share/t3-glasses/models/ggml-base.en.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin
t3-glasses transcription command -- whisper-cli -m ~/.local/share/t3-glasses/models/ggml-base.en.bin -nt -np -l en -f '{wav}'
t3-glasses service restart
```

Or use OpenAI: `t3-glasses transcription openai` with `OPENAI_API_KEY` set
before `t3-glasses service install`.

## Install the glasses app

The Even app only lets a package reach origins listed in its manifest, so build
one for your bridge:

```sh
BRIDGE_URL=https://your-mac.your-tailnet.ts.net:4417 npm run pack -w @t3-glasses/glasses
```

Upload `apps/glasses/t3-glasses.ehpk` under **Private builds** in the
[Even Hub developer portal](https://hub.evenrealities.com), then install it
from the Even app. For development, see [apps/glasses/README.md](apps/glasses/README.md).

Then pair it: run `t3-glasses glasses-code`, open T3 Glasses in the Even app,
and enter the 6-digit code.

## Using it

| Gesture | Does |
|---|---|
| Scroll | Move through a list, or page through a conversation's history |
| Tap | Open the selected thread or computer; in a thread, open actions |
| Double-tap | Back (closes a card first) |
| Press and hold | In a thread, record a voice reply; release to stop |

Home lists your threads across every computer, with anything waiting for you
on top. The last row opens **Computers**, one list per machine.

Markers: `◆` needs you (approval or question) · `»` running · `×` failed ·
`•` finished · `·` idle.

## Commands

```
t3-glasses setup | status | expose | glasses-code
t3-glasses service install | uninstall | restart | status
t3-glasses transcription openai | command -- <cmd> | none
t3-glasses pair <link> | unpair <id>   # machines not on T3 Connect
t3-glasses token --rotate | logout
```

Config and secrets live in `~/.config/t3-glasses/config.json` (mode 0600).
Logs: `~/Library/Logs/t3-glasses.log`.

## Security

- The bridge holds a T3 account session and read/operate access to every
  linked environment. Anyone with the glasses token can message your threads
  and answer approvals, so keep the bridge on your tailnet only.
- Environment sessions are limited to `orchestration:read orchestration:operate`:
  no terminal, filesystem, or settings access.
- Pairing codes are single-use, expire in 10 minutes, and lock after 5 wrong tries.

## Development

```sh
npm test            # bridge and glasses unit tests
npm run typecheck
```

See [docs/architecture.md](docs/architecture.md) for the T3 protocol notes and
[docs/glasses-ux.md](docs/glasses-ux.md) for the display design.
