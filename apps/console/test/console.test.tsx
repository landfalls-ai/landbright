import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuditPage, Person } from '@landbright/contracts';
import { ADMIN, calls, renderAt, report } from './render';

const GROUP = {
  id: '00000000-0000-4000-8000-0000000000a1',
  name: 'Landflow Editors',
  description: null,
  kind: 'static' as const,
  memberCount: 0,
  system: false,
  createdAt: '2026-11-12T10:00:00.000Z',
};

function person(overrides: Partial<Person> = {}): Person {
  return {
    id: '00000000-0000-4000-8000-0000000000b1',
    kind: 'person',
    displayName: 'Maya Cohen',
    email: 'maya@example.test',
    status: 'active',
    givenName: 'Maya',
    familyName: 'Cohen',
    department: 'Engineering',
    title: null,
    site: null,
    manager: null,
    startDate: null,
    endDate: null,
    groups: [{ id: GROUP.id, name: GROUP.name }],
    hasPassword: false,
    createdAt: '2026-11-12T10:00:00.000Z',
    updatedAt: '2026-11-12T10:00:00.000Z',
    ...overrides,
  };
}

describe('Signing in to the console', () => {
  afterEach(() => vi.restoreAllMocks());

  it('sends someone without a session to sign in, coming back to the same page', async () => {
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign, pathname: '/people', search: '' });
    renderAt('/people', report(), { me: 401 });
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/api/auth/login?returnTo=%2Fpeople'));
    expect(screen.getByText('Signing you in…')).toBeInTheDocument();
  });

  it('offers to try again when sign-in failed, instead of looping', async () => {
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign });
    renderAt('/?signin=failed', report(), { me: 401 });
    expect(await screen.findByText('Sign-in didn’t finish')).toBeInTheDocument();
    expect(assign).not.toHaveBeenCalled();
  });

  it('keeps people who aren’t administrators out', async () => {
    renderAt('/', report(), { me: { ...ADMIN, admin: false, email: 'maya@example.test' } });
    expect(await screen.findByText('The console is for administrators')).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Main' })).not.toBeInTheDocument();
  });

  it('shows who is signed in', async () => {
    renderAt('/', report());
    expect(await screen.findByTestId('user-menu')).toHaveTextContent('Ada Admin');
    expect(screen.getByTestId('user-menu')).toHaveTextContent('AA');
  });
});

describe('People', () => {
  it('lists people with their groups and whether they have set a password', async () => {
    renderAt('/people', report(), { routes: { '/api/people': { items: [person()] } } });
    const row = await screen.findByTestId('person-maya@example.test');
    expect(row).toHaveTextContent('Maya Cohen');
    expect(row).toHaveTextContent('Landflow Editors');
    expect(row).toHaveTextContent('Invited');
    expect(row).toHaveTextContent('Active');
  });

  it('adds a person in a group and sends the invite', async () => {
    renderAt('/people', report(), {
      routes: {
        '/api/groups': { items: [GROUP] },
        'POST /api/people': () => person(),
        [`/api/people/${person().id}`]: person(),
      },
    });
    fireEvent.click((await screen.findAllByRole('button', { name: /Add person/ }))[0]!);
    const dialog = await screen.findByRole('dialog', { name: 'Add a person' });
    fireEvent.change(within(dialog).getByLabelText('First name'), { target: { value: 'Maya' } });
    fireEvent.change(within(dialog).getByLabelText('Last name'), { target: { value: 'Cohen' } });
    fireEvent.change(within(dialog).getByLabelText('Work email'), { target: { value: 'maya@example.test' } });
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Landflow Editors' }));
    fireEvent.submit(dialog);
    await waitFor(() => expect(calls.find((c) => c.key === 'POST /api/people')).toBeDefined());
    expect(calls.find((c) => c.key === 'POST /api/people')!.body).toEqual({
      givenName: 'Maya',
      familyName: 'Cohen',
      email: 'maya@example.test',
      groupIds: [GROUP.id],
      sendInvite: true,
    });
    expect(await screen.findByRole('heading', { name: /Maya Cohen/ })).toBeInTheDocument();
  });

  it('shows the error control gives, in the dialog', async () => {
    renderAt('/people', report(), {
      routes: {
        'POST /api/people': () =>
          new Response(
            JSON.stringify({ statusCode: 409, message: 'Someone with that email is already in the directory.' }),
            { status: 409 },
          ),
      },
    });
    fireEvent.click((await screen.findAllByRole('button', { name: /Add person/ }))[0]!);
    const dialog = await screen.findByRole('dialog', { name: 'Add a person' });
    fireEvent.change(within(dialog).getByLabelText('First name'), { target: { value: 'Maya' } });
    fireEvent.change(within(dialog).getByLabelText('Work email'), { target: { value: 'maya@example.test' } });
    fireEvent.submit(dialog);
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Someone with that email is already in the directory.',
    );
  });
});

describe('Applications', () => {
  it('shows the new secret once, with Landflow’s settings', async () => {
    renderAt('/applications', report(), {
      routes: {
        '/api/groups': { items: [GROUP] },
        'POST /api/applications': (body: unknown) => ({
          application: {
            id: '00000000-0000-4000-8000-0000000000c1',
            clientId: 'landflow',
            name: (body as { name: string }).name,
            redirectUris: (body as { redirectUris: string[] }).redirectUris,
            postLogoutRedirectUris: [],
            grantTypes: ['authorization_code', 'refresh_token'],
            system: false,
            secretVersion: 1,
            createdAt: '2026-11-12T10:00:00.000Z',
            updatedAt: '2026-11-12T10:00:00.000Z',
          },
          clientSecret: 'the-secret-shown-once',
          issuer: 'http://127.0.0.1:4402/oidc',
        }),
      },
    });
    fireEvent.click((await screen.findAllByRole('button', { name: /Register application/ }))[0]!);
    const dialog = await screen.findByRole('dialog', { name: 'Register an application' });
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Landflow' } });
    fireEvent.change(within(dialog).getByLabelText(/Redirect URIs/), {
      target: { value: 'http://localhost:3000/api/auth/oidc/callback' },
    });
    fireEvent.submit(dialog);
    expect(await screen.findByTestId('client-secret')).toHaveTextContent('the-secret-shown-once');
    const settings = screen.getByText(/LANDFLOW_OIDC_ISSUER/);
    expect(settings).toHaveTextContent('LANDFLOW_OIDC_CLIENT_ID=landflow');
    expect(settings).toHaveTextContent('LANDFLOW_OIDC_SCOPES="openid email profile roles"');
    await waitFor(() => expect(settings).toHaveTextContent('LANDFLOW_OIDC_ROLE_MAP="Landflow Editors=member"'));
    expect(calls.find((c) => c.key === 'POST /api/applications')!.body).toMatchObject({
      redirectUris: ['http://localhost:3000/api/auth/oidc/callback'],
    });
  });
});

describe('Audit log', () => {
  const page = (chainIntact: boolean): AuditPage => ({
    items: [
      {
        id: '7',
        at: '2026-11-12T10:00:00.000Z',
        actorId: ADMIN.id,
        actorLabel: 'Ada Admin',
        action: 'identity.deactivated',
        targetType: 'identity',
        targetId: 'x',
        data: { sessionsAndTokensRevoked: 3 },
        hash: 'ab'.repeat(32),
      },
    ],
    nextBefore: null,
    chainIntact,
  });

  it('shows each event and that the chain is intact', async () => {
    renderAt('/audit', report(), { routes: { '/api/audit': page(true) } });
    expect(await screen.findByTestId('event-identity.deactivated')).toHaveTextContent('Identity deactivated');
    expect(screen.getByText('Chain intact')).toBeInTheDocument();
  });

  it('says so when the chain is broken', async () => {
    renderAt('/audit', report(), { routes: { '/api/audit': page(false) } });
    expect(await screen.findByText('Chain broken')).toBeInTheDocument();
  });
});
