/** Runs the Landbright node and trigger as Landflow does (the SDK's runNode and runWebhook). Used by these tests and the e2e. */
import {
  runNode,
  runWebhook,
  runWebhookMethod,
  type ExecuteRequest,
  type ExecuteResponse,
  type JsonObject,
  type WebhookMethodResponse,
  type WebhookResponse,
} from '@landflow/sdk';
import { plugin } from '../src/main';
import { Landbright } from '../src/nodes/landbright';
import { LandbrightTrigger } from '../src/nodes/landbright-trigger';

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

/** The Landbright Trigger's publish-time methods, as Landflow calls them. */
export function runTriggerMethod(
  name: 'checkExists' | 'create' | 'delete',
  parameters: JsonObject,
  credentials: JsonObject,
  webhookUrl: string,
  staticData: JsonObject = {},
): Promise<WebhookMethodResponse> {
  return runWebhookMethod(
    LandbrightTrigger,
    {
      protocol: 'landflow.plugin/v1',
      method: name,
      workflowId: 'wf_test',
      node: TRIGGER,
      parameters,
      credentials: { landbrightApi: credentials },
      webhookUrl,
      staticData,
    },
    { credentialTypes: plugin.credentialTypes, pluginId: 'landbright' },
  );
}

/** A delivery to the Landbright Trigger, as Landflow hands it over: the headers and the body as received. */
export function runTriggerWebhook(
  parameters: JsonObject,
  credentials: JsonObject,
  webhookUrl: string,
  staticData: JsonObject,
  headers: Record<string, string>,
  rawBody: Buffer,
): Promise<WebhookResponse> {
  return runWebhook(
    LandbrightTrigger,
    {
      protocol: 'landflow.plugin/v1',
      workflowId: 'wf_test',
      node: TRIGGER,
      parameters,
      credentials: { landbrightApi: credentials },
      webhookUrl,
      staticData,
      request: {
        method: 'POST',
        path: new URL(webhookUrl).pathname,
        headers,
        query: {},
        body: rawBody.toString('base64'),
      },
    },
    { credentialTypes: plugin.credentialTypes, pluginId: 'landbright' },
  );
}

const TRIGGER = { id: 'n1', name: 'Landbright Trigger', type: 'landbright.landbrightTrigger', typeVersion: 1 };
