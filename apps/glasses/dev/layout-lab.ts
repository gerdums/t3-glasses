// Renders a static design probe in the simulator: borders, dividers, brightness, glyphs.
import { waitForEvenAppBridge, CreateStartUpPageContainer, TextContainerProperty, ListContainerProperty, ListItemContainerProperty } from '@evenrealities/even_hub_sdk';
const bridge = await waitForEvenAppBridge();
const t = (id: number, x: number, y: number, w: number, h: number, content: string, extra: Partial<TextContainerProperty> = {}) =>
  new TextContainerProperty({ containerID: id, containerName: `t${id}`, xPosition: x, yPosition: y, width: w, height: h, content, isEventCapture: 0, zOrderIndex: id, ...extra });
await bridge.createStartUpPageContainer(new CreateStartUpPageContainer({
  containerTotalNum: 8,
  textObject: [
    t(1, 4, 4, 568, 280, ' ', { borderWidth: 2, borderColor: 12, borderRadius: 10 }),
    t(2, 20, 12, 400, 30, 'T3 Code  ● ○ ▶ › » × • · … “q” — ★ ◆ ↑ → ■'),
    t(3, 20, 46, 536, 2, ' ', { borderWidth: 1, borderColor: 6 }),
    t(4, 20, 54, 536, 60, 'Brightness 4 default. Body text sample that wraps across the width of the panel.'),
    t(5, 20, 114, 536, 30, 'Brightness 2 dim hint [Tap & hold to input]', { textColor: 2 }),
    t(6, 20, 150, 536, 120, 'Card', { borderWidth: 2, borderColor: 15, borderRadius: 8, paddingLength: 8 }),
    t(7, 300, 12, 250, 30, 'level 1 [Tap open]', { textColor: 1 }),
  ],
  listObject: [new ListContainerProperty({ containerID: 8, containerName: 'list', xPosition: 30, yPosition: 186, width: 516, height: 80, isEventCapture: 1, zOrderIndex: 8,
    itemContainer: new ListItemContainerProperty({ itemCount: 3, isItemSelectBorderEn: 1, itemName: ['Approve', 'Approve for session', 'Deny'] }) })],
}));
