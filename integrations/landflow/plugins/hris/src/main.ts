/**
 * hris: HR systems for Landflow. HiBob (spec 007): a trigger for its employee events and an action that reads
 * employees. Shapes (spec 010): a trigger for its workflows' webhooks, a polling trigger for changes, and an action that
 * reads employees. All as workers, the one shape Landbright's `POST /api/v1/people` takes.
 *
 *   pnpm --filter @landbright/plugin-hris start
 *
 * Serves HTTP on :7141 and gRPC on :7241, then announces both to the Landflow host (LANDFLOW_REGISTRY_URL, default
 * http://127.0.0.1:3000; the throwaway Landflow is http://localhost:57300).
 */
import { definePlugin } from '@landflow/sdk';
import { serve } from '@landflow/sdk/serve';
import { HiBob, hibobApi } from './nodes/hibob';
import { HiBobTrigger } from './nodes/hibob-trigger';
import { Shapes, shapesApi } from './nodes/shapes';
import { ShapesChangesTrigger, ShapesTrigger } from './nodes/shapes-trigger';

export const plugin = definePlugin({
  info: {
    id: 'hris',
    name: 'HR systems',
    version: '0.1.0',
    description:
      'HiBob and Shapes for Landflow: employee events (joined, updated, left, …), changes and reads, as one worker record for Landbright',
    icon: 'file:hris.svg',
    color: '#2F6F5E',
    author: 'Landbright',
  },
  nodes: [HiBobTrigger, HiBob, ShapesTrigger, ShapesChangesTrigger, Shapes],
  credentialTypes: [hibobApi, shapesApi],
  iconDir: new URL('../icons/', import.meta.url),
});

if (import.meta.url === `file://${process.argv[1]}`) {
  await serve(plugin, {
    http: Number(process.env.HRIS_HTTP_PORT ?? 7141),
    grpc: Number(process.env.HRIS_GRPC_PORT ?? 7241),
    host: process.env.LANDFLOW_HOST ?? '127.0.0.1',
    maxConcurrency: 8,
  });
}
