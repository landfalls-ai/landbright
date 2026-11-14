/** Runs the Landbright node as Landflow does (the SDK's runNode, the same request). Used by these tests and the e2e. */
import { runNode, type ExecuteRequest, type ExecuteResponse, type JsonObject } from '@landflow/sdk';
import { plugin } from '../src/main';
import { Landbright } from '../src/nodes/landbright';

export type { ExecuteResponse, JsonObject };

export function runLandbright(
  parameters: JsonObject,
  items: JsonObject[],
  credentials: JsonObject,
  options: { continueOnFail?: boolean } = {},
): Promise<ExecuteResponse> {
  const request: ExecuteRequest = {
    protocol: 'landflow.plugin/v1',
    executionId: 'ex_test',
    workflowId: 'wf_test',
    mode: 'manual',
    node: { id: 'n1', name: 'Landbright', type: 'landbright.landbright', typeVersion: 1 },
    parameters,
    itemParameters: items.map(() => parameters),
    inputs: [items.map((json) => ({ json }))],
    credentials: { landbrightApi: credentials },
    ...(options.continueOnFail && { continueOnFail: true }),
  };
  return runNode(Landbright, request, { credentialTypes: plugin.credentialTypes, pluginId: 'landbright' });
}
