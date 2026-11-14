# Just-in-time access

People ask for **bundles** for a while. The people the bundle's **policy** names approve in Landbright, and a **grant**
gives the access and takes it back at the end. Landflow flows run the conversation around it: they tell the
approvers, provision what Landbright can't, and report back. The decision itself never leaves Landbright
([spec 004](../specs/004-access-and-events/spec.md); the flows are in [landflow-flows.md](landflow-flows.md), the
events in [events.md](events.md)).

![Requesting access in the console.](screenshots/40-request-access.png)

## Bundles and policies

A bundle (console **Catalog**, `POST /api/bundles`) gives:

- **Groups**: Landbright adds the holder to them for the grant, with `source: grant` and the grant's end, and removes
  them at the end. Applications see the group in the `roles` claim as usual.
- **Targets**: anything else, such as a Landflow project role or a GitHub team. Each has a `key`, a `type`, a `label`
  and a `config` the flow reads. A Landflow flow subscribed to `grant.*` provisions each one and reports back.

Its **policy**:

| Field | Meaning |
|---|---|
| `eligibleGroupIds` | Who may ask: standing members of these groups (empty: every active person) |
| `agentsAllowed`, `agentMaxDurationMinutes` | Whether a sponsor may ask for one of their agents, and how long an agent gets at most (15 min by default) |
| `steps[]` (1–3) | In order. Each names approvers (`groupIds`, `identityIds`, `manager`, `bundleOwner`, `sponsor`) and `approvalsRequired` |
| `approverFallback` | When a step names nobody but the requester: `bundleOwner`, then `admins`. Still nobody: the request is refused when it's made |
| `defaultDurationMinutes`, `maxDurationMinutes` | How long, and at most; the duration is clamped again at approval |
| `decisionDeadlineMinutes` | An undecided request expires (`request.decided`, outcome `expired`) |
| `expiringNoticeMinutes` | `grant.expiring` goes out this long before the end |
| `reason` | `required` or `optional`, with a prompt and a minimum length |
| `ticket` | `off`, `optional` or `required`, with a pattern; `uniquePerRequest` stops a ticket from being reused |
| `autoApprove[]` | Rules that approve at once: the subject is a standing member of one of these groups, and asks for at most this long. Never deny. The rule and its evidence are kept on the request |
| `breakGlass` | Members of these groups may take it at once for at most `maxDurationMinutes`; the approvers review it afterwards |
| `escalation` | After this long without a decision, these groups' people join the current step (`request.escalated`) |

## The rules of a decision

- Only **signed-in people** vote, on the request page (`/access/requests/REQ-n`, the link every flow sends). A service
  token never gets `decide`.
- A voter must be named by the current step **now**, through a **standing** membership. A membership a grant gave
  doesn't count, so access can't approve more access.
- Nobody votes on a request they made, or one that's for them or that they act for. One vote per person.
- **One denial ends the request.** Approvals count per step, and the request is approved when every step has
  enough.
- A new request for the same bundle and subject replaces a waiting one (`superseded`). A live grant refuses a new
  request.
- Deactivating a person ends their grants and cancels their requests, and does the same for the agents they sponsor.

![The request page: the step, the vote, and the grant's targets.](screenshots/44-request-approved.png)

## Grants and targets

A grant is `scheduled` (with `startsAt`), `active`, then `expired` or `revoked`. Each target has a status:

| Status | Meaning |
|---|---|
| `pending` | Waiting for its flow |
| `provisioned` / `failed` | The flow gave it, or couldn't (`lastError`); a failed one may be retried |
| `verified` / `drift` | A reconciling flow checked it |
| `revoked` / `revoke_failed` | After the end, the flow removed it, or couldn't |

Landbright handles group targets itself. When a group membership already existed, it is left alone (`already-member`).
When two live grants give the same group, the membership is handed to the other grant (`shared-with-grant`). A late
`provisioned` after the end gets 409. A flow that hasn't reported a removal 15 minutes after the end raises
`grant.revoke_overdue`.

## In the console

- **Requests** (everyone): *To decide*, *Mine*, and *All* for administrators; **Request access** shows who would
  decide before you ask.
- **Grants**, **Catalog** (administrators): who holds what until when, and the bundles with their policy. The bundle
  form edits one approval step; more steps, auto-approve rules and escalation go through `PATCH /api/bundles/:id`, and
  the form keeps them.

People who aren't administrators see only Requests; other pages say they're for administrators.

## For flows: the machine API

`/api/v1`, with a client-credentials token for the resource `urn:landbright:api`. An application gets scopes on its
page (`apiScopes`). The routes are in [reference/api.md](reference/api.md#machine-api-apiv1).

```bash
curl -s -u landflow-local:$SECRET -d grant_type=client_credentials \
  -d resource=urn:landbright:api -d scope='requests:read grants:record' http://localhost:4402/oidc/token
```
