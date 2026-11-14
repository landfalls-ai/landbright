import {
  defineCredentialType,
  defineNode,
  NodeOperationError,
  type IExecuteContext,
  type JsonObject,
  type NodeItem,
} from '@landflow/sdk';
import {
  checkCredentials,
  DEFAULT_BASE_URL,
  getEmployee,
  searchByEmail,
  type ApiContext,
  type HiBobCredentials,
} from '../hibob';
import { workerFromHiBob } from '../worker';

export const ICON = 'file:hris.svg';
export const COLOR = '#2F6F5E';

export const hibobApi = defineCredentialType<HiBobCredentials>({
  name: 'hibobApi',
  displayName: 'HiBob API',
  icon: ICON,
  documentationUrl: 'https://apidocs.hibob.com/docs/api-service-users',
  properties: [
    {
      name: 'baseUrl',
      displayName: 'Base URL',
      type: 'string',
      default: DEFAULT_BASE_URL,
      description: "HiBob's API. Local runs point it at the fake Bob (http://127.0.0.1:57994/v1)",
    },
    {
      name: 'serviceUserId',
      displayName: 'Service User ID',
      type: 'string',
      required: true,
      default: '',
      description: 'Bob → Settings → Integrations → Service Users',
    },
    {
      name: 'token',
      displayName: 'Token',
      type: 'string',
      required: true,
      default: '',
      typeOptions: { password: true },
    },
    {
      name: 'webhookSecret',
      displayName: 'Webhook Secret',
      type: 'string',
      default: '',
      typeOptions: { password: true },
      description:
        'The signing secret of the webhook in Bob (Settings → Integrations → Automation → Webhooks). The HiBob Trigger needs it: every delivery is checked against Bob-Signature',
    },
  ],
  async test(data, ctx) {
    try {
      await checkCredentials({ http: ctx.http }, data);
      return { ok: true, message: `Authenticated as service user ${data.serviceUserId}` };
    } catch (error) {
      return { ok: false, message: (error as Error).message };
    }
  },
});

/** Per item, with pairedItem; a failure stops the node unless it continues on fail. */
export async function mapItems(
  ctx: IExecuteContext,
  fn: (itemIndex: number) => Promise<JsonObject[]>,
): Promise<NodeItem[]> {
  const out: NodeItem[] = [];
  const items = ctx.getInputData();
  for (let i = 0; i < items.length; i++) {
    try {
      for (const json of await fn(i)) out.push({ json, pairedItem: { item: i } });
    } catch (error) {
      const failure =
        error instanceof NodeOperationError && error.itemIndex === i
          ? error
          : new NodeOperationError((error as Error)?.message ?? String(error), {
              itemIndex: i,
              ...((error as NodeOperationError).description && {
                description: (error as NodeOperationError).description,
              }),
            });
      if (!ctx.continueOnFail()) throw failure;
      out.push({
        json: { error: failure.message, ...(failure.description && { description: failure.description }) },
        pairedItem: { item: i },
      });
    }
  }
  return out;
}

function required(ctx: IExecuteContext, name: string, label: string, i: number): string {
  const value = String(ctx.getNodeParameter<unknown>(name, i, '') ?? '').trim();
  if (!value) throw new NodeOperationError(`${label} is required`, { itemIndex: i });
  return value;
}

export const HiBob = defineNode({
  description: {
    name: 'hibob',
    displayName: 'HiBob',
    description:
      "Read HiBob employees as workers: one shape (email, names, department, title, site, manager, start and end dates) that Landbright's Person → Create or update takes",
    version: 1,
    kind: 'action',
    categories: ['HR'],
    icon: ICON,
    color: COLOR,
    subtitle: '{{operation}}: employee',
    documentationUrl: 'https://apidocs.hibob.com/reference/post_people-identifier',
    keywords: ['hibob', 'bob', 'hr', 'hris', 'employee', 'worker'],
    usableAsTool: true,
    idempotent: true,
    inputs: [{ type: 'main' }],
    outputs: [{ type: 'main' }],
    credentials: [{ name: 'hibobApi', required: true }],
    properties: [
      {
        name: 'resource',
        displayName: 'Resource',
        type: 'options',
        noDataExpression: true,
        default: 'employee',
        options: [{ name: 'Employee', value: 'employee' }],
      },
      {
        name: 'operation',
        displayName: 'Operation',
        type: 'options',
        noDataExpression: true,
        default: 'get',
        options: [
          { name: 'Get', value: 'get', description: 'Read one employee by id or email', action: 'Get an employee' },
          { name: 'Search', value: 'search', description: 'Find employees by email', action: 'Search employees' },
        ],
      },
      {
        name: 'employee',
        displayName: 'Employee ID or Email',
        type: 'string',
        required: true,
        default: '',
        displayOptions: { show: { operation: ['get'] } },
        description: "HiBob's employee id (the trigger's sourceId) or their work email",
      },
      {
        name: 'email',
        displayName: 'Email',
        type: 'string',
        required: true,
        default: '',
        displayOptions: { show: { operation: ['search'] } },
      },
      {
        name: 'includeInactive',
        displayName: 'Include Inactive',
        type: 'boolean',
        default: false,
        displayOptions: { show: { operation: ['search'] } },
        description: 'Whether to find people who have left too',
      },
      {
        name: 'notFound',
        displayName: 'When Not Found',
        type: 'options',
        default: 'error',
        displayOptions: { show: { operation: ['get'] } },
        options: [
          { name: 'Fail', value: 'error' },
          { name: 'Output Nothing', value: 'skip' },
        ],
      },
    ],
  },
  async execute(ctx) {
    const api: ApiContext = { http: ctx.http, ...(ctx.signal && { signal: ctx.signal }) };
    return mapItems(ctx, async (i) => {
      const credentials = ctx.getCredentials<HiBobCredentials>('hibobApi');
      const operation = ctx.getNodeParameter<string>('operation', i, 'get');
      if (operation === 'search') {
        const found = await searchByEmail(
          api,
          credentials,
          required(ctx, 'email', 'Email', i),
          ctx.getNodeParameter<boolean>('includeInactive', i, false) === true,
        );
        return found.map(workerFromHiBob);
      }
      if (operation !== 'get')
        throw new NodeOperationError(`Operation "${operation}" is not available`, { itemIndex: i });
      const key = required(ctx, 'employee', 'Employee ID or Email', i);
      const employee = await getEmployee(api, credentials, key);
      if (!employee) {
        if (ctx.getNodeParameter<string>('notFound', i, 'error') === 'skip') return [];
        throw new NodeOperationError(`HiBob has no employee "${key}"`, { itemIndex: i });
      }
      return [workerFromHiBob(employee)];
    });
  },
});
