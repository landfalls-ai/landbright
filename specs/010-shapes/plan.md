# Plan 010: Shapes

[Spec](spec.md) · [Tasks](tasks.md) · [Research](research.md).

## Where it lives

In the `hris` plugin (`integrations/landflow/plugins/hris`), beside HiBob: `src/shapes.ts` (the client),
`src/nodes/shapes.ts` (credential and action), `src/nodes/shapes-trigger.ts` (the two triggers). One plugin for HR
systems, one worker shape: the Landbright side and the flows after it don't know which HR system spoke.

## Tokens

Shapes' access token lasts 15 minutes, and each refresh spends the refresh token it is sent and answers a new pair.
Landflow's OAuth2 refresh can't do it (Shapes refreshes with a GraphQL mutation and a `Refresh-Token` header), and a
credential can't be written back from a plugin. So:

- The credential holds the refresh token the person pasted. The plugin keeps the pair it gets back in a token store:
  `SHAPES_TOKEN_STORE`, default `~/.config/landbright/shapes-tokens.json`, mode 600, written atomically, keyed by
  `sha256(API URL + pasted refresh token)`, so it never contains the pasted token and a new pasted token starts afresh.
- Refreshes for one key are serialized in the process, so two runs at once spend the refresh token once.
- An access token is used until a minute before its `exp` (read from the JWT; 15 minutes if it isn't one). A 401 or an
  `UNAUTHENTICATED` error refreshes once and retries.
- A refused refresh says what to do: create a new token in *My settings → API tokens* and paste it.
- Limitation: one plugin process per store. Two processes sharing a refresh token would each spend it.

## Calls

| Operation | GraphQL |
|---|---|
| Who am I | `query Me { me { id email } }` |
| Ids by email | `query IdsByEmail($email: [String!]) { employees(filters: { email: $email }) { id } }` |
| Changed since | `employeeFieldValues(filters: { fieldTypeContext: [...], updatedAt: { start } })`, ids ordered by `updatedAt` |
| Workers | `employees(ids)` and `employeeFieldValues(filters: { employeeId, fieldTypeContext })`, 100 ids a call; then the managers' emails |

`TOO_MANY_REQUESTS` waits `retryAfterSeconds` (up to 30 s; a minute's advice is not waited for) and is tried twice more.

## The worker

| Worker | Shapes |
|---|---|
| `sourceId`, `email`, `givenName`, `familyName` | `Employee.id`, `email`, `firstName`, `lastName` |
| `department` | `department` context's `textValue`, else `team`'s |
| `title`, `site` | `job`, `office` (`textValue`) |
| `managerEmail` | `reports_to` (`fieldValue` is the manager's employee id), read in a second call |
| `startDate`, `endDate` | `start_date`, `termination_date` (ISO date) |
| `status` | `workStatus` |

## Webhook

The signature is checked over the raw body (hex, `sha256=` hex, or base64: Shapes' docs show hex, practice is
unconfirmed); the body's signed `timestamp` must be within five minutes. Then the employee is read: Shapes sends only
the fields its action names, and a worker with nulls would clear fields in Landbright. A read that fails answers 503
(Shapes shows the step failed) and the poll picks the change up.

## Fake Shapes

`test/fake-shapes.ts` executes the part of Shapes' public schema the plugin uses (`test/shapes-schema.graphql`, type and
field names, no descriptions) with graphql-js, so a query Shapes would reject fails in the tests too; a test also
validates every query in `src/shapes.ts` against that schema. Tokens rotate as Shapes documents; `/_fake/deliver` signs
a workflow delivery; `/_fake/throttle` answers `TOO_MANY_REQUESTS`. `pnpm fake-shapes` (port 57996).

## Design review

Checked on 2026-11-16 against Shapes' public sources (no account) and the live Landflow and Landbright source.

| Claim | Checked against | Result |
|---|---|---|
| Shapes is GraphQL only, with rotating refresh tokens | Shapes' help center (*API tokens*), `api.shapes.co/v1/llms.txt` | Holds |
| The plugin's queries are valid | Shapes' published schema (Apollo Studio, `DreamTeam-V1`, `Current`, 2026-11-12) | Holds: validated in a test |
| Webhooks come only from workflows, signed, tried once | *Workflow Webhooks* | Holds; hence the poll |
| A plugin can't write its credential back | `landflow/docs/protocol.md` §7 | Holds; hence the token store |
| A poll trigger keeps its own state and drops the first poll's items | `@landflow/sdk` runtime (`getPollState`, `isFirstPoll`) | Holds |
| Landbright needs nothing new | `POST /api/v1/people` takes `source: 'shapes'` (any source string) and the worker's fields | Holds: live, `source: shapes` in the audit |

## Constitution Check

| Principle | Status | Evidence |
|---|---|---|
| I. Adopt plumbing | PASS | Shapes' API as published; Landflow's plugin protocol; graphql-js only in tests |
| II. Default deny | PASS | Unsigned or stale deliveries refused; the token store is mode 600 and holds no pasted token |
| III. Accountable human | PASS | Shapes creates people only; agents are untouched |
| IV. Policy or a person approves | PASS | HR's record decides who works here, as for HiBob; access beyond birthright still needs a request |
| V. Ledger | PASS | Landbright audits every create and update with `source: shapes` and the Shapes id |
| VI. Standards | PASS | HMAC-SHA256 signatures; GraphQL over HTTP |
| VII. N-up safe | PASS | Idempotency keys per delivery; the upsert is idempotent, so overlapping polls are harmless. The token store is per process (documented) |
| VIII. Spec-driven | PASS | Plugin tests against the fake Shapes and the published schema; a live check through the throwaway Landflow |
| IX. Local only | PASS | A fake Shapes on 127.0.0.1, fictitious people; no Shapes account, no key |
