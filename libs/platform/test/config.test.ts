import { describe, expect, it } from 'vitest';
import { hostOf, loadConfig } from '../src/config';

describe('loadConfig', () => {
  it('runs with no environment at all, on the development defaults', () => {
    const config = loadConfig({});
    expect(config.LANDBRIGHT_CONTROL_PORT).toBe(4401);
    expect(config.LANDBRIGHT_IDP_PORT).toBe(4402);
    expect(config.LANDBRIGHT_DATABASE_URL).toContain('127.0.0.1:57432');
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
