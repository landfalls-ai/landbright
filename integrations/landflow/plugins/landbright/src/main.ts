/**
 * landbright: Landbright's people and groups for Landflow flows (the joiner, mover and leaver flows' actions).
 *
 *   pnpm --filter @landbright/plugin-landbright start
 *
 * Serves HTTP on :7142 and gRPC on :7242, then announces both to the Landflow host (LANDFLOW_REGISTRY_URL, default
 * http://127.0.0.1:3000; the throwaway Landflow is http://localhost:57300).
 */
import { definePlugin } from '@landflow/sdk';
import { serve } from '@landflow/sdk/serve';
import { Landbright, landbrightApi } from './nodes/landbright';

export const plugin = definePlugin({
  info: {
    id: 'landbright',
    name: 'Landbright',
    version: '0.1.0',
    description:
      'Landbright, the identity provider: create or update people from HR workers, read and deactivate them, manage group members',
    icon: 'file:landbright.svg',
    color: '#C2410C',
    author: 'Landbright',
  },
  nodes: [Landbright],
  credentialTypes: [landbrightApi],
  iconDir: new URL('../icons/', import.meta.url),
});

if (import.meta.url === `file://${process.argv[1]}`) {
  await serve(plugin, {
    http: Number(process.env.LANDBRIGHT_PLUGIN_HTTP_PORT ?? 7142),
    grpc: Number(process.env.LANDBRIGHT_PLUGIN_GRPC_PORT ?? 7242),
    host: process.env.LANDFLOW_HOST ?? '127.0.0.1',
    maxConcurrency: 8,
  });
}
