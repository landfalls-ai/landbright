/**
 * Just enough of a browser: a cookie jar (cookies are per host, not per port, as in a real browser: the identity plane
 * is on localhost, control on 127.0.0.1), manual redirects, and form posts.
 */
export class Browser {
  private readonly jar = new Map<string, Map<string, string>>();

  async fetch(url: string, init: RequestInit = {}): Promise<Response> {
    const target = new URL(url);
    const cookies = [...(this.jar.get(target.hostname) ?? new Map()).entries()].map(([k, v]) => `${k}=${v}`).join('; ');
    const headers = new Headers(init.headers);
    if (cookies) headers.set('cookie', cookies);
    const response = await fetch(target, { ...init, headers, redirect: 'manual' });
    for (const line of response.headers.getSetCookie()) this.store(target.hostname, line);
    return response;
  }

  /** Follows redirects until `stop` matches the next location (returned unfollowed) or a page is reached. */
  async navigate(
    url: string,
    init: RequestInit = {},
    stop?: (location: URL) => boolean,
  ): Promise<{ response: Response; url: string }> {
    let current = url;
    let response = await this.fetch(current, init);
    for (let hops = 0; hops < 20 && response.status >= 300 && response.status < 400; hops++) {
      const next = new URL(response.headers.get('location')!, current);
      if (stop?.(next)) return { response, url: next.href };
      current = next.href;
      response = await this.fetch(current);
    }
    return { response, url: current };
  }

  /** Submits a form as a browser would (urlencoded), from a page on `pageUrl`. */
  submit(pageUrl: string, action: string, fields: Record<string, string>, stop?: (location: URL) => boolean) {
    const target = new URL(action, pageUrl);
    return this.navigate(
      target.href,
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', origin: target.origin },
        body: new URLSearchParams(fields).toString(),
      },
      stop,
    );
  }

  cookie(host: string, name: string): string | undefined {
    return this.jar.get(host)?.get(name);
  }

  private store(host: string, line: string): void {
    const [pair, ...attributes] = line.split(';');
    const index = pair!.indexOf('=');
    const name = pair!.slice(0, index).trim();
    const value = pair!.slice(index + 1).trim();
    const expired = attributes.some((a) => {
      const [k, v] = a.split('=').map((s) => s.trim().toLowerCase());
      return (k === 'max-age' && Number(v) <= 0) || (k === 'expires' && Date.parse(v ?? '') < Date.now());
    });
    const cookies = this.jar.get(host) ?? new Map<string, string>();
    if (expired || value === '') cookies.delete(name);
    else cookies.set(name, value);
    this.jar.set(host, cookies);
  }
}

/** The `action` of the page's first form. */
export function formAction(html: string): string {
  const match = /<form[^>]*action="([^"]+)"/.exec(html);
  if (!match) throw new Error(`No form on the page:\n${html.slice(0, 500)}`);
  return match[1]!.replace(/&amp;/g, '&').replace(/&#x2F;|&#47;/g, '/');
}
