# Roadmap

The waves of [plan.md §9](plan.md#9-waves). Each wave ends with `pnpm verify` green, a live check on the local stack
and in the browser, and its bugs fixed in the same wave. The console's Home page shows the same list
(`apps/console/src/waves.ts`).

| Wave | Status | First slice |
|---|---|---|
| **0. Foundations** | ✓ Done 2026-11-12 ([spec 001](../specs/001-foundations/spec.md)) | `pnpm dev:up && pnpm serve` brings up a console in Landflow's shell with a health page |
| **1. Identity core and sign-in** | Next | A person created in the console signs into Landflow over OIDC and lands with the role their group maps to |
| **2. Provisioning out** | Planned | Deactivating a person signs them out of Landflow within seconds |
| **3. Landflow plugins and HR lifecycle** | Planned | A signed HiBob `employee.joined` creates the person and adds birthright groups |
| **4. Just-in-time access** | Planned | Editor on a Landflow project for 2 hours: requested, approved in Slack, granted, removed at expiry |
| **5. Agentic identity** | Planned | A Landflow agent gets 15 minutes of read access with its sponsor's approval; the token names both |
| **6. Policy, reviews, signals** | Planned | A sev1 Landfall incident gives the on-call responder the incident bundle until the room closes |

## Wave 0: what it built

Workspace (pnpm + Nx), `apps/idp` and `apps/control` (NestJS 11) with Helmet and a default-deny guard, the console
(React 19 + Vite, Landflow's shell and primitives) with Home and Health, `@land/tokens`, `@landbright/contracts`,
`@landbright/platform`, the `landbright-infra` compose stack (Postgres, Valkey, Mailpit, OpenBao), OpenTelemetry, the
`pnpm verify` gate, the constitution and the spec-kit templates, and these docs.
