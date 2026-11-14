import {
  defineCredentialType,
  defineNode,
  NodeOperationError,
  type IExecuteContext,
  type JsonObject,
  type NodeItem,
} from '@landflow/sdk';
import { accessToken, call, DEFAULT_SCOPES, type ApiContext, type LandbrightCredentials } from '../client';

export const ICON = 'file:landbright.svg';
export const COLOR = '#C2410C';

export const landbrightApi = defineCredentialType<LandbrightCredentials>({
  name: 'landbrightApi',
  displayName: 'Landbright API',
  icon: ICON,
  properties: [
    {
      name: 'controlUrl',
      displayName: 'Control URL',
      type: 'string',
      required: true,
      default: '',
      placeholder: 'http://127.0.0.1:4401',
      description: "Landbright's control plane (the machine API is under /api/v1)",
    },
    {
      name: 'issuer',
      displayName: 'Issuer',
      type: 'string',
      required: true,
      default: '',
      placeholder: 'http://localhost:4402/oidc',
      description: "Landbright's OpenID issuer; tokens come from {issuer}/token",
    },
    {
      name: 'clientId',
      displayName: 'Client ID',
      type: 'string',
      required: true,
      default: '',
      description:
        'An application with the client credentials grant and machine API scopes (directory:read, directory:write)',
    },
    {
      name: 'clientSecret',
      displayName: 'Client Secret',
      type: 'string',
      required: true,
      default: '',
      typeOptions: { password: true },
    },
    {
      name: 'scopes',
      displayName: 'Scopes',
      type: 'string',
      default: DEFAULT_SCOPES,
      description: 'Machine API scopes to ask for, space-separated (the application must have them)',
    },
  ],
  async test(data, ctx) {
    try {
      await accessToken({ http: ctx.http }, data);
      return { ok: true, message: `Got a machine API token for ${data.clientId}` };
    } catch (error) {
      return { ok: false, message: (error as Error).message };
    }
  },
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** What `POST /api/v1/people` takes from a worker; everything else on the item is left out. */
const WORKER_FIELDS = [
  'source',
  'sourceId',
  'email',
  'givenName',
  'familyName',
  'department',
  'title',
  'site',
  'managerEmail',
  'startDate',
  'endDate',
] as const;
const OPTIONAL = new Set(['department', 'title', 'site', 'managerEmail', 'startDate', 'endDate']);

/** A worker (the hris nodes' output, or fields) as the body of `POST /api/v1/people`. */
export function upsertBody(worker: JsonObject, sendInvite: boolean, itemIndex = 0): JsonObject {
  const body: JsonObject = { sendInvite };
  for (const key of WORKER_FIELDS) {
    const raw = worker[key];
    const value = raw === undefined || raw === null ? null : String(raw).trim() || null;
    if (value === null) {
      if (OPTIONAL.has(key)) {
        if (key in worker) body[key] = null;
        continue;
      }
      if (key === 'familyName') continue;
      throw new NodeOperationError(`The worker has no ${key}`, {
        itemIndex,
        description:
          'Person → Create or Update needs source, sourceId, email and givenName (a HiBob Trigger or HiBob node item has them).',
      });
    }
    body[key] = value;
  }
  return body;
}

/** Per item, with pairedItem; a failure stops the node unless it continues on fail. */
async function mapItems(
  ctx: IExecuteContext,
  fn: (itemIndex: number, item: NodeItem) => Promise<JsonObject>,
): Promise<NodeItem[]> {
  const out: NodeItem[] = [];
  const items = ctx.getInputData();
  for (let i = 0; i < items.length; i++) {
    try {
      out.push({ json: await fn(i, items[i]), pairedItem: { item: i } });
    } catch (error) {
      const e = error as NodeOperationError;
      const failure =
        e instanceof NodeOperationError && e.itemIndex === i
          ? e
          : new NodeOperationError(e?.message ?? String(error), {
              itemIndex: i,
              ...(e?.description && { description: e.description }),
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

function personId(ctx: IExecuteContext, i: number): string {
  const id = required(ctx, 'personId', 'Person ID', i);
  if (!UUID.test(id))
    throw new NodeOperationError(`Person ID "${id}" is not a Landbright id`, {
      itemIndex: i,
      description: 'Use the id of a person item (Create or Update outputs it as person.id).',
    });
  return id;
}

/** A group by id, or by its exact name. */
async function groupOf(
  api: ApiContext,
  credentials: LandbrightCredentials,
  ref: string,
  i: number,
): Promise<JsonObject> {
  const found = ((await call(api, credentials, 'GET', `/groups?name=${encodeURIComponent(ref)}`)).items ??
    []) as JsonObject[];
  const group = found.find((g) => g.name === ref) ?? (UUID.test(ref) ? { id: ref } : undefined);
  if (!group) throw new NodeOperationError(`Landbright has no group "${ref}"`, { itemIndex: i });
  return group;
}

const show = (resource: string, operation: string[]) => ({ show: { resource: [resource], operation } });

export const Landbright = defineNode({
  description: {
    name: 'landbright',
    displayName: 'Landbright',
    description:
      'People and groups in Landbright: create or update a person from an HR worker, read or deactivate them, add and remove group members',
    version: 1,
    kind: 'action',
    categories: ['HR', 'Development'],
    icon: ICON,
    color: COLOR,
    subtitle: '{{operation}}: {{resource}}',
    keywords: ['landbright', 'identity', 'idp', 'person', 'group', 'joiner', 'leaver', 'deactivate'],
    usableAsTool: true,
    idempotent: false,
    inputs: [{ type: 'main' }],
    outputs: [{ type: 'main' }],
    credentials: [{ name: 'landbrightApi', required: true }],
    properties: [
      {
        name: 'resource',
        displayName: 'Resource',
        type: 'options',
        noDataExpression: true,
        default: 'person',
        options: [
          { name: 'Person', value: 'person' },
          { name: 'Group', value: 'group' },
        ],
      },
      {
        name: 'operation',
        displayName: 'Operation',
        type: 'options',
        noDataExpression: true,
        default: 'upsert',
        displayOptions: { show: { resource: ['person'] } },
        options: [
          {
            name: 'Create or Update',
            value: 'upsert',
            description: 'From an HR worker, keyed by its source and id; a pre-hire until their start date',
            action: 'Create or update a person',
          },
          {
            name: 'Get',
            value: 'get',
            description: 'A person with their department, manager and groups',
            action: 'Get a person',
            idempotent: true,
          },
          {
            name: 'Deactivate',
            value: 'deactivate',
            description: 'Sign them out everywhere and end their grants and agents',
            action: 'Deactivate a person',
          },
        ],
      },
      {
        name: 'operation',
        displayName: 'Operation',
        type: 'options',
        noDataExpression: true,
        default: 'addMember',
        displayOptions: { show: { resource: ['group'] } },
        options: [
          { name: 'Add Member', value: 'addMember', action: 'Add a member to a group' },
          { name: 'Remove Member', value: 'removeMember', action: 'Remove a member from a group' },
          { name: 'Get by Name', value: 'getByName', action: 'Get a group by name', idempotent: true },
        ],
      },
      {
        name: 'useInput',
        displayName: 'Use the Input Worker',
        type: 'boolean',
        default: true,
        displayOptions: show('person', ['upsert']),
        description: 'Whether the input item is the worker (a HiBob Trigger or HiBob node item); off: give the fields',
      },
      ...(
        [
          'source',
          'sourceId',
          'email',
          'givenName',
          'familyName',
          'department',
          'title',
          'site',
          'managerEmail',
          'startDate',
          'endDate',
        ] as const
      ).map((name) => ({
        name,
        displayName: {
          source: 'Source',
          sourceId: 'Source ID',
          email: 'Email',
          givenName: 'Given Name',
          familyName: 'Family Name',
          department: 'Department',
          title: 'Title',
          site: 'Site',
          managerEmail: 'Manager Email',
          startDate: 'Start Date',
          endDate: 'End Date',
        }[name],
        type: 'string' as const,
        default: name === 'source' ? 'hibob' : '',
        ...(['source', 'sourceId', 'email', 'givenName'].includes(name) && { required: true }),
        ...((name === 'startDate' || name === 'endDate') && { placeholder: 'YYYY-MM-DD' }),
        displayOptions: { show: { resource: ['person'], operation: ['upsert'], useInput: [false] } },
      })),
      {
        name: 'sendInvite',
        displayName: 'Send Invite',
        type: 'boolean',
        default: true,
        displayOptions: show('person', ['upsert']),
        description: 'Whether a new person gets the invite email when they become active (now, or on their start date)',
      },
      {
        name: 'personId',
        displayName: 'Person ID',
        type: 'string',
        required: true,
        default: '',
        displayOptions: { show: { operation: ['get', 'deactivate', 'addMember', 'removeMember'] } },
        description: 'The Landbright id of the person (person.id from Create or Update)',
      },
      {
        name: 'reason',
        displayName: 'Reason',
        type: 'string',
        default: '',
        displayOptions: show('person', ['deactivate']),
        description: 'Kept in the audit log, e.g. "Left (HiBob)"',
      },
      {
        name: 'group',
        displayName: 'Group',
        type: 'string',
        required: true,
        default: '',
        displayOptions: { show: { resource: ['group'] } },
        description: "The group's exact name, or its id",
      },
      {
        name: 'expiresAt',
        displayName: 'Expires At',
        type: 'dateTime',
        default: '',
        displayOptions: show('group', ['addMember']),
        description: 'Optional: when the membership ends on its own',
      },
    ],
  },
  async execute(ctx) {
    const api: ApiContext = { http: ctx.http, ...(ctx.signal && { signal: ctx.signal }) };
    return mapItems(ctx, async (i, item) => {
      const credentials = ctx.getCredentials<LandbrightCredentials>('landbrightApi');
      const resource = ctx.getNodeParameter<string>('resource', i, 'person');
      const operation = ctx.getNodeParameter<string>('operation', i, resource === 'person' ? 'upsert' : 'addMember');
      if (resource === 'person') {
        switch (operation) {
          case 'upsert': {
            const worker: JsonObject =
              ctx.getNodeParameter<boolean>('useInput', i, true) !== false
                ? item.json
                : Object.fromEntries(
                    WORKER_FIELDS.map((key) => [
                      key,
                      ctx.getNodeParameter<unknown>(key, i, null) as JsonObject[string],
                    ]),
                  );
            return call(
              api,
              credentials,
              'POST',
              '/people',
              upsertBody(worker, ctx.getNodeParameter<boolean>('sendInvite', i, true) !== false, i),
            );
          }
          case 'get':
            return call(api, credentials, 'GET', `/people/${personId(ctx, i)}`);
          case 'deactivate': {
            const reason = String(ctx.getNodeParameter<unknown>('reason', i, '') ?? '').trim();
            return call(api, credentials, 'POST', `/people/${personId(ctx, i)}/deactivate`, reason ? { reason } : {});
          }
        }
      }
      if (resource === 'group') {
        const group = await groupOf(api, credentials, required(ctx, 'group', 'Group', i), i);
        switch (operation) {
          case 'getByName':
            return group;
          case 'addMember': {
            const expires = String(ctx.getNodeParameter<unknown>('expiresAt', i, '') ?? '').trim();
            const body: JsonObject = { identityId: personId(ctx, i) };
            if (expires) {
              const at = new Date(expires);
              if (Number.isNaN(at.getTime()))
                throw new NodeOperationError(`Expires At "${expires}" is not a date`, { itemIndex: i });
              body.expiresAt = at.toISOString();
            }
            return call(api, credentials, 'POST', `/groups/${group.id}/members`, body);
          }
          case 'removeMember':
            return call(api, credentials, 'DELETE', `/groups/${group.id}/members/${personId(ctx, i)}`);
        }
      }
      throw new NodeOperationError(`Operation "${operation}" is not available for resource "${resource}"`, {
        itemIndex: i,
      });
    });
  },
});
