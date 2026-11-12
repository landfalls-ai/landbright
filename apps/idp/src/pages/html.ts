import { STYLESHEET_HREF } from './stylesheet';
/** Escapes text for HTML. Every value that reaches a page goes through here or `attr`. */
export function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** A tagged template that escapes interpolations, except values wrapped in `raw()`. */
export function html(strings: TemplateStringsArray, ...values: unknown[]): string {
  return strings.reduce((out, s, i) => {
    if (i === 0) return s;
    const v = values[i - 1];
    const text =
      v instanceof Raw
        ? v.value
        : Array.isArray(v)
          ? v.map((x) => (x instanceof Raw ? x.value : esc(x))).join('')
          : esc(v);
    return out + text + s;
  }, '');
}

class Raw {
  constructor(readonly value: string) {}
}

export function raw(value: string): Raw {
  return new Raw(value);
}

/**
 * The frame every sign-in page shares: Landflow's tokens (served as /assets/signin.css), the product mark, no
 * script. The CSP comes from Helmet (main.ts).
 */
export function layout(title: string, body: string): string {
  return html`<!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="robots" content="noindex" />
        <title>${title} · Landbright</title>
        <link rel="stylesheet" href="${STYLESHEET_HREF}" />
      </head>
      <body>
        <main class="frame">
          <section class="card">${raw(body)}</section>
          <p class="foot">Landbright signs you in to your organization’s apps.</p>
        </main>
      </body>
    </html>`;
}
