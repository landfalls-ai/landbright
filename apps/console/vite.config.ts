import { resolve } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { loadEnv } from 'vite';
import { defineConfig } from 'vitest/config';

const workspace = resolve(import.meta.dirname, '../..');

export default defineConfig(({ mode }) => {
  // Ports come from the workspace .env like every other process (LANDBRIGHT_* only; nothing reaches the bundle).
  const env = { ...loadEnv(mode, workspace, 'LANDBRIGHT_'), ...process.env };
  const consolePort = Number(env.LANDBRIGHT_CONSOLE_PORT ?? 4400);
  const control = `http://127.0.0.1:${Number(env.LANDBRIGHT_CONTROL_PORT ?? 4401)}`;
  const server = { host: '127.0.0.1', port: consolePort, strictPort: true, proxy: { '/api': control } };
  return {
    plugins: [react(), tailwindcss()],
    resolve: { alias: { '@': resolve(import.meta.dirname, 'src') } },
    server,
    preview: server,
    // One ~160 kB (gzip) bundle: React, the router, TanStack Query and the zod contracts. Route-level splitting can wait
    // until the pages are real.
    build: { chunkSizeWarningLimit: 700 },
    test: {
      environment: 'jsdom',
      setupFiles: ['./test/setup.ts'],
      include: ['test/**/*.test.{ts,tsx}'],
      css: false,
      alias: { '@landbright/contracts': resolve(workspace, 'libs/contracts/src/index.ts') },
    },
  };
});
