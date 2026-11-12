import { describe, expect, it } from 'vitest';
import { CLAIMS } from '../src/oidc/account';
import { esc } from '../src/pages/html';
import { invitePage, loginPage } from '../src/pages/pages';

/** The identity plane's pages are server-rendered strings: everything interpolated must come out escaped. */
describe('idp pages', () => {
  it('escapes what it interpolates', () => {
    expect(esc('<script>"&\'')).toBe('&lt;script&gt;&quot;&amp;&#39;');
    const page = loginPage({
      action: '/interaction/x/login',
      clientName: '<img src=x onerror=alert(1)>',
      email: '"><b>',
      abort: '/interaction/x/abort',
    });
    expect(page).not.toContain('<img');
    expect(page).not.toContain('"><b>');
    expect(page).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('shows an error only when there is one', () => {
    expect(loginPage({ action: '/a', abort: '/b' })).not.toContain('role="alert"');
    expect(loginPage({ action: '/a', abort: '/b', error: 'Wrong email or password.' })).toContain(
      'Wrong email or password.',
    );
  });

  it('asks for a password of at least 12 characters on the invite page', () => {
    expect(invitePage({ action: '/invite/t', name: 'Maya', email: 'maya@example.test' })).toContain('minlength="12"');
  });

  it('puts group names in the roles scope, for Landflow’s role map', () => {
    expect(CLAIMS.roles).toEqual(['roles', 'groups']);
  });
});
