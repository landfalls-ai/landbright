import { defineCredentialType, defineNode, NodeOperationError, type IExecuteContext } from '@landflow/sdk';
import {
  changedSince,
  DEFAULT_SHAPES_URL,
  idsByEmail,
  whoAmI,
  workersByIds,
  type ApiContext,
  type ShapesCredentials,
} from '../shapes';
import { COLOR, ICON, mapItems } from './hibob';

export const shapesApi = defineCredentialType<ShapesCredentials>({
  name: 'shapesApi',
  displayName: 'Shapes API',
  icon: ICON,
  documentationUrl: 'https://help.shapes.co/en/articles/13616006-where-do-i-find-my-api-tokens',
  properties: [
    {
      name: 'baseUrl',
      displayName: 'API URL',
      type: 'string',
      default: DEFAULT_SHAPES_URL,
      description: "Shapes' GraphQL endpoint. Local runs point it at the fake Shapes (http://127.0.0.1:57996/v1)",
    },
    {
      name: 'refreshToken',
      displayName: 'Refresh Token',
      type: 'string',
      required: true,
      default: '',
      typeOptions: { password: true },
      description:
        "From Shapes → My settings → API tokens, of a dedicated system user (a Super Admin, or an Admin covering every employee). The plugin spends it for an access token and keeps the pair it gets back; don't give the same token to another tool",
    },
    {
      name: 'webhookSecret',
      displayName: 'Webhook Secret',
      type: 'string',
      default: '',
      typeOptions: { password: true },
      description:
        'The secret of the Send webhook action in the Shapes workflow. The Shapes Trigger needs it: every delivery is checked against X-Webhook-Signature',
    },
  ],
  async test(data, ctx) {
    try {
      const me = await whoAmI({ http: ctx.http }, data);
      return { ok: true, message: `Authenticated as ${me.email}` };
    } catch (error) {
      return { ok: false, message: (error as Error).message };
    }
  },
});

function required(ctx: IExecuteContext, name: string, label: string, i: number): string {
  const value = String(ctx.getNodeParameter<unknown>(name, i, '') ?? '').trim();
  if (!value) throw new NodeOperationError(`${label} is required`, { itemIndex: i });
  return value;
}

export const Shapes = defineNode({
  description: {
    name: 'shapes',
    displayName: 'Shapes',
    description:
      "Read Shapes employees as workers: one shape (email, names, department, title, site, manager, start and end dates) that Landbright's Person → Create or update takes",
    version: 1,
    kind: 'action',
    categories: ['HR'],
    icon: ICON,
    color: COLOR,
    subtitle: '{{operation}}: employee',
    documentationUrl: 'https://studio.apollographql.com/public/DreamTeam-V1/variant/Current/home',
    keywords: ['shapes', 'dreamteam', 'hr', 'hris', 'employee', 'worker'],
    usableAsTool: true,
    idempotent: true,
    inputs: [{ type: 'main' }],
    outputs: [{ type: 'main' }],
    credentials: [{ name: 'shapesApi', required: true }],
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
          {
            name: 'Get',
            value: 'get',
            description: 'Read one employee by Shapes id or work email',
            action: 'Get an employee',
          },
          { name: 'Search', value: 'search', description: 'Find employees by work email', action: 'Search employees' },
          {
            name: 'Get Changed',
            value: 'changed',
            description: 'Employees whose names, email, department, job, office, manager or dates changed since a time',
            action: 'Get changed employees',
          },
        ],
      },
      {
        name: 'employee',
        displayName: 'Employee ID or Email',
        type: 'string',
        required: true,
        default: '',
        displayOptions: { show: { operation: ['get'] } },
        description: "Shapes' employee id (the trigger's sourceId) or their work email",
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
        name: 'since',
        displayName: 'Since',
        type: 'string',
        required: true,
        default: '',
        placeholder: '2026-11-16T08:00:00Z',
        displayOptions: { show: { operation: ['changed'] } },
        description: 'An ISO date and time; Shapes advises a few minutes before the last run started',
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
      const credentials = ctx.getCredentials<ShapesCredentials>('shapesApi');
      const operation = ctx.getNodeParameter<string>('operation', i, 'get');
      if (operation === 'search') {
        const ids = await idsByEmail(api, credentials, required(ctx, 'email', 'Email', i));
        return ids.length ? workersByIds(api, credentials, ids) : [];
      }
      if (operation === 'changed') {
        const since = required(ctx, 'since', 'Since', i);
        if (Number.isNaN(new Date(since).getTime()))
          throw new NodeOperationError(`Since "${since}" is not a date`, { itemIndex: i });
        const ids = await changedSince(api, credentials, new Date(since).toISOString());
        return ids.length ? workersByIds(api, credentials, ids) : [];
      }
      if (operation !== 'get')
        throw new NodeOperationError(`Operation "${operation}" is not available`, { itemIndex: i });
      const key = required(ctx, 'employee', 'Employee ID or Email', i);
      const ids = key.includes('@') ? await idsByEmail(api, credentials, key) : [key];
      const [worker] = ids.length ? await workersByIds(api, credentials, ids.slice(0, 1)) : [];
      if (!worker) {
        if (ctx.getNodeParameter<string>('notFound', i, 'error') === 'skip') return [];
        throw new NodeOperationError(`Shapes has no employee "${key}"`, { itemIndex: i });
      }
      return [worker];
    });
  },
});
