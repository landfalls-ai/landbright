import { describe, expect, it } from 'vitest';
import { plugin } from '../src/main';

describe('the hris plugin', () => {
  it('declares its nodes and credential', () => {
    expect(plugin.info.id).toBe('hris');
    expect(plugin.nodes.map((n) => n.description.name)).toEqual(['hibobTrigger', 'hibob']);
    expect(plugin.credentialTypes?.map((c) => c.name)).toEqual(['hibobApi']);
  });
});
