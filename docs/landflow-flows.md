# The Landflow flows

Landbright decides and records; Landflow flows do the talking, the provisioning and the lifecycle work. Eight flows
ship in [`integrations/landflow/flows/`](../integrations/landflow/flows/). Each is plain Landflow workflow JSON. All but one are built
from core nodes (Webhook, Code, If, HTTP Request, Set, Wait, Schedule), so they import into any Landflow, edit on the
canvas, and need no Landflow change; the *Joiner from HiBob* uses this repository's two Landflow plugins ([hr.md](hr.md)).

| Flow | Starts on | Does |
|---|---|---|
| **Approve a request (email)** | `request.created` | Re-reads the request. While it's pending: emails each approver the decision link, registers its resume URL with Landbright, and waits until the deadline. Wakes on Landbright's nudge, re-reads, and tells the requester the outcome |
| **Provision and revoke a Landflow project role** | `grant.activated`, `grant.expired`, `grant.revoked`, `grant.revoke_overdue` | Re-reads the grant. For each `landflow-project-role` target (`config: { project, role }`): adds the person to the project's members when the grant is live, removes them when it ended, and reports `provisioned` / `revoked` (or `failed` / `revoke_failed`) to Landbright |
| **Approve a request (Slack)** | `request.created` | When the current step allows chat votes: gets one ticket per approver, finds each in Slack by email, and sends a direct message with Approve and Deny (carrying the ticket) and *Open in Landbright* |
| **Slack approval buttons** | The Slack app's Interactivity URL | Relays the click with its ticket to `POST /api/v1/requests/:id/decisions`, then replaces the message with the outcome (or why Landbright refused) |
| **Onboard a new person** | `identity.created` | For a person: re-reads them, adds them to their birthright groups (*Everyone*, and their department's: Engineering gets *Engineers* and *Landflow Editors*) as source `hr`, asks them to set up a second step and accept the terms at their first sign-in ([account.md](account.md#required-actions)), and emails a welcome (for a pre-hire, saying the invite comes on their start date). Keycloak's onboarding, as a flow; the map of groups is the *Birthright groups* Code node |
| **Ask a person for an agent (CIBA)** | `ciba.requested` | Emails the person the agent asks to act for: the agent's name, the code it shows, the link to Landbright's decision page and how long it works. The person decides there, signed in; the flow only carries the link ([agents.md](agents.md#asking-a-person-ciba-with-landflow-as-the-channel)) |
| **Joiner from HiBob** | HiBob's `employee.created` and `employee.joined` (the hris plugin's HiBob Trigger; Bob-Signature checked) | Reads the employee from HiBob and creates or updates them in Landbright (the landbright plugin's Person → Create or Update): a pre-hire until their start date, then active with their invite. The *Onboard* flow follows on `identity.created` ([hr.md](hr.md)) |
| **Disable inactive people** | Every day at 9:00 | Finds people who haven't signed in for 90 days (administrators excepted), emails their manager, waits 7 days, checks again, and deactivates who is still inactive. Keycloak's *disable inactive users* workflow, as a flow |

Each flow reaches Landbright only through the [machine API](reference/api.md#machine-api-apiv1), with the scopes its
application holds. A flow can read, annotate, report targets and deactivate. It can't approve.

![The approval flow waiting in Landflow, after asking Landbright to wake it.](screenshots/52-live-landflow-run-waiting.png)

## Install them (local)

You need:

- the development stack (`pnpm dev:up`, `pnpm serve`);
- Landflow signing in through Landbright, the throwaway instance of [suite.md](suite.md#try-it-landflow-signs-in-through-landbright);
- its env file with the client secret.

```bash
cd e2e && LANDFLOW_OIDC_ENV_FILE=/path/to/landflow-oidc.env node landflow/install.ts
```

**In Landbright**, through the console API, as the bootstrap administrator, the installer:

- gives the Landflow application client credentials and the scopes `requests:read grants:record annotations:write
  directory:read directory:write decisions:relay`;
- subscribes `…/api/webhook/landbright-requests` to `request.created`, `…/landbright-grants` to `grant.activated`,
  `expired`, `revoked` and `revoke_overdue`, and `…/landbright-people` to `identity.created`, with audience
  `http://localhost:57300`;
- creates the bundle *Landflow Editors (JIT)*: the group *Landflow Editors*, plus the target *Landflow project Payments,
  editor*, approved by *Landflow Admins*;
- creates the birthright groups *Everyone* and *Engineers* (kind `birthright`) for the *Onboard* flow.

**In Landflow**, as its owner, the installer:

- creates the *Payments* project;
- creates three credentials:
  - *Landbright events*: JWT Auth against Landbright's JWKS, issuer and audience checked;
  - *Landbright API*: OAuth2 client credentials;
  - *Landflow API*: an API key for the flows to call Landflow itself;
- with the hris and landbright plugins online, creates *HiBob* (`HIBOB_BASE_URL`, `HIBOB_SERVICE_USER_ID`,
  `HIBOB_TOKEN`, `HIBOB_WEBHOOK_SECRET`; the fake Bob's values by default) and *Landbright (plugin)* (the same
  application's client credentials); without them, the Joiner flow is skipped;
- imports and publishes the flows, and prints the URL to give HiBob for the Joiner flow.

Run it again to update: it finds everything by name first.

**The Slack flows** are installed when `SLACK_BOT_TOKEN` is set (a bot token with `users:read.email` and `chat:write`).
They subscribe `…/landbright-requests-slack` to `request.created`. Set the Slack app's Interactivity Request URL to
`…/api/webhook/landbright-slack-actions` (a Slack app has one, so use an app of its own, not the one Landflow's agents
use). `SLACK_API_URL` points them at another Web API; the live check used a local stand-in:

```bash
SLACK_BOT_TOKEN=xoxb-local-stub SLACK_API_URL=http://127.0.0.1:57991 \
  LANDFLOW_OIDC_ENV_FILE=/path/to/landflow-oidc.env node landflow/install.ts
```

Email goes through Mailpit's HTTP API (`POST /api/v1/send`) because the throwaway Landflow has only core nodes. With
Landflow's messaging plugin, swap that HTTP Request for a Send Email or Slack node.

## Live check (2026-11-14)

In the real Landflow (`landflow/host:dev`, compose project `landbright-landflow`), the full loop ran:

1. Tal asked in the console.
2. The approval flow emailed the administrator and attached its wait.
3. The administrator opened the link and approved.
4. Landbright woke the run; it re-read the request and emailed Tal.
5. The provisioning flow made Tal an editor of *Payments* and reported `provisioned`.
6. Revoking removed Tal from *Payments*, reported `revoked`.

![Tal asks.](screenshots/50-live-tal-asks.png)

![The email Landflow sent the approver.](screenshots/51-live-approval-email.png)

![Approved: Landbright gave the group, the Landflow flow the project role.](screenshots/53-live-request-provisioned.png)

![The approval run, finished after the wake-up.](screenshots/54-live-landflow-run-done.png)

![The provisioning run, ending in Tell Landbright.](screenshots/55-live-landflow-provision-run.png)

![Revoked: both targets removed.](screenshots/57-live-request-revoked.png)

The *Onboard* flow, the same day: an administrator added Noam Katz (Engineering) in the console. The flow added Noam to
*Everyone*, *Engineers* and *Landflow Editors* (source `hr`), set `configure_second_step` and `accept_terms`, and sent
the welcome; Landbright sent the invite. The required actions at a first sign-in are covered by the e2e and browser
tests ([account.md](account.md#required-actions)).

The *CIBA* flow, the same day: a new agent, *Release bot*, asked Landbright to act for Rina Mor. The flow emailed Rina
*Release bot … asks to act for you* with the code and a link good for 10 minutes; Rina signed in (doing the required
actions the *Onboard* flow had set), approved, and the agent's poll got tokens it then exchanged and used on the
machine API ([agents.md](agents.md#checked)).

## Writing your own

- **Start from a Webhook trigger**: path of your choice, *Respond immediately*, authentication *JWT Auth* with the
  *Landbright events* credential. The event is in `$json.jwtPayload.event`: trust that, not the body.
- **Re-read before acting**: `GET /api/v1/requests/:id` or `/api/v1/grants/:id`, with the *Landbright API* credential.
- **Waiting for a decision**: `POST /api/v1/requests/:id/waits { resumeUrl: $execution.resumeUrl }`, then a Wait node
  (*On webhook call*, limited to the deadline), then re-read. Loop back while it's still pending.
- **Report each target**: `POST /api/v1/grants/:id/targets/:key { status, detail?, externalRef? }`.
- **Keep notes**: `PUT /api/v1/requests/:id/annotations/landflow.<name> { value }`, with `If-Match: <version>` to compare and set. The notes show on
  the request page.
- **Code nodes in older Landflow builds** see only their own input (`$json`, `items`, `$input`). Bring other nodes'
  data in with a Set node and expressions (`$('Node').item.json`), which every build supports. The shipped flows do
  this.
