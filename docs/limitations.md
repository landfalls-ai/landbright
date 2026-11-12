# Limitations

What Landbright doesn't do yet, and what each item waits for. [roadmap.md](roadmap.md) has the order.

## Now (after wave 0)

- **No identities, no sign-in, no tenants.** The directory, the OIDC provider and the console's sign-in arrive in
  wave 1. Every page except Home and Health is a placeholder that says what it will do.
- **`GET /api/health` is public.** It shows local addresses and dependency versions (never credentials) so the console
  can show it before sign-in exists. Wave 1 restricts it to administrators; `/healthz` stays public.
- **No Kubernetes manifests.** The plan's `landbright-dev` namespace on OrbStack comes when there is something worth
  running there; compose and `pnpm serve` cover development.
- **No browser or conformance suites yet.** Playwright and the OpenID conformance suite arrive in wave 1 with sign-in.
- **The console is one bundle** (~160 kB gzip). Route-level splitting waits until pages are real.
- **Tokens are a copy.** `@land/tokens` duplicates Landflow's `globals.css` blocks; a test catches drift until Landflow
  adopts the package.
- **The Landflow changes L1–L5** (plan §3.5) are not filed as Landflow specs yet.
