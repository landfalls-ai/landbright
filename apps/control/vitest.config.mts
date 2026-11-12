import { resolve } from 'node:path';
import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

const lib = (name: string) => resolve(import.meta.dirname, `../../libs/${name}/src/index.ts`);

export default defineConfig({
  // SWC, not esbuild: Nest needs decorator metadata. Workspace libraries resolve to their source.
  plugins: [swc.vite({ module: { type: 'es6' } })],
  resolve: { alias: { '@landbright/contracts': lib('contracts'), '@landbright/platform': lib('platform') } },
  test: { include: ['test/**/*.test.ts'] },
});
