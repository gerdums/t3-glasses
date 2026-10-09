# T3 Glasses: Even Hub app

A Vite web app that runs in the Even app's WebView on the phone and draws on
the G2 display. See [../../docs/glasses-ux.md](../../docs/glasses-ux.md) for the
design.

## Develop against the mock bridge

```sh
npm run build -w @t3-glasses/protocol          # once, from the repo root
node apps/glasses/dev/mock-bridge.mjs           # sample computers and threads on :8787
VITE_BRIDGE_URL=http://localhost:8787 VITE_BRIDGE_TOKEN=dev npm run dev -w @t3-glasses/glasses
npx evenhub-simulator http://localhost:5173 --automation-port 9898
```

Drive the simulator with `POST /api/input {"action":"click"|"down"|"double_click"|...}`
and capture the display with `GET /api/screenshot/glasses`.

`dev/layout-lab.html` renders a static probe of borders, dividers, brightness
levels, and glyphs.

## Run on your glasses during development

Enable developer mode in the Even app (Hardware → Developer Mode), run the
dev server on an address your phone can reach, and scan:

```sh
npm run dev -w @t3-glasses/glasses              # binds 0.0.0.0:5173
npx evenhub qr --url http://<your computer's tailnet name>:5173
```

## Private build

```sh
BRIDGE_URL=https://your-mac.your-tailnet.ts.net:4417 npm run pack -w @t3-glasses/glasses
```

This writes `t3-glasses.ehpk` with your bridge origin in the manifest's network
whitelist and the address pre-filled. The glasses token is never baked in; pair
with a code from `t3-glasses glasses-code`.

## Firmware limits worth knowing

- 8 text/list containers per page; text over 999 bytes and list items over 63
  bytes are rejected. Both limits are UTF-8 bytes.
- Containers have no fill, so overlapping text shows through. Cards clip the
  body instead of covering it.
- A click arrives with no `eventType` (protobuf omits zero); a tap on a text
  container arrives as a `sysEvent`.
- `@evenrealities/pretext` reports a glyph advance of 0 for characters the
  firmware font lacks; `sanitize()` maps or drops them.
