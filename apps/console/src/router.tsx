import type { RouteObject } from 'react-router';
import { AdminOnly, AppShell } from './components/shell/app-shell';
import { ALL_PAGES, isUpcoming } from './nav';
import { AgentsPage } from './routes/agents';
import { ApplicationsPage } from './routes/applications';
import { AuditLogPage } from './routes/audit';
import { CatalogPage } from './routes/catalog';
import { EventsPage } from './routes/events';
import { GrantsPage } from './routes/grants';
import { GroupPage } from './routes/group';
import { GroupsPage } from './routes/groups';
import { HealthPage } from './routes/health';
import { HomePage } from './routes/home';
import { NotFoundPage } from './routes/not-found';
import { PeoplePage } from './routes/people';
import { PersonPage } from './routes/person';
import { ProvisioningPage, ProvisioningTargetPage } from './routes/provisioning';
import { RequestPage } from './routes/request';
import { RequestsPage } from './routes/requests';
import { SettingsPage } from './routes/settings';
import { UpcomingPage } from './routes/upcoming';

export const routes: RouteObject[] = [
  {
    element: <AppShell />,
    children: [
      {
        index: true,
        element: (
          <AdminOnly home>
            <HomePage />
          </AdminOnly>
        ),
      },
      // Everyone: asking for access, and deciding what names you (spec 004).
      { path: 'requests', element: <RequestsPage /> },
      { path: 'access/requests/:ref', element: <RequestPage /> },
      // Administrators.
      ...(
        [
          ['health', <HealthPage />],
          ['people', <PeoplePage />],
          ['people/:id', <PersonPage />],
          ['agents', <AgentsPage />],
          ['groups', <GroupsPage />],
          ['groups/:id', <GroupPage />],
          ['grants', <GrantsPage />],
          ['catalog', <CatalogPage />],
          ['applications', <ApplicationsPage />],
          ['events', <EventsPage />],
          ['provisioning', <ProvisioningPage />],
          ['provisioning/:id', <ProvisioningTargetPage />],
          ['audit', <AuditLogPage />],
          ['settings', <SettingsPage />],
        ] as const
      ).map(([path, page]) => ({ path, element: <AdminOnly>{page}</AdminOnly> })),
      ...ALL_PAGES.filter(isUpcoming).map((item) => ({
        path: item.href.slice(1),
        element: (
          <AdminOnly>
            <UpcomingPage item={item} />
          </AdminOnly>
        ),
      })),
      { path: '*', element: <NotFoundPage /> },
    ],
  },
];
