import { defineConfig } from 'vite';

// Relative asset paths: the bridge serves this build from its own root.
export default defineConfig({ base: './', build: { outDir: 'dist' }, test: { environment: 'node' } });
