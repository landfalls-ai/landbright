# History

Every change in order, newest first, with the decisions taken along the way. One row per commit.

| Date | Commit | Change |
|---|---|---|
| 2026-11-12 | first commit | **Wave 0: foundations** ([spec 001](../specs/001-foundations/spec.md)). Workspace, idp and control services, console, `@land/tokens`, contracts, platform, compose infrastructure, tracing, the verify gate, the constitution v1.0.0, these docs. Decisions: services are CommonJS (Landfall's setting; Node 22.12 can `require()` ESM-only `oidc-provider`); infrastructure on 57xxx ports, away from Landflow's; `/api/health` public until wave 1; Valkey without an offline queue so a down Valkey reports at once. |
| 2026-11-12 | first commit | Plan, research and the concept page (`docs/plan.md`, `docs/research.md`, `docs/concept/`). |
