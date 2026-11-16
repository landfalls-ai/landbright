/**
 * gdirectory: Google Workspace's directory for Landflow, so Landbright's people and groups reach Google (spec 009).
 *
 *   pnpm --filter @landbright/plugin-google-directory start
 *
 * Serves HTTP on :7143 and gRPC on :7243, then announces both to the Landflow host (LANDFLOW_REGISTRY_URL, default
 * http://127.0.0.1:3000; the throwaway Landflow is http://localhost:57300).
 */
import { definePlugin } from '@landflow/sdk';
import { serve } from '@landflow/sdk/serve';
import { GoogleDirectory, googleDirectoryApi } from './nodes/google-directory';

export const plugin = definePlugin({
  info: {
    id: 'gdirectory',
    name: 'Google Directory',
    version: '0.1.0',
    description:
      "Google Workspace's users and group members: create or update accounts from Landbright's people, suspend and sign out leavers, set groups",
    icon: 'file:gdirectory.svg',
    color: '#1A73E8',
    author: 'Landbright',
  },
  nodes: [GoogleDirectory],
  credentialTypes: [googleDirectoryApi],
  iconDir: new URL('../icons/', import.meta.url),
});

if (import.meta.url === `file://${process.argv[1]}`) {
  await serve(plugin, {
    http: Number(process.env.GDIRECTORY_HTTP_PORT ?? 7143),
    grpc: Number(process.env.GDIRECTORY_GRPC_PORT ?? 7243),
    host: process.env.LANDFLOW_HOST ?? '127.0.0.1',
    maxConcurrency: 8,
  });
}
