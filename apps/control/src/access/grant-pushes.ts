import type { GrantPush } from '@landbright/contracts';
import type { Tx } from './grants';

const GROUP_PUSHES = ['provisioning.group_created', 'provisioning.group_linked', 'provisioning.group_updated'];
const USER_PUSHES = ['provisioning.user_created', 'provisioning.user_linked', 'provisioning.user_updated'];
/** Removals after a grant ends are its own until then (a push that kept failing lands within a day). */
const AFTER_CLOSE_MS = 24 * 3600_000;

interface GrantFacts {
  subjectId: string;
  startsAt: Date;
  activatedAt: Date | null;
  closedAt: Date | null;
  targets: Array<{ key: string }>;
}

interface PushData {
  target?: string;
  targetId?: string;
  added?: string[];
  removed?: string[];
  groupsAdded?: string[];
  groupsRemoved?: string[];
  drift?: boolean;
}

/**
 * What a grant's group memberships did in the applications Landbright provisions (spec 006), read from the audit
 * log: in groups mode, the group pushes that added or removed the subject; in user_attribute mode, the person's pushes
 * whose `groups` gained or lost the group. Pushes while the grant was live, and removals in the day after it ended.
 */
export async function pushesOf(tx: Tx, g: GrantFacts): Promise<GrantPush[]> {
  const groupIds = g.targets.filter((t) => t.key.startsWith('group:')).map((t) => t.key.slice('group:'.length));
  if (groupIds.length === 0) return [];
  const since = g.activatedAt ?? g.startsAt;
  const until = g.closedAt ? new Date(g.closedAt.getTime() + AFTER_CLOSE_MS) : undefined;
  const [groups, events] = await Promise.all([
    tx.group.findMany({ where: { id: { in: groupIds } }, select: { id: true, name: true } }),
    tx.auditEvent.findMany({
      where: {
        OR: [
          { targetId: { in: groupIds }, targetType: 'group', action: { in: GROUP_PUSHES } },
          { targetId: g.subjectId, targetType: 'identity', action: { in: USER_PUSHES } },
        ],
        at: { gte: since, ...(until && { lte: until }) },
      },
      orderBy: { id: 'asc' },
      take: 200,
    }),
  ]);
  const nameOf = new Map(groups.map((x) => [x.id, x.name]));
  const names = new Set(groups.map((x) => x.name));
  const live = (at: Date) => !g.closedAt || at <= g.closedAt;
  return events.flatMap((e): GrantPush[] => {
    const d = (e.data ?? {}) as PushData;
    const base = { target: d.target ?? 'Application', targetId: d.targetId ?? '', drift: d.drift === true };
    const at = e.at.toISOString();
    if (e.targetType === 'group') {
      const group = nameOf.get(e.targetId!) ?? '';
      if (d.added?.includes(g.subjectId) && live(e.at)) return [{ ...base, group, change: 'added', at }];
      if (d.removed?.includes(g.subjectId)) return [{ ...base, group, change: 'removed', at }];
      return [];
    }
    return [
      ...(live(e.at) ? (d.groupsAdded ?? []) : [])
        .filter((n) => names.has(n))
        .map((group): GrantPush => ({ ...base, group, change: 'added', at })),
      ...(d.groupsRemoved ?? [])
        .filter((n) => names.has(n))
        .map((group): GrantPush => ({ ...base, group, change: 'removed', at })),
    ];
  });
}
