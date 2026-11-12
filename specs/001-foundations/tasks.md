# Tasks 001: Foundations

All done on 2026-11-12.

- [x] T001 Workspace: `package.json`, `pnpm-workspace.yaml`, `nx.json`, `tsconfig.base.json`, ESLint, Prettier.
- [x] T002 `deploy/compose.infra.yml` (`landbright-infra`): Postgres 16 (+ `landbright_test`), Valkey 8, Mailpit,
      OpenBao dev, all healthchecked; `deploy/.env.example`, `.env.example`.
- [x] T003 `@land/tokens` from Landflow's `globals.css`, with the drift test.
- [x] T004 `@landbright/contracts`: health schemas and `overallStatus`, with tests.
- [x] T005 `@landbright/platform`: config, `startService`, `DefaultDenyGuard`, `@Public()`, probes, liveness,
      telemetry, with tests.
- [x] T006 `apps/idp`: liveness, with a test.
- [x] T007 `apps/control`: infra module, `GET /api/health`, OpenAPI; unit and integration tests.
- [x] T008 `apps/console`: Landflow shell and primitives, Home, Health, placeholders for later pages; tests.
- [x] T009 Constitution v1.0.0, spec-kit templates adapted, `CLAUDE.md`, the docs skeleton.
- [x] T010 Live check: `pnpm dev:up && pnpm serve`, the Health page in the browser in light and dark, Valkey stopped
      and restarted, spans printed with `OTEL_TRACES_EXPORTER=console`.
