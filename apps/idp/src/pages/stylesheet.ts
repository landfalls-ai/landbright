import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { SIGNIN_CSS } from './signin-css';

/** The sign-in pages' stylesheet: @land/tokens, then the pages' own rules. */
export const STYLESHEET = `${readFileSync(require.resolve('@land/tokens/tokens.css'), 'utf8')}\n${SIGNIN_CSS}`;

/** Its URL carries a hash of its content, so it can be cached for good and a new version is fetched at once. */
export const STYLESHEET_HREF = `/assets/signin.css?v=${createHash('sha256').update(STYLESHEET).digest('hex').slice(0, 12)}`;
