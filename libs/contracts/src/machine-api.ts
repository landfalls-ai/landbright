/** Every scope of the machine API (/api/v1), with what it allows. An application is granted a subset (`apiScopes`). */
export const MACHINE_API_SCOPES = {
  'requests:read': 'Read access requests and grants',
  'requests:create': 'File access requests for people and agents it names (agent tools, intake flows)',
  'grants:record': 'Report what a flow provisioned or revoked for a grant',
  'annotations:write': 'Keep notes on requests and grants (landflow.*)',
  'directory:read': 'Read people and find who has been inactive',
  'directory:write': 'Deactivate people, set required actions, add and remove group members (lifecycle flows)',
  'decisions:relay': 'Relay votes approvers cast in a chat (Slack), with the ticket Landbright gave each of them',
  'events:manage': 'Manage its own event subscriptions (to its own redirect origins)',
} as const;
export type MachineApiScope = keyof typeof MACHINE_API_SCOPES;
export const MACHINE_API_SCOPE_NAMES = Object.keys(MACHINE_API_SCOPES) as MachineApiScope[];
