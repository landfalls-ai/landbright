import {
  AppWindow,
  Bot,
  Boxes,
  Cable,
  ClipboardCheck,
  House,
  Inbox,
  KeyRound,
  type LucideIcon,
  Scale,
  ScrollText,
  Settings,
  Users,
  UsersRound,
  Webhook,
} from 'lucide-react';

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  /** The wave that builds the page (docs/roadmap.md). Pages of later waves show what they will do. */
  wave: number;
  summary: string;
}

/** The current wave: pages with a higher wave are placeholders. */
export const CURRENT_WAVE = 0;

/** The sidebar, after Landflow's grouped shell (plan §6.2). */
export const NAV_GROUPS: Array<{ label: string; items: NavItem[] }> = [
  {
    label: 'Directory',
    items: [
      {
        href: '/',
        label: 'Home',
        icon: House,
        wave: 0,
        summary:
          'What needs you: requests to approve, grants expiring today, joiners and leavers this week, agents without a sponsor.',
      },
      {
        href: '/people',
        label: 'People',
        icon: Users,
        wave: 1,
        summary:
          'Everyone in the directory, with their HR attributes from HiBob or Shapes, their groups and their live access.',
      },
      {
        href: '/agents',
        label: 'Agents',
        icon: Bot,
        wave: 1,
        summary:
          'Agent identities with their sponsor, risk tier, runtime and live grants. Wave 5 syncs them with Landflow’s agents.',
      },
      {
        href: '/groups',
        label: 'Groups',
        icon: UsersRound,
        wave: 1,
        summary: 'Static, birthright and just-in-time groups, and the Landflow roles and projects each one maps to.',
      },
    ],
  },
  {
    label: 'Access',
    items: [
      {
        href: '/requests',
        label: 'Requests',
        icon: Inbox,
        wave: 4,
        summary:
          'Your requests and the ones waiting for your decision, whether they came from the portal, Slack, an agent or a Landfall incident.',
      },
      {
        href: '/grants',
        label: 'Grants',
        icon: KeyRound,
        wave: 4,
        summary: 'Who holds what, until when: active and expiring grants, and a timeline of every grant.',
      },
      {
        href: '/catalog',
        label: 'Catalog',
        icon: Boxes,
        wave: 4,
        summary: 'Targets, their entitlements, and the bundles people and agents can request.',
      },
      {
        href: '/policies',
        label: 'Policies',
        icon: Scale,
        wave: 4,
        summary: 'Who may request each bundle, for how long, who approves, and when approval is automatic.',
      },
    ],
  },
  {
    label: 'Connect',
    items: [
      {
        href: '/sources',
        label: 'Sources',
        icon: Cable,
        wave: 3,
        summary: 'HiBob, Shapes and Landflow: connection health, the last sync and its errors.',
      },
      {
        href: '/applications',
        label: 'Applications',
        icon: AppWindow,
        wave: 1,
        summary:
          'The OIDC clients that sign in with Landbright (Landflow, Landfall) and the SCIM targets it provisions.',
      },
      {
        href: '/webhooks',
        label: 'Webhooks',
        icon: Webhook,
        wave: 3,
        summary: 'Signed event subscriptions. The Landflow plugin registers its own when a flow is published.',
      },
    ],
  },
  {
    label: 'Govern',
    items: [
      {
        href: '/audit',
        label: 'Audit log',
        icon: ScrollText,
        wave: 1,
        summary:
          'Every change: who made it, on whose behalf, and through which request. Hash-chained, so tampering shows.',
      },
      {
        href: '/reviews',
        label: 'Access reviews',
        icon: ClipboardCheck,
        wave: 6,
        summary: 'Periodic reviews: an agent drafts recommendations from usage, and people decide.',
      },
    ],
  },
];

export const SETTINGS: NavItem = {
  href: '/settings',
  label: 'Settings',
  icon: Settings,
  wave: 1,
  summary: 'The tenant, sign-in methods, signing keys and API credentials.',
};

export const ALL_PAGES: NavItem[] = [...NAV_GROUPS.flatMap((g) => g.items), SETTINGS];
