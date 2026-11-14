import {
  defineNode,
  NodeOperationError,
  type IWebhookContext,
  type IWebhookMethodContext,
  type JsonObject,
} from '@landflow/sdk';
import { checkCredentials, getEmployee, HiBobError, verifyBobSignature, type HiBobCredentials } from '../hibob';
import { changedFields, workerFromHiBob } from '../worker';
import { COLOR } from './hibob';

/** HiBob's v2 employee events (apidocs.hibob.com, "Employee events v2"). */
export const EVENTS = [
  {
    name: 'Employee Created',
    value: 'employee.created',
    description: 'A new employee record, usually before their start date',
  },
  {
    name: 'Employee Joined',
    value: 'employee.joined',
    description: "Their start date came (Bob sends it at midnight in their site's time zone)",
  },
  {
    name: 'Employee Updated',
    value: 'employee.updated',
    description: 'Fields changed: department, title, manager, site, …',
  },
  { name: 'Employee Left', value: 'employee.left', description: 'Their last day passed' },
  { name: 'Employee Inactivated', value: 'employee.inactivated' },
  { name: 'Employee Activated', value: 'employee.activated' },
  { name: 'Employee Deleted', value: 'employee.deleted' },
  { name: 'Employee Temporary Leave', value: 'employee.temporaryLeave' },
  {
    name: 'Access Revoked Immediately',
    value: 'employee.access.revoked.immediately',
    description: 'Remove their access now, not at the end of their last day',
  },
];

export const DEFAULT_EVENTS = [
  'employee.created',
  'employee.joined',
  'employee.updated',
  'employee.left',
  'employee.inactivated',
  'employee.access.revoked.immediately',
];

/** Events about an employee who may no longer be readable. */
const NO_FETCH = new Set(['employee.deleted']);

const NOTICE =
  "HiBob has no API to register a webhook. Publish the workflow, copy this node's URL from the editor's Publish menu (App webhooks) into Bob " +
  "(Settings → Integrations → Automation → Webhooks, events version 2), choose the same events, and put the webhook's secret in the HiBob credential: " +
  'every delivery without a valid Bob-Signature is refused.';

interface TriggerStatic extends JsonObject {
  url: string;
}

const isObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Bob's "Test" button sends `Ping test`, as text or as `{ "text": "Ping test" }`. */
export function isPing(raw: Buffer, body: unknown): boolean {
  if (raw.toString('utf8').trim() === 'Ping test') return true;
  return isObject(body) && body.text === 'Ping test' && !('type' in body);
}

const credentialsOf = (ctx: IWebhookContext | IWebhookMethodContext) =>
  ctx.getCredentials<HiBobCredentials>('hibobApi');

export const HiBobTrigger = defineNode({
  description: {
    name: 'hibobTrigger',
    displayName: 'HiBob Trigger',
    description:
      'Starts the workflow when HiBob sends an employee event (joined, updated, left, …), with the employee as a worker',
    version: 1,
    kind: 'trigger',
    triggerSource: 'appWebhook',
    categories: ['HR'],
    icon: 'file:hris-trigger.svg',
    color: COLOR,
    subtitle: '{{events}}',
    documentationUrl: 'https://apidocs.hibob.com/docs/getting-started-webhooks',
    keywords: ['hibob', 'bob', 'hr', 'hris', 'joiner', 'mover', 'leaver', 'webhook'],
    inputs: [],
    outputs: [{ type: 'main' }],
    credentials: [{ name: 'hibobApi', required: true }],
    properties: [
      { name: 'notice', displayName: NOTICE, type: 'notice', default: '' },
      {
        name: 'events',
        displayName: 'Events',
        type: 'multiOptions',
        default: DEFAULT_EVENTS,
        required: true,
        noDataExpression: true,
        options: EVENTS,
        description: 'The event types that start a run; others are answered and ignored',
      },
      {
        name: 'fetchEmployee',
        displayName: 'Fetch Employee',
        type: 'boolean',
        default: true,
        description:
          "Whether to read the employee from HiBob and output them as a worker (Bob's event carries only their id). Off: the item has the event and the id",
      },
    ],
  },
  execute(ctx) {
    ctx.logger.info('HiBob sends events to the published workflow; a manual run has no event to output');
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
        throw new NodeOperationError('The HiBob credential has no Webhook Secret', {
          description:
            "Copy the secret of the webhook in Bob into the credential: Landflow checks every delivery's Bob-Signature with it.",
        });
      }
      const events = ctx.getNodeParameter<string[]>('events', []);
      if (!Array.isArray(events) || events.length === 0) throw new NodeOperationError('Select at least one event');
      // A bad service user fails the publish, not the first delivery.
      await ctx.span('hibob.people.search', {}, () => checkCredentials({ http: ctx.http }, credentials));
      ctx.setStaticData({ url: ctx.getWebhookUrl() } satisfies TriggerStatic);
      ctx.logger.info("HiBob Trigger ready: paste the URL into Bob's webhook settings", { url: ctx.getWebhookUrl() });
      return true;
    },
    delete(ctx) {
      ctx.setStaticData({});
      return true;
    },
  },
  async webhook(ctx) {
    const raw = ctx.getRawBody();
    let body: unknown;
    try {
      body = ctx.getBody();
    } catch {
      body = undefined;
    }
    const answer = (status: number, json: JsonObject) => ({ response: { status, json } });
    if (isPing(raw, body)) return answer(200, { ok: true });

    const credentials = credentialsOf(ctx);
    const secret = String(credentials.webhookSecret ?? '').trim();
    if (!verifyBobSignature(secret, raw, ctx.getHeader('bob-signature'))) {
      ctx.logger.warn(
        secret
          ? 'rejected a delivery with a missing or invalid Bob-Signature'
          : 'rejected a delivery: the HiBob credential has no Webhook Secret',
      );
      return answer(401, { error: 'invalid signature' });
    }
    if (!isObject(body) || typeof body.type !== 'string') return answer(400, { error: 'not a HiBob event' });

    const type = body.type;
    const selected = ctx.getNodeParameter<string[]>('events', DEFAULT_EVENTS) ?? DEFAULT_EVENTS;
    if (!selected.includes(type)) return answer(200, { ignored: type });
    const data = isObject(body.data) ? body.data : {};
    const employeeId = String(data.employeeId ?? data.id ?? '').trim();
    if (!employeeId) return answer(400, { error: 'the event names no employee' });

    const event: JsonObject = {
      event: type,
      changedFields: changedFields(data).length ? changedFields(data) : changedFields(body),
      triggeredAt: typeof body.triggeredAt === 'string' ? body.triggeredAt : null,
      triggeredBy: typeof body.triggeredBy === 'string' ? body.triggeredBy : null,
      companyId: body.companyId !== undefined ? String(body.companyId) : null,
    };
    let item: JsonObject = { source: 'hibob', sourceId: employeeId, ...event };
    if (ctx.getNodeParameter<boolean>('fetchEmployee', true) !== false && !NO_FETCH.has(type)) {
      try {
        const employee = await ctx.span('hibob.people.get', { 'hibob.employee.id': employeeId }, () =>
          getEmployee({ http: ctx.http }, credentials, employeeId),
        );
        if (!employee) {
          // Gone between the event and now (deleted): the run still starts, with what the event said.
          ctx.logger.warn(`HiBob has no employee ${employeeId} any more; the item carries only the event`);
        } else {
          item = { ...workerFromHiBob(employee), ...event };
        }
      } catch (error) {
        // Bob retries a delivery that fails (for 3 days); answering 503 asks for that rather than starting a run without the employee.
        const status = error instanceof HiBobError ? error.status : 0;
        ctx.logger.error(`could not read employee ${employeeId} from HiBob: ${(error as Error).message}`);
        return answer(503, { error: 'could not read the employee from HiBob', status });
      }
    }
    // Bob redelivers when it got no 2xx in 10 s: the same event, employee and time start one run.
    return { items: [item], idempotencyKey: `${type}:${employeeId}:${event.triggeredAt ?? ''}` };
  },
});
