# The suite

How Landbright works with Landflow and Landfall, and what runs inside Landbright today. [plan.md](plan.md) §1 to §3
has the reasoning; this page has the pictures. They are also on the published page with every screen.

## Landbright, Landflow and Landfall

![The suite: HR systems, people and Landfall incidents feed Landflow; Landflow calls Landbright's API and Landbright sends signed webhooks back; Landflow provisions target systems; Landbright signs people in to Landflow and Landfall.](diagrams/suite.svg)

Landbright decides and remembers; Landflow acts.

- **HR events** (HiBob webhooks, Shapes over GraphQL) arrive as Landflow triggers. Joiner, mover and leaver flows call
  Landbright's API to create, change or deactivate the identity and its groups (wave 3).
- **Access requests** from the portal, Slack, Teams or an agent's tool call become Landflow flows: approval where the
  approver works, then provisioning through Landflow's target plugins, and revocation when the grant ends (wave 4).
  Landbright keeps the catalog, the policies and the ledger of grants, and enforces the end even if Landflow is down.
- **Signed webhooks** tell Landflow what changed in Landbright (`request.created`, `grant.expiring`,
  `identity.deactivated`, …) through the Landbright trigger (wave 3).
- **Sign-in**: Landflow and Landfall are OIDC relying parties of Landbright, with group names in the `roles` claim.
  This is the only edge built today (wave 1); SCIM pushes to both follow in wave 2.
- **Agents** get Landbright identities with an accountable sponsor; in wave 5 a run started by a person gets a token
  whose subject is the person and whose `act` claim names the agent.
- **Landfall incidents** (sev1, sev2) start a Landflow flow that grants the responders a pre-approved bundle until the
  room closes (wave 6). Landfall itself executes nothing.

## Inside Landbright today

![Inside Landbright: the administrator uses the console, which calls the control API; people sign in to apps on the identity plane's pages; both services use Postgres and Valkey; control sends invites through Mailpit.](diagrams/inside.svg)

[architecture.md](architecture.md) has the code map behind each box, and [development.md](development.md) the ports.
