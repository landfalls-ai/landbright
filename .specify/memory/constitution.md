<!--
SYNC IMPACT REPORT (v1.0.0, 2026-11-12)
Version change: none to 1.0.0
Bump rationale: MAJOR. First ratification, from docs/plan.md §8.
Templates checked: plan-template.md (Constitution Check rows rewritten for these nine principles; Integration
Definition of Done adapted), spec-template.md, tasks-template.md: no change needed.
-->

# Landbright Constitution

Landbright is security infrastructure with a public protocol surface: the system of record for who exists and who
holds which access, until when, for people and AI agents. These principles bind every feature. A plan that cannot
meet one records the deviation in Complexity Tracking, and an accepted deviation is written here with its reason.

## Core Principles

### I. Adopt protocol plumbing, build the identity core

Adopt certified, maintained implementations for protocol plumbing: the OIDC/OAuth engine (`oidc-provider`), the
authorization engine (OpenFGA), key and secret storage (OpenBao). Build what makes Landbright itself: the agentic
identity model, the access ledger, the policy model and the Landflow integration. Building plumbing needs a
`research.md` entry that names the alternatives and why each was rejected.

### II. Default deny, least privilege, zero standing privilege as the goal

Every route is closed unless it is deliberately public (`@Public()`, with the reason next to it). Every grant has an
end (`expiresAt`); a standing grant needs an owner and a reason, and is reviewed. Every table carries `tenantId` under
row-level security.

### III. Every identity has an accountable human

No agent or service identity exists without a sponsor who is a person. When a sponsor leaves, their agents are
suspended until a new sponsor is named. An agent can never hold more than the person it acts for.

### IV. Policy or a person approves; an agent never does

Requests are approved by a policy a person wrote or by a person the policy names. Nobody approves their own request.
Agents can request access; they can never decide a request.

### V. Event-sourced ledger, tamper-evident audit

Requests and grants are projections of an append-only event log, so any past moment can be replayed. The audit log is
hash-chained. Outbound events leave through a transactional outbox: a webhook is sent if and only if its change
committed.

### VI. Standards on the wire

OIDC, OAuth 2.1, RFC 8693 token exchange, SCIM 2.0, SSF/CAEP, AuthZEN, Standard Webhooks, the MCP authorization
specification. Nothing proprietary where a standard exists; a proprietary shape names the gap it fills.

### VII. Stateless, multi-tenant, N-up safe

Processes hold no state that another replica would need. Background work runs under a Valkey lock or a queue. The
multi-tenant boundary is designed in from the first table, even while a deployment serves one tenant.

### VIII. Spec-driven and test-backed; conformance suites are tests

Features start as specs (`specs/NNN-name/`). Contracts live in `libs/contracts` and are authoritative. Every change
ships with unit and route tests, and integration tests against the real stack where it touches one. The OpenID
conformance suite and SCIM compliance runs are part of the test suite, not a launch checklist.

### IX. Local only

Landbright runs only on this machine: OrbStack's Docker engine and Kubernetes cluster. Nothing is deployed to a cloud
or pushed to a registry, and only the development credentials in `.env.example` and `deploy/.env.example` are used.

## Platform Constraints

- Stack (docs/plan.md §7): pnpm + Nx, Node 22, TypeScript 5.9, NestJS 11 for services, React 19 + Vite for the
  console, Postgres 16, Valkey, OpenBao.
- The console uses `@land/tokens` and Landflow's primitives, so moving between Landflow and Landbright shows no seam.
- Landflow owns everything that touches another system (HR intake, approvals in chat, provisioning); Landbright
  decides and remembers. Changes Landflow needs are filed as Landflow specs, never patched in from here.

## Development Workflow

specify → clarify → plan (Constitution Check) → senior design review against the live Landflow and Landfall source →
tasks → analyze → implement. Docs move with the code. A wave ends with `pnpm verify` green, a live check on the local
stack and in the browser, and its bugs fixed in the same wave.

## Governance

This constitution supersedes other practice. Amendments bump the version (MAJOR: a principle removed or redefined;
MINOR: a principle or section added; PATCH: a clarification or a recorded deviation) and add a Sync Impact Report at
the top.

**Version**: 1.0.0 | **Ratified**: 2026-11-12 | **Last Amended**: 2026-11-12
