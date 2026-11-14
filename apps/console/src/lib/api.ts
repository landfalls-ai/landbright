import {
  AccessRequestList,
  AccessRequestView,
  AgentList,
  ApplicationList,
  AuditPage,
  BundleList,
  DeliveryList,
  GrantList,
  GroupDetail,
  GroupList,
  HealthReport,
  Logout,
  Me,
  PeopleList,
  Person,
  ScimTargetDetail,
  ScimTargetList,
  Settings,
  SubscriptionList,
} from '@landbright/contracts';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { z } from 'zod';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** The sentence control put in an error (Nest's `message`, or the first validation issue). */
async function errorOf(response: Response): Promise<ApiError> {
  let message = `The control API answered ${response.status}.`;
  try {
    const body = (await response.json()) as {
      message?: string | string[];
      errors?: Array<{ message?: string; path?: string[] }>;
    };
    const issue = body.errors?.[0];
    if (issue?.message) message = issue.path?.length ? `${issue.path.join('.')}: ${issue.message}` : issue.message;
    else if (Array.isArray(body.message)) message = body.message.join(' ');
    else if (body.message) message = body.message;
  } catch {
    // Vite's proxy answers 502/504 (or 500 with an empty body) when control isn't running.
  }
  return new ApiError(response.status, message);
}

async function call(path: string, init: RequestInit): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(path, { ...init, headers: { accept: 'application/json', ...init.headers } });
  } catch {
    throw new ApiError(0, 'The control API did not answer.');
  }
  if (!response.ok) throw await errorOf(response);
  return response;
}

/** GET a control API route (proxied from /api) and check the body against its contract. */
export async function getJson<T>(path: string, schema: z.ZodType<T>): Promise<T> {
  return schema.parse(await (await call(path, {})).json());
}

/** A write. The session cookie goes along (same origin); control checks the Origin header. */
export async function send<T>(
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
  schema?: z.ZodType<T>,
): Promise<T> {
  const response = await call(path, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!schema || response.status === 204) return undefined as T;
  return schema.parse(await response.json());
}

/** Starts console sign-in at the identity plane, coming back to `returnTo`. */
export function signIn(returnTo = window.location.pathname + window.location.search): void {
  window.location.assign(`/api/auth/login?returnTo=${encodeURIComponent(returnTo)}`);
}

export async function signOut(): Promise<void> {
  const { redirect } = await send('POST', '/api/auth/logout', undefined, Logout);
  window.location.assign(redirect);
}

// ---------------------------------------------------------------- queries

const quiet = (failureCount: number, error: unknown) =>
  !(error instanceof ApiError && error.status < 500 && error.status > 0) && failureCount < 2;

export function useMe() {
  return useQuery({ queryKey: ['me'], queryFn: () => getJson('/api/auth/me', Me), retry: false, staleTime: 60_000 });
}

/** The health report, refreshed every 5 seconds. */
export function useHealth(enabled = true) {
  return useQuery({
    queryKey: ['health'],
    queryFn: () => getJson('/api/health', HealthReport),
    refetchInterval: 5000,
    retry: false,
    enabled,
  });
}

export const usePeople = () =>
  useQuery({ queryKey: ['people'], queryFn: () => getJson('/api/people', PeopleList), retry: quiet });
export const usePerson = (id: string) =>
  useQuery({ queryKey: ['people', id], queryFn: () => getJson(`/api/people/${id}`, Person), retry: quiet });
export const useAgents = () =>
  useQuery({ queryKey: ['agents'], queryFn: () => getJson('/api/agents', AgentList), retry: quiet });
export const useGroups = () =>
  useQuery({ queryKey: ['groups'], queryFn: () => getJson('/api/groups', GroupList), retry: quiet });
export const useGroup = (id: string) =>
  useQuery({ queryKey: ['groups', id], queryFn: () => getJson(`/api/groups/${id}`, GroupDetail), retry: quiet });
export const useApplications = () =>
  useQuery({ queryKey: ['applications'], queryFn: () => getJson('/api/applications', ApplicationList), retry: quiet });

export const useSettings = () =>
  useQuery({ queryKey: ['settings'], queryFn: () => getJson('/api/settings', Settings), retry: quiet });

export function useAudit() {
  return useInfiniteQuery({
    queryKey: ['audit'],
    initialPageParam: '',
    queryFn: ({ pageParam }) => getJson(`/api/audit?limit=50${pageParam ? `&before=${pageParam}` : ''}`, AuditPage),
    getNextPageParam: (last) => last.nextBefore ?? undefined,
    retry: quiet,
  });
}

// ---------------------------------------------------------------- access (spec 004)

export type RequestScope = 'to-decide' | 'mine' | 'all';
/** Requests refresh every 5 seconds: a Landflow flow or another approver may change them at any time. */
export const useRequests = (scope: RequestScope) =>
  useQuery({
    queryKey: ['requests', scope],
    queryFn: () => getJson(`/api/access/requests?scope=${scope}`, AccessRequestList),
    refetchInterval: 5000,
    retry: quiet,
  });
export const useRequest = (ref: string) =>
  useQuery({
    queryKey: ['requests', 'one', ref],
    queryFn: () => getJson(`/api/access/requests/${encodeURIComponent(ref)}`, AccessRequestView),
    refetchInterval: 3000,
    retry: quiet,
  });
/** The bundles the signed-in person may ask for. */
export const useRequestable = () =>
  useQuery({
    queryKey: ['bundles', 'requestable'],
    queryFn: () => getJson('/api/access/bundles', BundleList),
    retry: quiet,
  });
export const useBundles = () =>
  useQuery({ queryKey: ['bundles'], queryFn: () => getJson('/api/bundles', BundleList), retry: quiet });
export const useGrants = (status?: string) =>
  useQuery({
    queryKey: ['grants', status ?? 'all'],
    queryFn: () => getJson(`/api/access/grants${status ? `?status=${status}` : ''}`, GrantList),
    refetchInterval: 5000,
    retry: quiet,
  });
export const useSubscriptions = () =>
  useQuery({
    queryKey: ['subscriptions'],
    queryFn: () => getJson('/api/events/subscriptions', SubscriptionList),
    refetchInterval: 5000,
    retry: quiet,
  });
export const useDeliveries = (subscriptionId: string | undefined) =>
  useQuery({
    queryKey: ['deliveries', subscriptionId],
    queryFn: () => getJson(`/api/events/subscriptions/${subscriptionId}/deliveries`, DeliveryList),
    enabled: Boolean(subscriptionId),
    refetchInterval: 3000,
    retry: quiet,
  });

// ---------------------------------------------------------------- provisioning (spec 006)

/** Targets refresh every 3 seconds: pushes land within seconds of a change. */
export const useScimTargets = () =>
  useQuery({
    queryKey: ['provisioning'],
    queryFn: () => getJson('/api/provisioning/targets', ScimTargetList),
    refetchInterval: 3000,
    retry: quiet,
  });
export const useScimTarget = (id: string) =>
  useQuery({
    queryKey: ['provisioning', id],
    queryFn: () => getJson(`/api/provisioning/targets/${id}`, ScimTargetDetail),
    refetchInterval: 3000,
    retry: quiet,
  });

/** A write that refreshes what it touched: the directory is small, so every write refreshes every list. */
export function useWrite<A, R>(fn: (args: A) => Promise<R>) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      for (const key of [
        'people',
        'agents',
        'groups',
        'applications',
        'audit',
        'settings',
        'requests',
        'bundles',
        'grants',
        'subscriptions',
        'deliveries',
        'provisioning',
      ])
        void client.invalidateQueries({ queryKey: [key] });
    },
  });
}
