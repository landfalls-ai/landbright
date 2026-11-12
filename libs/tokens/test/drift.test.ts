import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Landbright's tokens are a copy of Landflow's (plan §6.1). Until Landflow adopts @land/tokens, this test keeps the
 * copy honest: the token blocks must match Landflow's globals.css byte for byte (after the header comment). It skips
 * when the Landflow checkout isn't next to this repo; LANDFLOW_DIR points elsewhere.
 */
const landflowDir = process.env.LANDFLOW_DIR ?? resolve(import.meta.dirname, '../../../../landflow');
const globals = resolve(landflowDir, 'apps/web/src/app/globals.css');
const ours = readFileSync(resolve(import.meta.dirname, '../src/tokens.css'), 'utf8');

/** The three token blocks (light, dark by media query, dark by attribute): from the first `:root {` to `@theme`. */
function tokenBlocks(css: string): string {
  const start = css.indexOf(':root {');
  const end = css.indexOf('@theme inline');
  return css.slice(start, end === -1 ? undefined : end).trim();
}

describe('@land/tokens', () => {
  it('defines every token in light and both dark blocks', () => {
    const blocks = tokenBlocks(ours);
    for (const token of [
      '--bg',
      '--sf',
      '--t1',
      '--t2',
      '--t3',
      '--ac',
      '--on-ac',
      '--rd',
      '--gn',
      '--warn',
      '--viz-1',
    ]) {
      expect(blocks.split(`${token}:`).length - 1, token).toBe(3);
    }
  });

  it.skipIf(!existsSync(globals))('matches Landflow’s globals.css', () => {
    expect(tokenBlocks(ours)).toBe(tokenBlocks(readFileSync(globals, 'utf8')));
  });
});
