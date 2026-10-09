#!/usr/bin/env node
// Builds a private .ehpk for one bridge: the Even app only lets the package
// reach origins listed in its manifest, so the bridge origin is baked in.
// Usage: BRIDGE_URL=https://your-mac.tailnet.ts.net:4417 npm run pack
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const app = resolve(import.meta.dirname, '..');
const raw = process.env.BRIDGE_URL ?? process.argv[2];
if (!raw) {
  console.error('Set BRIDGE_URL to your bridge address (t3-glasses expose prints it).');
  process.exit(1);
}
const origin = new URL(raw).origin;
const manifest = JSON.parse(readFileSync(join(app, 'app.json'), 'utf8'));
for (const permission of manifest.permissions) {
  if (permission.name === 'network') permission.whitelist = [origin];
}

const work = mkdtempSync(join(tmpdir(), 't3-glasses-pack-'));
try {
  writeFileSync(join(work, 'app.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  const env = { ...process.env, VITE_BRIDGE_URL: origin, VITE_BRIDGE_TOKEN: '' };
  execFileSync('npx', ['vite', 'build'], { cwd: app, env, stdio: 'inherit' });
  const output = join(app, 't3-glasses.ehpk');
  execFileSync('npx', ['evenhub', 'pack', join(work, 'app.json'), join(app, 'dist'), '-o', output], { cwd: app, stdio: 'inherit' });
  console.log(`\nBuilt ${output} for ${origin}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
