# Landbright

The identity provider of the land-\* family, for people and AI agents. A pnpm + Nx monorepo: `apps/idp` (NestJS, the
protocol plane: OIDC/OAuth, sign-in, JWKS), `apps/control` (NestJS, the console API, directory, access ledger),
`apps/console` (React 19 + Vite, Landflow's look), `libs/contracts` (zod wire contracts), `libs/platform` (what every
service shares: config, bootstrap, default-deny guard, health probes, telemetry), `libs/tokens` (`@land/tokens`, the
design tokens shared with Landflow), and `deploy/` (compose infrastructure).

## Read first

- `docs/README.md`: the docs index and the feature map.
- `docs/plan.md`: what Landbright is, how it connects to Landflow and Landfall, the waves. `docs/research.md`: the
  evidence.
- `docs/development.md`: setup, ports, every command. `docs/architecture.md`: the processes and the code map.
- `.specify/memory/constitution.md`: the nine principles. Every feature plan fills its Constitution Check.
- `docs/limitations.md` and `docs/roadmap.md`: what is missing and what each wave built; `docs/history.md`: every
  change in order.

## Method

- Spec-driven (from Landfall): a feature starts as `specs/NNN-name/` (spec, plan with the Constitution Check, tasks),
  using `.specify/templates/`. The plan gets a senior design review that checks its claims against the live Landflow
  and Landfall source before tasks are written.
- Docs move with the code (from Landflow): every change updates its feature page, `docs/reference/` for routes and
  variables, `docs/limitations.md` and `docs/roadmap.md` when it adds, closes or lifts something, and gets a row in
  `docs/history.md`. New pages go in `docs/README.md`.
- Waves (from Landflow): a wave ends with `pnpm verify` green, a live check on the local stack and in the browser, and
  its bugs fixed in the same wave.

## Conventions

- Every route is closed by `DefaultDenyGuard` unless marked `@Public()`, with a comment saying why.
- Request and response shapes live in `libs/contracts` as zod schemas; control validates and serializes with
  `nestjs-zod`, which also generates `/api/openapi.json`.
- Nest code keeps value imports for injected classes (type-only imports erase decorator metadata).
- Tests sit next to their package (`test/`). Tests against real services skip unless `LANDBRIGHT_INTEGRATION` names
  them (`infra`, or `all`).

## Checking a change

```bash
pnpm verify                     # typecheck, lint, test, build: every project
pnpm test:integration           # against the compose stack (pnpm dev:up first)
```

## Local only

- Run only on this machine: the OrbStack Docker engine (and later its Kubernetes cluster, `--context orbstack`,
  namespace `landbright-dev`). Never deploy to a cloud, and never push images.
- Use only the development credentials in `.env.example` and `deploy/.env.example`.
- Other projects' containers share this Docker engine: touch only the `landbright-*` compose projects (and later the
  `landbright-dev` namespace), and don't prune.
- Landflow and Landfall are separate repositories next to this one. Read them freely; change them only when asked.
