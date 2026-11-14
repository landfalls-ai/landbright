# Landbright docs

Landbright is the identity provider of the land-\* family, for people and AI agents. Landflow is its just-in-time
access engine; Landfall signs in with it.

## Start here

- [plan.md](plan.md): what we are building, how it connects to Landflow and Landfall, the flows, the data model, the
  UI, the stack, the method and the waves. [research.md](research.md) has the evidence behind it.
- [development.md](development.md): setup, ports, every command, how tests are organized.
- [architecture.md](architecture.md): the processes, what each owns, and a code map.
- [roadmap.md](roadmap.md) (what each wave builds), [limitations.md](limitations.md) (what is missing now),
  [history.md](history.md) (every change in order).
- [suite.md](suite.md): diagrams of how Landbright, Landflow and Landfall work together, and of Landbright's own
  processes. [screens.md](screens.md): every screen of the current wave.
- [concept/index.html](concept/index.html): the concept page with suggestions and mockups.

## Features

- [sign-in.md](sign-in.md): the OIDC provider, sign-in, passwords, the console's sign-in, connecting Landflow.
- [directory.md](directory.md): people, agents, groups, applications, the audit log.
- [account.md](account.md): the account page, required actions, *forgot password*, recovery codes, and how strong a
  sign-in an application needs (`acr`).
- [access.md](access.md): just-in-time access: bundles, policies, requests, decisions, grants and their targets.
- [events.md](events.md): every audit event out to Landflow, signed with Landbright's key; waking a waiting flow.
- [provisioning.md](provisioning.md): SCIM to Landflow, Landfall and Clickland: who is pushed, deactivation within
  seconds, groups and just-in-time access, retries and reconciliation; back-channel logout for any application; a
  grant's pushes.
- [agents.md](agents.md): agents' own applications (`private_key_jwt`), token exchange with `act`, CIBA through
  Landflow, the device grant, PAR and DPoP.
- [hr.md](hr.md): people from HR: HiBob's events through two Landflow plugins (`hris`, `landbright`), pre-hires and
  start dates, the person's source.
- [landflow-flows.md](landflow-flows.md): the Landflow flows that run the approval conversation, provisioning and the
  inactive-people lifecycle, and how to install them.

## Reference

- [reference/api.md](reference/api.md): every HTTP route.
- [reference/configuration.md](reference/configuration.md): every environment variable.

## Feature map

| Feature | Page | Spec | Wave |
|---|---|---|---|
| Services, console shell, local stack, health, tracing | [development.md](development.md), [architecture.md](architecture.md) | [001-foundations](../specs/001-foundations/spec.md) | 0 ✓ |
| People, agents, groups, applications, audit, OIDC sign-in | [sign-in.md](sign-in.md), [directory.md](directory.md) | [002-identity-core](../specs/002-identity-core/spec.md) | 1 (first slice ✓) |
| SCIM provisioning to Landflow, Landfall and Clickland | [provisioning.md](provisioning.md) | [006-provisioning-out](../specs/006-provisioning-out/spec.md) | 2 (✓) |
| Landflow plugins (`landbright`, `hris`), HR lifecycle | [hr.md](hr.md) | [007-hr-lifecycle](../specs/007-hr-lifecycle/spec.md) | 3 (first slice ✓) |
| Access requests, the Landbright Trigger, approval flows in Landflow | | [003-access-requests-and-approvals](../specs/003-access-requests-and-approvals/spec.md) (design; first slice built by 004) | 3–4 |
| Just-in-time access, events out, the machine API, Landflow flows (from the Keycloak and open-source JIT studies) | [access.md](access.md), [events.md](events.md), [landflow-flows.md](landflow-flows.md) | [004-access-and-events](../specs/004-access-and-events/spec.md) | 4 (first slice ✓) |
| Access follow-ups (extensions, chat votes, service requests), the identity plane's next pages, agents | [access.md](access.md), [account.md](account.md), [landflow-flows.md](landflow-flows.md) | [005-follow-ups](../specs/005-follow-ups/spec.md) | 4–5 (slices 1–3 ✓) |
| Agentic identity: agents' applications, token exchange, CIBA, device grant, DPoP | [agents.md](agents.md) | [005-follow-ups](../specs/005-follow-ups/spec.md) (slice 3) | 5 (brought forward ✓) |
| Agentic identity: sync, ID-JAG, workload identity | | | 5 |
| OpenFGA, AuthZEN, access reviews, Landfall break-glass | | | 6 |
