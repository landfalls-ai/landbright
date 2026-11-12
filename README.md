# Landbright

**The identity provider of the land-\* family, for people and agents.** One directory for people and AI agents. It
provides the sign-in and tokens that Landflow and Landfall trust, and it is the system of record for who holds which
access and until when. [Landflow](../landflow/README.md) is its just-in-time access engine: requests, approvals,
provisioning, revocation and HR-driven joiner / mover / leaver flows run as Landflow workflows.

Status: **wave 0 (foundations) done**. The services, the console and the local stack run; identities and sign-in
come in wave 1 ([roadmap](docs/roadmap.md)).

```bash
pnpm install
pnpm dev:up      # Postgres, Valkey, Mailpit, OpenBao on 127.0.0.1 (compose project landbright-infra)
pnpm serve       # idp :4402, control :4401, console http://127.0.0.1:4400
pnpm verify      # typecheck, lint, test, build
```

- [docs/plan.md](docs/plan.md): what we are building, how it connects to Landflow and Landfall, the flows, data model,
  UI, stack, methodology and the waves.
- [docs/README.md](docs/README.md): the docs index; [development.md](docs/development.md) has every command and port.
- [docs/research.md](docs/research.md): the evidence: Landflow's and Landfall's identity and orchestration surfaces,
  HiBob and Shapes, Apono / Okta + Axiom / Entra Agent ID, the standards, and the build-or-adopt choice.
