/** Request builders for the hris plugin's tests. Fake secrets only; nothing here talks to a real service. */
import {
  runNode,
  runTestCredentials,
  runWebhook,
  runWebhookMethod,
  type ExecuteRequest,
  type ExecuteResponse,
  type INodeType,
  type JsonObject,
} from '@landflow/sdk';
import { bobSignature } from '../src/hibob';
import { plugin } from '../src/main';
import { SEED, type FakeHiBob } from './fake-hibob';

const extras = { credentialTypes: plugin.credentialTypes, pluginId: 'hris' };
const NODE = (type: string) => ({ id: 'n1', name: 'Node', type: `hris.${type}`, typeVersion: 1 });
export const WEBHOOK_URL = 'http://localhost:57300/api/webhook/app/wf_test/n1';

export const credentials = (fake: FakeHiBob, overrides: JsonObject = {}): Record<string, JsonObject> => ({
  hibobApi: {
    baseUrl: fake.baseUrl,
    serviceUserId: SEED.serviceUserId,
    token: SEED.token,
    webhookSecret: SEED.webhookSecret,
    ...overrides,
  },
});

export function run(
  node: INodeType,
  parameters: JsonObject,
  options: { credentials?: Record<string, JsonObject>; items?: JsonObject[]; continueOnFail?: boolean } = {},
): Promise<ExecuteResponse> {
  const items = options.items ?? [{}];
  const request: ExecuteRequest = {
    protocol: 'landflow.plugin/v1',
    executionId: 'ex_test',
    workflowId: 'wf_test',
    mode: 'manual',
    node: NODE(node.description.name),
    parameters,
    itemParameters: items.map(() => parameters),
    inputs: [items.map((json) => ({ json }))],
    ...(options.credentials && { credentials: options.credentials }),
    ...(options.continueOnFail && { continueOnFail: true }),
  };
  return runNode(node, request, extras);
}

export const jsonOf = (response: ExecuteResponse) => response.outputs[0].map((item) => item.json);

export function method(
  node: INodeType,
  name: 'checkExists' | 'create' | 'delete',
  parameters: JsonObject,
  creds: Record<string, JsonObject>,
  staticData: JsonObject = {},
) {
  return runWebhookMethod(
    node,
    {
      protocol: 'landflow.plugin/v1',
      method: name,
      workflowId: 'wf_test',
      node: NODE(node.description.name),
      parameters,
      credentials: creds,
      webhookUrl: WEBHOOK_URL,
      staticData,
    },
    extras,
  );
}

/** A call to the trigger's webhook: `signature` true signs with the fake secret, a string is sent as is, false sends none. */
export function call(
  node: INodeType,
  parameters: JsonObject,
  creds: Record<string, JsonObject>,
  body: string | Record<string, unknown>,
  signature: boolean | string = true,
) {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  const headers: Record<string, string> = {
    'content-type': typeof body === 'string' ? 'text/plain' : 'application/json',
  };
  if (signature === true) headers['bob-signature'] = bobSignature(SEED.webhookSecret, raw);
  else if (typeof signature === 'string') headers['bob-signature'] = signature;
  return runWebhook(
    node,
    {
      protocol: 'landflow.plugin/v1',
      workflowId: 'wf_test',
      node: NODE(node.description.name),
      parameters,
      credentials: creds,
      webhookUrl: WEBHOOK_URL,
      staticData: {},
      request: {
        method: 'POST',
        path: '/api/webhook/app/wf_test/n1',
        headers,
        query: {},
        body: Buffer.from(raw).toString('base64'),
      },
    },
    extras,
  );
}

export const testCredentials = (data: JsonObject) => runTestCredentials(plugin, { credentialType: 'hibobApi', data });
