import type { RouteObject } from 'react-router';
import { AppShell } from './components/shell/app-shell';
import { ALL_PAGES } from './nav';
import { HealthPage } from './routes/health';
import { HomePage } from './routes/home';
import { NotFoundPage } from './routes/not-found';
import { UpcomingPage } from './routes/upcoming';

export const routes: RouteObject[] = [
  {
    element: <AppShell />,
    children: [
      { index: true, element: <HomePage /> },
      { path: 'health', element: <HealthPage /> },
      ...ALL_PAGES.filter((p) => p.href !== '/').map((item) => ({
        path: item.href.slice(1),
        element: <UpcomingPage item={item} />,
      })),
      { path: '*', element: <NotFoundPage /> },
    ],
  },
];
