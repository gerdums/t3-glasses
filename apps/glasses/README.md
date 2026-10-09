# T3 Glasses Even Hub app

## Local development

Build the workspace protocol once: `npm run build -w @t3-glasses/protocol` from the repo root. In separate terminals run `node apps/glasses/dev/mock-bridge.mjs`, `VITE_BRIDGE_URL=http://localhost:8787 npm run dev -w @t3-glasses/glasses`, and `evenhub-simulator http://localhost:5173`. The mock serves two environments and approval, question, and running threads. It accepts action requests without changing its sample data. The simulator's Context Menu input can open the native menu.

## Phone development

Run the Vite server on an address the phone can reach, then run `evenhub qr --url http://YOUR-LAN-IP:5173` and scan in the Even app's developer mode. Set the bridge URL and glasses token in the phone WebView form. The phone needs an HTTPS path to a real bridge; `localhost` on the phone is the phone itself. Build-time defaults can be supplied with `VITE_BRIDGE_URL` and `VITE_BRIDGE_TOKEN`. Settings persist through the Even bridge local storage.

## Private package

Set `app.json`'s network whitelist origin to the exact HTTPS origin of your private bridge before packing. The placeholder `https://your-bridge.example.ts.net` is not a usable origin. Run `npm run build -w @t3-glasses/glasses`, then `npx evenhub pack apps/glasses/app.json apps/glasses/dist -o /tmp/t3g.ehpk`. Do not embed a live token in a distributable build. Publishing and device upload require the owner's release process.

On the glasses, Click on a thread opens an Actions list. The same actions are attached as a native contextual menu, which is opened by the host's context-menu gesture; the SDK exposes menu selection events but no method for the app to open that menu. Double-click goes back. Long-press in a thread records speech; release transcribes it. The simulator is useful for layout, but microphone timing, menu gesture, text scrolling, and all interactive flows need device proof.
