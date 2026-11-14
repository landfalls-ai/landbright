import { describe, expect, it } from 'vitest';
import { hostOf, loadConfig, passkeyRelyingParty } from '../src/config';

describe('loadConfig', () => {
  it('runs with no environment at all, on the development defaults', () => {
    const config = loadConfig({});
    expect(config.LANDBRIGHT_CONTROL_PORT).toBe(4401);
    expect(config.LANDBRIGHT_IDP_PORT).toBe(4402);
    expect(config.LANDBRIGHT_DATABASE_URL).toContain('landbright_app:');
    expect(config.LANDBRIGHT_DATABASE_ADMIN_URL).toContain('landbright:landbright-dev-only@');
  });

  it('coerces ports from strings', () => {
    expect(loadConfig({ LANDBRIGHT_CONTROL_PORT: '5000' }).LANDBRIGHT_CONTROL_PORT).toBe(5000);
  });

  it('names every invalid variable', () => {
    expect(() => loadConfig({ LANDBRIGHT_IDP_URL: 'not a url', LANDBRIGHT_IDP_PORT: '-1' })).toThrow(
      /LANDBRIGHT_IDP_PORT[\s\S]*LANDBRIGHT_IDP_URL|LANDBRIGHT_IDP_URL[\s\S]*LANDBRIGHT_IDP_PORT/,
    );
  });
});

describe('hostOf', () => {
  it('drops credentials and path', () => {
    expect(hostOf('postgres://user:secret@db.local:5432/app')).toBe('db.local:5432');
  });
});

describe('passkeyRelyingParty', () => {
  it('is the identity plane host and origin', () => {
    expect(passkeyRelyingParty(loadConfig({}))).toEqual({ id: 'localhost', origin: 'http://localhost:4402' });
    expect(passkeyRelyingParty({ LANDBRIGHT_IDP_URL: 'https://id.example.com/' })).toEqual({
      id: 'id.example.com',
      origin: 'https://id.example.com',
    });
  });

  it('is off for IP addresses, which WebAuthn refuses', () => {
    expect(passkeyRelyingParty({ LANDBRIGHT_IDP_URL: 'http://127.0.0.1:4402' })).toBeUndefined();
    expect(passkeyRelyingParty({ LANDBRIGHT_IDP_URL: 'http://[::1]:4402' })).toBeUndefined();
  });
});
