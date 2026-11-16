import { describe, expect, it } from 'vitest';
import { plugin } from '../src/main';

describe('the gdirectory plugin', () => {
  it('declares its node and credential', () => {
    expect(plugin.info.id).toBe('gdirectory');
    expect(plugin.nodes.map((n) => n.description.name)).toEqual(['googleDirectory']);
    expect(plugin.credentialTypes?.map((c) => c.name)).toEqual(['googleDirectoryApi']);
  });
});
