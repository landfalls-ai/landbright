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
- [concept/index.html](concept/index.html): the concept page with suggestions and mockups.

## Reference

- [reference/api.md](reference/api.md): every HTTP route.
- [reference/configuration.md](reference/configuration.md): every environment variable.

## Feature map

| Feature | Page | Spec | Wave |
|---|---|---|---|
| Services, console shell, local stack, health, tracing | [development.md](development.md), [architecture.md](architecture.md) | [001-foundations](../specs/001-foundations/spec.md) | 0 ✓ |
| People, agents, groups, OIDC sign-in | | | 1 |
| SCIM provisioning to Landflow and Landfall | | | 2 |
| Landflow plugins (`landbright`, `hris`), HR lifecycle | | | 3 |
| Just-in-time access: catalog, policies, requests, grants | | | 4 |
| Agentic identity: sync, sponsors, token exchange, ID-JAG | | | 5 |
| OpenFGA, AuthZEN, access reviews, Landfall break-glass | | | 6 |
