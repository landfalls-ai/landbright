import type { RouteObject } from 'react-router';
import { AppShell } from './components/shell/app-shell';
import { ALL_PAGES, isUpcoming } from './nav';
import { AgentsPage } from './routes/agents';
import { ApplicationsPage } from './routes/applications';
import { AuditLogPage } from './routes/audit';
import { GroupPage } from './routes/group';
import { GroupsPage } from './routes/groups';
import { HealthPage } from './routes/health';
import { HomePage } from './routes/home';
import { NotFoundPage } from './routes/not-found';
import { PeoplePage } from './routes/people';
import { PersonPage } from './routes/person';
import { SettingsPage } from './routes/settings';
import { UpcomingPage } from './routes/upcoming';

export const routes: RouteObject[] = [
  {
    element: <AppShell />,
    children: [
      { index: true, element: <HomePage /> },
      { path: 'health', element: <HealthPage /> },
      { path: 'people', element: <PeoplePage /> },
      { path: 'people/:id', element: <PersonPage /> },
      { path: 'agents', element: <AgentsPage /> },
      { path: 'groups', element: <GroupsPage /> },
      { path: 'groups/:id', element: <GroupPage /> },
      { path: 'applications', element: <ApplicationsPage /> },
      { path: 'audit', element: <AuditLogPage /> },
      { path: 'settings', element: <SettingsPage /> },
      ...ALL_PAGES.filter(isUpcoming).map((item) => ({
        path: item.href.slice(1),
        element: <UpcomingPage item={item} />,
      })),
      { path: '*', element: <NotFoundPage /> },
    ],
  },
];
