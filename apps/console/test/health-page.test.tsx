import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderAt, report } from './render';

describe('Health page', () => {
  it('lists every component with its version and address, and counts control as up', async () => {
    renderAt('/health', report());
    const postgres = await screen.findByTestId('component-postgres');
    expect(screen.getByTestId('health-summary')).toHaveTextContent('All systems up');
    expect(within(postgres).getByText('PostgreSQL 16.10')).toBeInTheDocument();
    expect(within(postgres).getByText('127.0.0.1:57432')).toBeInTheDocument();
    expect(screen.getByTestId('component-control')).toHaveTextContent('landbright-control 0.1.0');
  });

  it('shows a component that is down, and why', async () => {
    renderAt(
      '/health',
      report({
        status: 'degraded',
        components: [
          {
            id: 'valkey',
            name: 'Valkey',
            kind: 'cache',
            status: 'down',
            latencyMs: 0.4,
            target: '127.0.0.1:57379',
            detail: 'not connected (reconnecting)',
          },
          {
            id: 'postgres',
            name: 'Postgres',
            kind: 'database',
            status: 'up',
            latencyMs: 1.2,
            target: '127.0.0.1:57432',
            detail: 'PostgreSQL 16.10',
          },
        ],
      }),
    );
    await screen.findByTestId('component-valkey');
    expect(screen.getByTestId('health-summary')).toHaveTextContent('1 of 3 down');
    expect(within(screen.getByTestId('component-valkey')).getByText('not connected (reconnecting)')).toHaveClass(
      'text-rd',
    );
  });

  it('says how to start control when it does not answer', async () => {
    renderAt('/health', 'unreachable');
    expect(await screen.findByText('Can’t reach the control API')).toBeInTheDocument();
    expect(screen.getByTestId('health-line')).toHaveTextContent('Control unreachable');
  });
});
