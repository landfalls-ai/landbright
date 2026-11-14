import { logoutsOfSessions } from '@landbright/persistence';
import { describe, expect, it } from 'vitest';
import { LOGOUT_EVENT, logoutClaims, logoutRetryInMs } from '../src/logout/logout-sender';

describe('back-channel logout', () => {
  it('reads the (application, session) pairs of stored sessions', () => {
    expect(
      logoutsOfSessions([
        { accountId: 'p1', authorizations: { landflow: { sid: 's1', grantId: 'g' }, clickland: { sid: 's2' } } },
        { accountId: 'p2', authorizations: {} },
        { authorizations: { landflow: { sid: 's3' } } },
        { accountId: 'p3', authorizations: { landfall: {} } },
      ]),
    ).toEqual([
      { clientId: 'landflow', subject: 'p1', sid: 's1' },
      { clientId: 'clickland', subject: 'p1', sid: 's2' },
      { clientId: 'landfall', subject: 'p3', sid: null },
    ]);
  });

  it('makes logout token claims: sub, sid when known, a jti and the event, never a nonce', () => {
    expect(logoutClaims({ subject: 'p1', sid: 's1' }, 'j1')).toEqual({
      sub: 'p1',
      sid: 's1',
      jti: 'j1',
      events: { [LOGOUT_EVENT]: {} },
    });
    expect(logoutClaims({ subject: 'p1', sid: null }, 'j2')).toEqual({
      sub: 'p1',
      jti: 'j2',
      events: { [LOGOUT_EVENT]: {} },
    });
    expect(logoutClaims({ subject: 'p1', sid: null }).jti).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('waits 5 s, then doubles, up to an hour', () => {
    expect([1, 2, 3, 10, 20].map(logoutRetryInMs)).toEqual([5_000, 10_000, 20_000, 2_560_000, 3_600_000]);
  });
});
