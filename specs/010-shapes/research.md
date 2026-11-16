# Research 010: Shapes' API

Read on 2026-11-16 from public sources only, with no Shapes account and no call to Shapes' API. What Shapes hasn't
published is listed at the end; it is what to check first when the API token comes.

**Which Shapes.** Shapes (shapes.co, formerly DreamTeam; the app is `app.shapes.co`, also `app.dreamteam.io`) is an
HRIS. It is not shapes.inc, an unrelated AI chat product.

## Sources

| Source | What it gave |
|---|---|
| Apollo Studio public graph `DreamTeam-V1` ("Shapes V1"), variant `Current`, published 2026-11-12: <https://studio.apollographql.com/public/DreamTeam-V1/variant/Current/home>. Shapes' help center calls it the authoritative list of operations | The schema (read through Apollo's public graph API) and the endpoint |
| `GET https://api.shapes.co/v1/llms.txt` (public, no credentials) | Rate limits, error codes, how to sync |
| [Where do I find my API tokens](https://help.shapes.co/en/articles/13616006-where-do-i-find-my-api-tokens) | Tokens and their refresh |
| [Workflow Webhooks](https://help.shapes.co/en/articles/12719797-workflow-webhooks), [New Workflows App](https://help.shapes.co/en/articles/17674393-new-workflows-app) | Webhooks: triggers, body, signature, delivery |
| [Harmony: Shapes](https://docs.harmony.io/integrations/hris/shapes) | The role a system user needs; a refresh token is not to be shared between tools |
| [Merge](https://www.merge.dev/integrations/shapes), [Unified.to](https://unified.to/integrations/shapes), [Knit](https://getknit.dev/mcp-servers/shapes.md) | Others connect to Shapes by API key; none documents Shapes' own fields |

## The API

- **GraphQL only**: every operation is a `POST` of `{ query, variables }` (JSON) to `https://api.shapes.co/v1`.
- **Authentication.** A user creates tokens under *My settings → API tokens*: an access token that lasts 15 minutes
  and a refresh token that lasts 7 days. Calls send `Authorization: Bearer <access token>`. `mutation { refreshToken {
  accessToken refreshToken } }`, sent with the old refresh token in a `Refresh-Token` header, answers a new pair; the
  old refresh token is spent, so the new pair replaces the stored one every time. There are no scopes: a token can do
  what its user can. Shapes advises a dedicated system user; Harmony asks for a Super Admin or an Admin who covers every
  employee (`workStatus` is null for anyone else).
- **Limits.** 1,000 requests a minute per user and root field (10 unauthenticated). Some accounts allow one unpaged
  read of 200 or more employees about every 15 minutes; paged reads don't count. A refusal is a GraphQL error with
  `extensions.code: "TOO_MANY_REQUESTS"`, sometimes with `extensions.retryAfterSeconds` (else wait about a minute).
  Other codes: `BAD_USER_INPUT` (a read over 50,000 values, a `limit` out of range), `FORBIDDEN` (a `workStatus`
  filter from a non-admin).

## People

- `employees(ids, filters: { email, office, team, job, workStatus }, limit, afterId): [Employee]!`. Paged by ascending
  id, at most 100 a page; a short page is the last, a full one may be followed by an empty one.
- `Employee { id, firstName, lastName, email, workStatus, profilePictureCdnUrl, employeeFieldValues }`. `workStatus`
  is `active`, `pending_arrival`, `pending_termination` or `terminated`, computed from the start and termination dates.
- Every other attribute is an `EmployeeFieldValue { id, employeeId, fieldValue (JSON), textValue, employeeFieldTypeId,
  employeeFieldType, updatedAt, effectiveDate, rowId }` of an `EmployeeFieldType { id, fieldType, context, fieldName,
  data, isEffectiveDated, subcategory }`. `context` says what a field is, whatever the account named it; the ones a worker
  needs: `department`, `job`, `office`, `reports_to`, `start_date`, `termination_date` (also `team`, `employee_id`,
  `personal_email`, `country`, `city`).
- `fieldValue` is the raw value for text and date kinds, an option id for selects (options in the type's
  `data.valueOptions`), and the referenced row's id for `team`, `job`, `office`, `people`, `reports_to`. `textValue` is
  the display text (a job's or office's name).
- `employeeFieldValues(ids, filters: { fieldTypeContext, employeeFieldTypeId, employeeId, updatedAt, … })` needs at least
  one narrowing filter and has no paging. Shapes' advice: about 100 employee ids a call, only the fields you need,
  `updatedAt` for changes since the last run (a few minutes of overlap, de-duplicated by `id` + `updatedAt`), a full
  reconciliation at most daily, polls no more often than every 15 minutes.
- `offices`, `teams`, `jobs`: `{ id, name }` lists. There is no time-zone field.

## Webhooks

There is no event subscription. A Shapes **workflow** (triggered by *Employee created*, *Employee field value
changed*, *Employee profile date*, an anniversary, or by hand) can have a **Send webhook** action:

- `POST` of JSON `{ schemaVersion: 2, timestamp (ms), definition: { id, name }, run: { id }, action: { id },
  employee: { id, employeeFieldValues: [{ fieldValue, textValue, employeeFieldType: { id, fieldName, fieldType,
  context } }] } }`, with only the fields the action names. A field the workflow's publisher can't see comes as
  `fieldName: "HIDDEN_FIELD"`, `textValue: "MISSING_INFO"`.
- `X-Webhook-Id` on every delivery (run and step: for duplicates). With a secret set, `X-Webhook-Signature` (HMAC-SHA256
  of the raw body; hex in Shapes' example) and `X-Webhook-Timestamp` (the body's `timestamp`).
- One attempt, 30 s timeout, no redirects, no retries; a non-2xx shows the step as failed in the workflow's activity.

## What it means for the plugin

- The access token can't sit in a credential: it lasts 15 minutes. The credential holds the refresh token, and the
  plugin keeps the pair it gets back (each refresh spends the last). Landflow's OAuth2 refresh doesn't fit: Shapes
  refreshes with a GraphQL mutation and a header, not a token endpoint.
- A webhook can be lost (no retries), so the webhook is the fast path and a poll of `updatedAt` changes is the safety
  net, as Shapes itself advises.
- There is no *terminated* trigger: a leaver is a change of `termination_date` (or the date itself arriving), which
  becomes the worker's `endDate`; Landbright already deactivates a person after their last day in their zone.
- The signature covers the body, and the body has `timestamp`: a delivery older than five minutes is refused, which
  the unsigned `X-Webhook-Timestamp` header alone couldn't give.

## Not published: check with the first token

1. The data region and whether `api.shapes.co` is the only host.
2. How an expired access token is answered: an HTTP 401, or a 200 with a GraphQL error (and which `extensions.code`).
3. The `X-Webhook-Id` format, and whether the signature is hex or base64 in practice.
4. Whether an Admin system user can read `reports_to` and `personal_email`.
5. Whether a terminated or offboarded workflow trigger exists.
6. Whether the API allows introspection, and whether there is a sandbox account.
