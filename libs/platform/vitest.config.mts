import { resolve } from 'node:path';
import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // SWC, not esbuild: Nest needs decorator metadata.
  plugins: [swc.vite({ module: { type: 'es6' } })],
  resolve: { alias: { '@landbright/contracts': resolve(import.meta.dirname, '../contracts/src/index.ts') } },
  test: { include: ['test/**/*.test.ts'] },
});
