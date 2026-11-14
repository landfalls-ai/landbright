import { describe, expect, it } from 'vitest';
import { auditHash, canonical, GENESIS_HASH, verifyAuditChain } from '../src/audit';
import { hashPassword, verifyPassword } from '../src/passwords';

function chain(n: number) {
  const rows = [];
  let prev = GENESIS_HASH;
  for (let i = 0; i < n; i++) {
    const row = {
      id: BigInt(i + 1),
      tenantId: 't',
      at: new Date(1_800_000_000_000 + i),
      actorId: null,
      actorLabel: 'x',
      action: 'a',
      targetType: 't',
      targetId: null,
      data: { i },
    };
    const hash = auditHash(prev, row);
    rows.push({ ...row, prevHash: prev, hash });
    prev = hash;
  }
  return rows;
}

describe('canonical', () => {
  it('sorts keys at every level', () => {
    expect(canonical({ b: 1, a: { d: 2, c: [3, { f: 4, e: 5 }] } })).toBe('{"a":{"c":[3,{"e":5,"f":4}],"d":2},"b":1}');
  });
});

describe('verifyAuditChain', () => {
  it('accepts an intact chain', () => {
    expect(verifyAuditChain(chain(5), GENESIS_HASH)).toBeUndefined();
  });
  it('finds an edited event', () => {
    const rows = chain(5);
    rows[2] = { ...rows[2]!, data: { i: 99 } };
    expect(verifyAuditChain(rows, GENESIS_HASH)).toBe(3n);
  });
  it('finds a deleted event', () => {
    const rows = chain(5);
    rows.splice(1, 1);
    expect(verifyAuditChain(rows, GENESIS_HASH)).toBe(3n);
  });
});

describe('passwords', () => {
  it('verifies the right password only', async () => {
    const hashed = await hashPassword('correct horse battery');
    expect(hashed.startsWith('$argon2id$')).toBe(true);
    expect(await verifyPassword(hashed, 'correct horse battery')).toBe(true);
    expect(await verifyPassword(hashed, 'wrong')).toBe(false);
    expect(await verifyPassword('not a hash', 'x')).toBe(false);
  });
});
