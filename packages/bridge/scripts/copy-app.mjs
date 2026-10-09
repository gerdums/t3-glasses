// Bundles the glasses web app into the bridge so it can serve it directly.
import { cpSync, existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const from = resolve(import.meta.dirname, '../../../apps/glasses/dist');
const to = resolve(import.meta.dirname, '../dist/app');
rmSync(to, { recursive: true, force: true });
if (existsSync(from)) {
  cpSync(from, to, { recursive: true });
  console.log('Bundled glasses app into dist/app');
} else {
  console.warn('apps/glasses/dist not found; build the glasses app first to serve it from the bridge.');
}
