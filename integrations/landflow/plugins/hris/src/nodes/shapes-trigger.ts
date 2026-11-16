import {
  defineNode,
  NodeOperationError,
  type IWebhookContext,
  type IWebhookMethodContext,
  type JsonObject,
} from '@landflow/sdk';
import {
  changedSince,
  ShapesError,
  verifyShapesSignature,
  whoAmI,
  workersByIds,
  type ShapesCredentials,
} from '../shapes';
import { COLOR } from './hibob';

/** A delivery whose signed `timestamp` is older (or further ahead) than this is refused: Shapes signs the body only. */
export const MAX_AGE_MS = 5 * 60_000;

const NOTICE =
  "Shapes sends webhooks from its workflows, not from a subscription. Publish this workflow, copy this node's URL from the editor's Publish menu (App webhooks), " +
  'and in Shapes add a workflow (triggered by Employee created, or Employee field value changed on start date, termination date, department, job, office or manager) ' +
  'with a Send webhook action to that URL and a secret; put the same secret in the Shapes credential. Every delivery without a valid X-Webhook-Signature is refused. ' +
  'Shapes tries a delivery once: pair this with the Shapes Changes Trigger, which catches what a lost delivery missed.';

interface TriggerStatic extends JsonObject {
  url: string;
}

const isObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const credentialsOf = (ctx: IWebhookContext | IWebhookMethodContext) =>
  ctx.getCredentials<ShapesCredentials>('shapesApi');

/** The field contexts a delivery carried: what changed, as far as the workflow's action says. */
function contextsOf(employee: JsonObject): string[] {
  const values = Array.isArray(employee.employeeFieldValues) ? employee.employeeFieldValues : [];
  const out = new Set<string>();
  for (const v of values) {
    const type = isObject(v) && isObject(v.employeeFieldType) ? v.employeeFieldType : undefined;
    if (type && typeof type.context === 'string') out.add(type.context);
  }
  return [...out];
}

export const ShapesTrigger = defineNode({
  description: {
    name: 'shapesTrigger',
    displayName: 'Shapes Trigger',
    description:
      'Starts the workflow when a Shapes workflow sends its webhook (an employee created, a start or termination date, department, job, office or manager changed), with the employee as a worker',
    version: 1,
    kind: 'trigger',
    triggerSource: 'appWebhook',
    categories: ['HR'],
    icon: 'file:hris-trigger.svg',
    color: COLOR,
    documentationUrl: 'https://help.shapes.co/en/articles/12719797-workflow-webhooks',
    keywords: ['shapes', 'dreamteam', 'hr', 'hris', 'joiner', 'mover', 'leaver', 'webhook'],
    inputs: [],
    outputs: [{ type: 'main' }],
    credentials: [{ name: 'shapesApi', required: true }],
    properties: [
      { name: 'notice', displayName: NOTICE, type: 'notice', default: '' },
      {
        name: 'fetchEmployee',
        displayName: 'Fetch Employee',
        type: 'boolean',
        default: true,
        description:
          'Whether to read the employee from Shapes and output them as a worker (a delivery carries only the fields its action names). Off: the item has the delivery and the id',
      },
    ],
  },
  execute(ctx) {
    ctx.logger.info('Shapes sends webhooks to the published workflow; a manual run has no delivery to output');
    return [];
  },
  webhookMethods: {
    checkExists(ctx) {
      const data = ctx.getStaticData<TriggerStatic>();
      return Boolean(data.url) && data.url === ctx.getWebhookUrl();
    },
    async create(ctx) {
      const credentials = credentialsOf(ctx);
      if (!String(credentials.webhookSecret ?? '').trim()) {
        throw new NodeOperationError('The Shapes credential has no Webhook Secret', {
          description:
            "Set a secret on the Send webhook action in Shapes and copy it into the credential: Landflow checks every delivery's X-Webhook-Signature with it.",
        });
      }
      // A refused token fails the publish, not the first delivery.
      await ctx.span('shapes.me', {}, () => whoAmI({ http: ctx.http }, credentials));
      ctx.setStaticData({ url: ctx.getWebhookUrl() } satisfies TriggerStatic);
      ctx.logger.info("Shapes Trigger ready: paste the URL into the Shapes workflow's Send webhook action", {
        url: ctx.getWebhookUrl(),
      });
      return true;
    },
    delete(ctx) {
      ctx.setStaticData({});
      return true;
    },
  },
  async webhook(ctx) {
    const raw = ctx.getRawBody();
    const answer = (status: number, json: JsonObject) => ({ response: { status, json } });
    const credentials = credentialsOf(ctx);
    const secret = String(credentials.webhookSecret ?? '').trim();
    if (!verifyShapesSignature(secret, raw, ctx.getHeader('x-webhook-signature'))) {
      ctx.logger.warn(
        secret
          ? 'rejected a delivery with a missing or invalid X-Webhook-Signature'
          : 'rejected a delivery: the Shapes credential has no Webhook Secret',
      );
      return answer(401, { error: 'invalid signature' });
    }
    let body: unknown;
    try {
      body = ctx.getBody();
    } catch {
      body = undefined;
    }
    if (!isObject(body) || !isObject(body.employee)) return answer(400, { error: 'not a Shapes workflow webhook' });
    // The signature covers the body, and the body its timestamp: an old delivery replayed is refused.
    const sent = Number(body.timestamp);
    if (!Number.isFinite(sent) || Math.abs(Date.now() - sent) > MAX_AGE_MS) {
      ctx.logger.warn('rejected a delivery whose timestamp is more than five minutes away');
      return answer(401, { error: 'stale delivery' });
    }
    const employeeId = String(body.employee.id ?? '').trim();
    if (!employeeId) return answer(400, { error: 'the delivery names no employee' });

    const definition = isObject(body.definition) ? body.definition : {};
    const run = isObject(body.run) ? body.run : {};
    const action = isObject(body.action) ? body.action : {};
    const event: JsonObject = {
      event: 'shapes.workflow',
      workflow: typeof definition.name === 'string' ? definition.name : null,
      changedFields: contextsOf(body.employee),
      triggeredAt: new Date(sent).toISOString(),
    };
    let item: JsonObject = { source: 'shapes', sourceId: employeeId, ...event };
    if (ctx.getNodeParameter<boolean>('fetchEmployee', true) !== false) {
      try {
        const [worker] = await ctx.span('shapes.employees.get', { 'shapes.employee.id': employeeId }, () =>
          workersByIds({ http: ctx.http }, credentials, [employeeId]),
        );
        if (!worker) ctx.logger.warn(`Shapes has no employee ${employeeId}; the item carries only the delivery`);
        else item = { ...worker, ...event };
      } catch (error) {
        // Shapes doesn't retry; a 503 marks the workflow step failed in Shapes' activity, and the Shapes Changes
        // Trigger picks the change up at its next poll. A run without the employee could clear their fields.
        const status = error instanceof ShapesError ? error.status : 0;
        ctx.logger.error(`could not read employee ${employeeId} from Shapes: ${(error as Error).message}`);
        return answer(503, { error: 'could not read the employee from Shapes', status });
      }
    }
    // X-Webhook-Id names the run and step: the same delivery twice starts one run.
    const id = ctx.getHeader('x-webhook-id') ?? `${String(run.id ?? '')}:${String(action.id ?? '')}`;
    return { items: [item], idempotencyKey: `shapes:${id}:${employeeId}` };
  },
});

/** Overlap between polls: Shapes advises starting a few minutes before the last run began. */
export const OVERLAP_MS = 5 * 60_000;

interface PollState extends JsonObject {
  since: string;
}

/**
 * Polls Shapes for employees whose worker fields changed since the last poll (Shapes advises every 15 minutes or less
 * often): the safety net under the webhook, which Shapes tries once. An employee may come twice (the overlap); the
 * Landbright upsert is idempotent.
 */
export const ShapesChangesTrigger = defineNode({
  description: {
    name: 'shapesChangesTrigger',
    displayName: 'Shapes Changes Trigger',
    description:
      'Every 15 minutes (by default), the employees whose names, email, department, job, office, manager or dates changed in Shapes, as workers',
    version: 1,
    kind: 'trigger',
    triggerSource: 'poll',
    categories: ['HR'],
    icon: 'file:hris-trigger.svg',
    color: COLOR,
    keywords: ['shapes', 'dreamteam', 'hr', 'hris', 'poll', 'changes', 'sync'],
    inputs: [],
    outputs: [{ type: 'main' }],
    credentials: [{ name: 'shapesApi', required: true }],
    properties: [
      {
        name: 'pollInterval',
        displayName: 'Poll Every (seconds)',
        type: 'number',
        default: 900,
        typeOptions: { minValue: 300 },
        description: 'Shapes asks for no more than every 15 minutes (900 s)',
      },
    ],
  },
  async execute(ctx) {
    const credentials = ctx.getCredentials<ShapesCredentials>('shapesApi');
    const api = { http: ctx.http, ...(ctx.signal && { signal: ctx.signal }) };
    const startedAt = new Date();
    if (ctx.getMode() === 'manual') {
      // Building the flow: the few most recent changes of the last week, whatever the state.
      const ids = await changedSince(api, credentials, new Date(startedAt.getTime() - 7 * 86_400_000).toISOString());
      const workers = ids.length ? await workersByIds(api, credentials, ids.slice(-3)) : [];
      return workers.map((w) => ({ json: { ...w, event: 'shapes.changed' } }));
    }
    const state = ctx.getPollState<PollState>();
    const next: PollState = { since: new Date(startedAt.getTime() - OVERLAP_MS).toISOString() };
    if (ctx.isFirstPoll() || !state?.since) {
      ctx.setPollState(next);
      return [];
    }
    const ids = await changedSince(api, credentials, state.since);
    const workers = ids.length ? await workersByIds(api, credentials, ids) : [];
    ctx.setPollState(next);
    return workers.map((w) => ({ json: { ...w, event: 'shapes.changed', changedSince: state.since } }));
  },
});
