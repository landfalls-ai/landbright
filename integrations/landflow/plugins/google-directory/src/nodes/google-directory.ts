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
  DEFAULT_TOKEN_URL,
  SCOPES,
  type ApiContext,
  type GoogleCredentials,
} from '../google';
import {
  addMember,
  findByExternalId,
  getUser,
  publicUser,
  removeMember,
  setGroups,
  signOutUser,
  suspendUser,
  unsuspendUser,
  upsertUser,
} from '../users';

export const ICON = 'file:gdirectory.svg';
export const COLOR = '#1A73E8';

export const googleDirectoryApi = defineCredentialType<GoogleCredentials>({
  name: 'googleDirectoryApi',
  displayName: 'Google Directory (service account)',
  icon: ICON,
  documentationUrl: 'https://developers.google.com/workspace/admin/directory/v1/guides/delegation',
  properties: [
    {
      name: 'serviceAccountEmail',
      displayName: 'Service Account Email',
      type: 'string',
      default: '',
      placeholder: 'landbright-sync@my-project.iam.gserviceaccount.com',
      description: 'client_email from the JSON key file (read from the file when you paste the whole file below)',
    },
    {
      name: 'privateKey',
      displayName: 'Private Key',
      type: 'string',
      required: true,
      default: '',
      typeOptions: { password: true },
      description: 'private_key from the JSON key file. Escaped \\n, one line, or the whole JSON key file all work',
    },
    {
      name: 'adminEmail',
      displayName: 'Act As (administrator)',
      type: 'string',
      default: '',
      placeholder: 'it-admin@your-domain.com',
      description: `A Workspace administrator the service account acts as through domain-wide delegation (scopes: ${SCOPES.map((s) => s.split('/').pop()).join(', ')}). Empty when the service account holds an admin role of its own`,
    },
    {
      name: 'customer',
      displayName: 'Customer',
      type: 'string',
      default: 'my_customer',
      description: 'The Workspace customer: my_customer is the administrator’s own',
    },
    {
      name: 'baseUrl',
      displayName: 'API Base URL (advanced)',
      type: 'string',
      default: DEFAULT_BASE_URL,
      description: 'Google’s, or a test double (the fake Google locally: http://127.0.0.1:57995)',
    },
    {
      name: 'tokenUrl',
      displayName: 'Token URL (advanced)',
      type: 'string',
      default: DEFAULT_TOKEN_URL,
    },
  ],
  async test(data, ctx) {
    try {
      await checkCredentials({ http: ctx.http }, data);
      const who = String(data.adminEmail ?? '').trim();
      return { ok: true, message: `Read the directory${who ? ` as ${who}` : ' as the service account'}` };
    } catch (error) {
      return { ok: false, message: (error as Error).message };
    }
  },
});

/** Per item, with pairedItem; a failure stops the node unless it continues on fail. */
async function mapItems(ctx: IExecuteContext, fn: (itemIndex: number) => Promise<JsonObject[]>): Promise<NodeItem[]> {
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

const text = (ctx: IExecuteContext, name: string, i: number) =>
  String(ctx.getNodeParameter<unknown>(name, i, '') ?? '').trim();

function required(ctx: IExecuteContext, name: string, label: string, i: number): string {
  const value = text(ctx, name, i);
  if (!value) throw new NodeOperationError(`${label} is required`, { itemIndex: i });
  return value;
}

/** A list parameter: an array (from an expression) or comma, space or newline separated text. */
export function listOf(value: unknown): string[] {
  const list = Array.isArray(value) ? value.map(String) : String(value ?? '').split(/[\s,]+/);
  return [...new Set(list.map((v) => v.trim().toLowerCase()).filter(Boolean))];
}

const optional = (ctx: IExecuteContext, name: string, i: number) => text(ctx, name, i) || null;

/** A boolean parameter, also when an expression gave it as text ("true", "false"). */
export function flag(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  const t = String(value ?? '')
    .trim()
    .toLowerCase();
  if (t === 'true') return true;
  if (t === 'false' || t === '') return t === 'false' ? false : fallback;
  return fallback;
}

const USER_OPS = ['upsert', 'get', 'suspend', 'unsuspend', 'signOut', 'setGroups'];

export const GoogleDirectory = defineNode({
  description: {
    name: 'googleDirectory',
    displayName: 'Google Directory',
    description:
      "Google Workspace's users and group members: create or update a person's account, suspend and sign them out, set their groups",
    version: 1,
    kind: 'action',
    categories: ['HR', 'Productivity'],
    icon: ICON,
    color: COLOR,
    subtitle: '{{operation}}: {{resource}}',
    documentationUrl: 'https://developers.google.com/workspace/admin/directory/reference/rest',
    keywords: ['google', 'workspace', 'gsuite', 'directory', 'user', 'account', 'group', 'joiner', 'leaver', 'suspend'],
    usableAsTool: true,
    idempotent: true,
    inputs: [{ type: 'main' }],
    outputs: [{ type: 'main' }],
    credentials: [{ name: 'googleDirectoryApi', required: true }],
    properties: [
      {
        name: 'resource',
        displayName: 'Resource',
        type: 'options',
        noDataExpression: true,
        default: 'user',
        options: [
          { name: 'User', value: 'user' },
          { name: 'Group', value: 'group' },
        ],
      },
      {
        name: 'operation',
        displayName: 'Operation',
        type: 'options',
        noDataExpression: true,
        default: 'upsert',
        displayOptions: { show: { resource: ['user'] } },
        options: [
          {
            name: 'Create or Update',
            value: 'upsert',
            description: "Create the person's account, or bring theirs in line (found by Landbright's id, else email)",
            action: 'Create or update a user',
          },
          { name: 'Get', value: 'get', description: 'Read a user by email or Landbright id', action: 'Get a user' },
          {
            name: 'Suspend',
            value: 'suspend',
            description: 'Suspend the account and sign them out everywhere (nothing when they have none)',
            action: 'Suspend a user',
          },
          { name: 'Unsuspend', value: 'unsuspend', action: 'Unsuspend a user' },
          {
            name: 'Sign Out',
            value: 'signOut',
            description: 'End every Google session they have',
            action: 'Sign a user out',
          },
          {
            name: 'Set Groups',
            value: 'setGroups',
            description: 'Their memberships among the managed groups become exactly the wanted ones',
            action: 'Set a user’s groups',
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
        ],
      },
      {
        name: 'email',
        displayName: 'Email',
        type: 'string',
        default: '',
        description: 'The person’s primary email in Google (their Landbright email)',
        displayOptions: { show: { resource: ['user'], operation: USER_OPS.filter((o) => o !== 'get') } },
      },
      {
        name: 'key',
        displayName: 'Email or Landbright ID',
        type: 'string',
        required: true,
        default: '',
        displayOptions: { show: { resource: ['user'], operation: ['get'] } },
      },
      ...(
        [
          ['givenName', 'Given Name', true],
          ['familyName', 'Family Name', true],
          ['externalId', 'Landbright ID', false],
          ['department', 'Department', false],
          ['title', 'Title', false],
          ['managerEmail', 'Manager Email', false],
          ['orgUnitPath', 'Org Unit Path (new accounts)', false],
        ] as const
      ).map(([name, displayName, isRequired]) => ({
        name,
        displayName,
        type: 'string' as const,
        default: '',
        ...(isRequired && { required: true }),
        ...(name === 'externalId' && {
          description:
            "Kept in the account's external ids (type landbright): how the account is found after an email change",
        }),
        ...(name === 'orgUnitPath' && {
          placeholder: '/',
          description: 'Only when the account is created; empty: the top',
        }),
        displayOptions: { show: { resource: ['user'], operation: ['upsert'] } },
      })),
      {
        name: 'unsuspend',
        displayName: 'Unsuspend',
        type: 'boolean',
        default: false,
        description: 'Whether to lift a suspension too (a person Landbright reactivated)',
        displayOptions: { show: { resource: ['user'], operation: ['upsert'] } },
      },
      {
        name: 'signOut',
        displayName: 'Sign Out',
        type: 'boolean',
        default: true,
        description: 'Whether to end their Google sessions too: Google keeps its own after they signed in',
        displayOptions: { show: { resource: ['user'], operation: ['suspend'] } },
      },
      {
        name: 'wanted',
        displayName: 'Wanted Groups',
        type: 'string',
        default: '',
        description: 'Group emails they should be in: comma separated, or an expression giving a list',
        displayOptions: { show: { resource: ['user'], operation: ['setGroups'] } },
      },
      {
        name: 'managed',
        displayName: 'Managed Groups',
        type: 'string',
        default: '',
        description:
          'Every group email this flow manages: they are removed from the ones not wanted. Other groups are left alone',
        displayOptions: { show: { resource: ['user'], operation: ['setGroups'] } },
      },
      {
        name: 'notFound',
        displayName: 'When Not Found',
        type: 'options',
        default: 'error',
        displayOptions: { show: { resource: ['user'], operation: ['get'] } },
        options: [
          { name: 'Fail', value: 'error' },
          { name: 'Output Nothing', value: 'skip' },
        ],
      },
      {
        name: 'group',
        displayName: 'Group Email',
        type: 'string',
        required: true,
        default: '',
        displayOptions: { show: { resource: ['group'] } },
      },
      {
        name: 'member',
        displayName: 'Member Email',
        type: 'string',
        required: true,
        default: '',
        displayOptions: { show: { resource: ['group'] } },
      },
    ],
  },
  async execute(ctx) {
    const api: ApiContext = { http: ctx.http, ...(ctx.signal && { signal: ctx.signal }) };
    return mapItems(ctx, async (i) => {
      const credentials = ctx.getCredentials<GoogleCredentials>('googleDirectoryApi');
      const resource = ctx.getNodeParameter<string>('resource', i, 'user');
      const operation = ctx.getNodeParameter<string>('operation', i, resource === 'user' ? 'upsert' : 'addMember');
      if (resource === 'group') {
        const group = required(ctx, 'group', 'Group Email', i);
        const member = required(ctx, 'member', 'Member Email', i);
        if (operation === 'addMember')
          return [
            {
              group: group.toLowerCase(),
              member: member.toLowerCase(),
              result: await addMember(api, credentials, group, member),
            },
          ];
        if (operation === 'removeMember')
          return [
            {
              group: group.toLowerCase(),
              member: member.toLowerCase(),
              result: await removeMember(api, credentials, group, member),
            },
          ];
      }
      if (resource === 'user') {
        switch (operation) {
          case 'upsert':
            return [
              await upsertUser(api, credentials, {
                email: required(ctx, 'email', 'Email', i),
                givenName: required(ctx, 'givenName', 'Given Name', i),
                familyName: required(ctx, 'familyName', 'Family Name', i),
                externalId: optional(ctx, 'externalId', i),
                department: optional(ctx, 'department', i),
                title: optional(ctx, 'title', i),
                managerEmail: optional(ctx, 'managerEmail', i),
                orgUnitPath: optional(ctx, 'orgUnitPath', i),
                unsuspend: flag(ctx.getNodeParameter<unknown>('unsuspend', i, false), false),
              }),
            ];
          case 'get': {
            const key = required(ctx, 'key', 'Email or Landbright ID', i);
            const user = key.includes('@')
              ? await getUser(api, credentials, key.toLowerCase())
              : await findByExternalId(api, credentials, key);
            if (user) return [publicUser(user)];
            if (ctx.getNodeParameter<string>('notFound', i, 'error') === 'skip') return [];
            throw new NodeOperationError(`Google has no user "${key}"`, { itemIndex: i });
          }
          case 'suspend':
            return [
              await suspendUser(
                api,
                credentials,
                required(ctx, 'email', 'Email', i),
                flag(ctx.getNodeParameter<unknown>('signOut', i, true), true),
              ),
            ];
          case 'unsuspend':
            return [await unsuspendUser(api, credentials, required(ctx, 'email', 'Email', i))];
          case 'signOut':
            return [await signOutUser(api, credentials, required(ctx, 'email', 'Email', i))];
          case 'setGroups':
            return [
              await setGroups(
                api,
                credentials,
                required(ctx, 'email', 'Email', i),
                listOf(ctx.getNodeParameter<unknown>('wanted', i, '')),
                listOf(ctx.getNodeParameter<unknown>('managed', i, '')),
              ),
            ];
        }
      }
      throw new NodeOperationError(`Operation "${operation}" is not available for resource "${resource}"`, {
        itemIndex: i,
      });
    });
  },
});
