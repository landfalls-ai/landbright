import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderAt, report } from './render';

describe('Console shell', () => {
  it('groups the navigation as plan §6.2 does, and marks pages of later waves', async () => {
    renderAt('/', report());
    const nav = await screen.findByRole('navigation', { name: 'Main' });
    for (const group of ['Directory', 'Access', 'Connect', 'Govern'])
      expect(within(nav).getByText(group)).toBeInTheDocument();
    expect(within(nav).getByRole('link', { name: /Sources/ })).toHaveTextContent('w3');
    expect(within(nav).getByRole('link', { name: /Requests/ })).not.toHaveTextContent(/w\d/);
    expect(within(nav).getByRole('link', { name: /People/ })).not.toHaveTextContent(/w\d/);
    expect(within(nav).getByRole('link', { name: /Home/ })).not.toHaveTextContent(/w\d/);
  });

  it('shows the environment from the health report', async () => {
    renderAt('/', report({ environment: 'local' }));
    expect(await screen.findByTestId('environment-badge')).toHaveTextContent('local');
  });

  it('shows what a later page will do', async () => {
    renderAt('/sources', report());
    expect(await screen.findByText('Sources arrives in wave 3')).toBeInTheDocument();
  });

  it('has a not-found page', async () => {
    renderAt('/nope', report());
    expect(await screen.findByText('There’s no page here.')).toBeInTheDocument();
  });
});
