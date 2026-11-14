import { describe, expect, it } from 'vitest';
import { plugin } from '../src/main';

describe('the landbright plugin', () => {
  it('declares its node and credential', () => {
    expect(plugin.info.id).toBe('landbright');
    expect(plugin.nodes.map((n) => n.description.name)).toEqual(['landbright']);
    expect(plugin.credentialTypes?.map((c) => c.name)).toEqual(['landbrightApi']);
  });
});
