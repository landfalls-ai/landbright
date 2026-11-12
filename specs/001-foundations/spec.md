# Feature 001: Foundations (wave 0)

**Status**: implemented 2026-11-12 · **Plan**: [plan.md](plan.md) · **Tasks**: [tasks.md](tasks.md)

## Why

Every later wave needs the same ground: two services with the security defaults already on, a console that already
looks like Landflow, the local infrastructure, tracing, and one command that says whether a change is good. Building
these once, before any identity code, keeps the first identity feature about identity.

## User stories

1. **As a developer**, I run `pnpm dev:up && pnpm serve` on a fresh checkout and get the identity plane, the control
   API and the console, with no `.env` to write.
2. **As an operator**, I open the console's Health page and see each dependency (identity plane, Postgres, Valkey,
   OpenBao, Mailpit) with its address, version and latency, refreshed every 5 seconds. When one is down, the page says
   which one and why.
3. **As someone who uses Landflow**, the console has Landflow's shell, tokens, type and primitives, in light and dark.
4. **As a reviewer**, `pnpm verify` tells me in one command whether a change type-checks, lints, passes its tests and
   builds.

## Acceptance

- A fresh checkout with no `.env` serves on 127.0.0.1:4400 (console), :4401 (control), :4402 (idp).
- `GET /api/health` reports the five components; stopping Valkey shows it down with a reason within one refresh, and
  starting it again shows it up.
- Every route not marked `@Public()` answers 401.
- `@land/tokens` matches Landflow's `globals.css` token blocks byte for byte, checked by a test.
- `OTEL_TRACES_EXPORTER=console` prints spans with `service.name` = `landbright-idp` / `landbright-control`.
- The infrastructure runs as the `landbright-infra` compose project only, bound to 127.0.0.1, on ports that don't
  collide with Landflow's.

## Out of scope

Authentication, tenants, any table, the OIDC provider (wave 1); Kubernetes manifests for `landbright-dev`; the
Playwright and conformance suites (they arrive with something to test).
