# Implementation Plan: [FEATURE]

**Branch**: `[###-feature-name]` | **Date**: [DATE] | **Spec**: [link]
**Input**: Feature specification from `/specs/[###-feature-name]/spec.md`

**Note**: This template is filled in by the `/speckit-plan` command. See `.specify/templates/plan-template.md` for the execution workflow.

## Summary

[Extract from feature spec: primary requirement + technical approach from research]

## Technical Context

<!--
  ACTION REQUIRED: Replace the content in this section with the technical details
  for the project. The structure here is presented in advisory capacity to guide
  the iteration process.
-->

**Language/Version**: [e.g., Python 3.11, Swift 5.9, Rust 1.75 or NEEDS CLARIFICATION]  
**Primary Dependencies**: [e.g., FastAPI, UIKit, LLVM or NEEDS CLARIFICATION]  
**Storage**: [if applicable, e.g., PostgreSQL, CoreData, files or N/A]  
**Testing**: [e.g., pytest, XCTest, cargo test or NEEDS CLARIFICATION]  
**Target Platform**: [e.g., Linux server, iOS 15+, WASM or NEEDS CLARIFICATION]
**Project Type**: [e.g., library/cli/web-service/mobile-app/compiler/desktop-app or NEEDS CLARIFICATION]  
**Performance Goals**: [domain-specific, e.g., 1000 req/s, 10k lines/sec, 60 fps or NEEDS CLARIFICATION]  
**Constraints**: [domain-specific, e.g., <200ms p95, <100MB memory, offline-capable or NEEDS CLARIFICATION]  
**Scale/Scope**: [domain-specific, e.g., 10k users, 1M LOC, 50 screens or NEEDS CLARIFICATION]

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

Read `.specify/memory/constitution.md` and fill every row. **Evidence must cite the live source**
(a file, a symbol, a migration, a research decision) — not a restatement of the principle. A row
that cannot cite anything is a FAIL, not a PASS. Anything short of PASS needs a Complexity
Tracking entry below.

| Principle | Status | Evidence |
|---|---|---|
| I. Adopt protocol plumbing, build the identity core | | *What was adopted (OIDC engine, authorization engine, key storage); what identity-core code is built and why `research.md` rejected the alternatives.* |
| II. Default deny, least privilege | | *Every new route is guarded (`DefaultDenyGuard`, `@Public()` only where cited); every new grant path has an end (`expiresAt`); RLS on every new table.* |
| III. Every identity has an accountable human | | *How a new agent or service identity gets a sponsor; what happens when the sponsor leaves.* |
| IV. Policy or a person approves; an agent never does | | *Who can decide each new request kind; the check that stops self-approval and agent approval.* |
| V. Event-sourced ledger, tamper-evident audit | | *Events appended; projections rebuildable; outbox for every outbound event.* |
| VI. Standards on the wire | | *The RFC/spec each new endpoint or message follows; any proprietary shape and why no standard fits.* |
| VII. Stateless, multi-tenant, N-up safe | | *No in-process state; background work under a Valkey lock or queue; `tenantId` on every new row.* |
| VIII. Spec-driven, test-backed | | *Contracts in `libs/contracts`; unit + route + integration coverage; conformance suites that apply.* |
| IX. Local only | | *Runs on OrbStack only; development credentials from `.env.example`; nothing deployed or pushed.* |

**Integration Definition of Done** — fill only if this feature adds or materially changes an
externally-facing integration (an HR source, Landflow, Landfall, a JIT target, a protocol
client). All five are required for Done; mark PLANNED at gate time and PASS at implementation.

| Requirement | Status | Evidence |
|---|---|---|
| 1. Setup guide with screenshots | | *The `docs/` page and its entry in `docs/README.md`.* |
| 2. Reachable by agents | | *The Landbright node operation (usable as an AI tool) or MCP tool that exposes it.* |
| 3. Can trigger a Landflow flow | | *The Landbright Trigger event or Landflow trigger it emits.* |
| 4. `docs/architecture.md` updated | | *Updated, not forked.* |
| 5. Locally runnable with no real credentials | | *Mock/replay source, seeded from a read-only real capture where one is possible.* |

**Post-design re-check (after Phase 1)**: [unchanged | what moved, and why]

**Mandatory senior design review** (constitution v1.3.0): this plan MUST be reviewed by a more
capable model than its author before `/speckit.tasks`, explicitly checking every reuse and
mechanism claim above against the live source. Record the outcome here or in `research.md`:
[not yet run | run <date>, N findings, all fixed / deferred with reason]

## Project Structure

### Documentation (this feature)

```text
specs/[###-feature]/
├── plan.md              # This file (/speckit-plan command output)
├── research.md          # Phase 0 output (/speckit-plan command)
├── data-model.md        # Phase 1 output (/speckit-plan command)
├── quickstart.md        # Phase 1 output (/speckit-plan command)
├── contracts/           # Phase 1 output (/speckit-plan command)
└── tasks.md             # Phase 2 output (/speckit-tasks command - NOT created by /speckit-plan)
```

### Source Code (repository root)
<!--
  ACTION REQUIRED: Replace the placeholder tree below with the concrete layout
  for this feature. Delete unused options and expand the chosen structure with
  real paths (e.g., apps/admin, packages/something). The delivered plan must
  not include Option labels.
-->

```text
# [REMOVE IF UNUSED] Option 1: Single project (DEFAULT)
src/
├── models/
├── services/
├── cli/
└── lib/

tests/
├── contract/
├── integration/
└── unit/

# [REMOVE IF UNUSED] Option 2: Web application (when "frontend" + "backend" detected)
backend/
├── src/
│   ├── models/
│   ├── services/
│   └── api/
└── tests/

frontend/
├── src/
│   ├── components/
│   ├── pages/
│   └── services/
└── tests/

# [REMOVE IF UNUSED] Option 3: Mobile + API (when "iOS/Android" detected)
api/
└── [same as backend above]

ios/ or android/
└── [platform-specific structure: feature modules, UI flows, platform tests]
```

**Structure Decision**: [Document the selected structure and reference the real
directories captured above]

## Complexity Tracking

> **Fill ONLY if Constitution Check has violations that must be justified**

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| [e.g., 4th project] | [current need] | [why 3 projects insufficient] |
| [e.g., Repository pattern] | [specific problem] | [why direct DB access insufficient] |
