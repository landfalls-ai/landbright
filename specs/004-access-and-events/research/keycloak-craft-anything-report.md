# Investigation report

**Question:** What should Landbright (a NestJS + oidc-provider IdP for people and AI agents) adopt from Keycloak 26.4.7, area by area, and which process flows belong in Landflow rather than the IdP?

**Purpose:** Product design: decide what Landbright builds next and how its events feed Landflow flows

**Done when:** A report with a gap table, per-area evidence and an ordered list of 4-6 items to build first

## What we looked at

- org.keycloak.keycloak-core-26.4.7.jar (jar)
- org.keycloak.keycloak-model-jpa-26.4.7.jar (jar)
- org.keycloak.keycloak-server-spi-26.4.7.jar (jar)
- org.keycloak.keycloak-server-spi-private-26.4.7.jar (jar)
- org.keycloak.keycloak-services-26.4.7.jar (jar)
- http://127.0.0.1:58180 (Keycloak 26.4.7, realm study)
- Keycloak jars in scratchpad/keycloak-jars
- /Users/pickjonathan/WorkSpace/landbright docs

## What we found

### Keycloak 26.4 Workflows (experimental, feature flag workflows) model a workflow as a realm component with name, uses (event-based-workflow), on (trigger event), reset-on, if (conditions or a boolean expression), enabled, recurring/scheduled flags, and ordered steps each with uses, after (delay in ms from the previous step), priority and with (config).

- **Confidence:** Seen it (observed)
- **Evidence:**
  - `ev_53138c3dda0d2f4a2c4af9a71289ce885689c1abcc9cc561eb03961af6360d80` — org.keycloak.representations.workflows.WorkflowConstants (Java 8) extends Object: 16 fields, 1 methods, from WorkflowConstants.java. (path=(session scratchpad, not kept)/keycloak-jars/org.keycloak.keycloak-core-26.4.7.jar, class=org/keycloak/representations/workflows/WorkflowConstants)
  - `ev_58218b7480550ec29f3c818ac7bcb5aded65e65731092e3904f322569b4db2b0` — org.keycloak.models.workflow.Workflow (Java 17) extends Object: 4 fields, 12 methods, from Workflow.java. (path=(session scratchpad, not kept)/keycloak-jars/org.keycloak.keycloak-server-spi-private-26.4.7.jar, class=org/keycloak/models/workflow/Workflow)
  - `ev_e889c6a5c570c32b47e57ee3ff2f86ada936d101d6490b74f52d65be33ed71a6` — org.keycloak.models.workflow.WorkflowStep (Java 17) extends Object: 3 fields, 12 methods, from WorkflowStep.java. (path=(session scratchpad, not kept)/keycloak-jars/org.keycloak.keycloak-server-spi-private-26.4.7.jar, class=org/keycloak/models/workflow/WorkflowStep)

### Workflow triggers in 26.4 are user-only: USER_ADD, USER_LOGIN, USER_FEDERATED_IDENTITY_ADD/REMOVE, USER_GROUP_MEMBERSHIP_ADD, USER_ROLE_ADD and AD_HOC (binding a workflow to an existing user via POST /admin/realms/{realm}/workflows/{id}/bind/USERS/{userId}).

- **Confidence:** Seen it (observed)
- **Evidence:**
  - `ev_aa48ff288be69db916c3cd30798e0f7766dbd3a1c0d0547d281f3a7175fe075b` — org.keycloak.models.workflow.ResourceOperationType (Java 17) extends java.lang.Enum: 10 fields, 12 methods, from ResourceOperationType.java. (path=(session scratchpad, not kept)/keycloak-jars/org.keycloak.keycloak-server-spi-private-26.4.7.jar, class=org/keycloak/models/workflow/ResourceOperationType)
  - `ev_97e0666b53f220f0bf5814602bda0c8ed7bb7a6f3238951fc238ce4d63a5ef3d` — org.keycloak.models.workflow.ResourceType (Java 17) extends java.lang.Enum: 6 fields, 10 methods, from ResourceType.java. (path=(session scratchpad, not kept)/keycloak-jars/org.keycloak.keycloak-server-spi-private-26.4.7.jar, class=org/keycloak/models/workflow/ResourceType)
  - `ev_98a0f0caeb6105c3e5cd1c7e92b4ca335adae52292aec04b73e694573d8ac0ad` — org.keycloak.workflow.admin.resource.WorkflowResource (Java 17) extends Object: 2 fields, 6 methods, from WorkflowResource.java. (path=(session scratchpad, not kept)/keycloak-jars/org.keycloak.keycloak-services-26.4.7.jar, class=org/keycloak/workflow/admin/resource/WorkflowResource)

### Pending workflow steps are kept per resource in a JPA table (execution id, workflow id, resource id and type, scheduled step id and timestamp) and run by a background task whose interval defaults to 12 hours; the global workflow-event-listener feeds events in.

- **Confidence:** Seen it (observed)
- **Evidence:**
  - `ev_ca8eacabd61d3844706163c9d03b30fe796540ce75f6e7cf8a5db8cccaa4fe77` — org.keycloak.models.workflow.WorkflowStateEntity (Java 17) extends Object: 7 fields, 17 methods, from WorkflowStateEntity.java. (path=(session scratchpad, not kept)/keycloak-jars/org.keycloak.keycloak-model-jpa-26.4.7.jar, class=org/keycloak/models/workflow/WorkflowStateEntity)
  - `ev_ecc4a94e5b6fa27b1a0afe601bce486461ff89eb5f7192571f32125919112b5e` — org.keycloak.models.workflow.WorkflowsEventListenerFactory (Java 17) extends Object: 3 fields, 13 methods, from WorkflowsEventListenerFactory.java. (path=(session scratchpad, not kept)/keycloak-jars/org.keycloak.keycloak-services-26.4.7.jar, class=org/keycloak/models/workflow/WorkflowsEventListenerFactory)
  - `ev_a9e2beec9dc32a84998984cbd0c6cf75fbc3d9607f12091ffde4e7d04f54050c` — org.keycloak.models.workflow.WorkflowRunnerScheduledTask (Java 17) extends Object: 2 fields, 5 methods, from WorkflowRunnerScheduledTask.java. (path=(session scratchpad, not kept)/keycloak-jars/org.keycloak.keycloak-services-26.4.7.jar, class=org/keycloak/models/workflow/WorkflowRunnerScheduledTask)

### The admin REST surface for workflows is list/create (also a set), get/update (only name and enabled may change)/delete, bind to a resource, and a steps sub-resource (list, add at position, get, remove); the admin console only offers a JSON editor.

- **Confidence:** Seen it (observed)
- **Evidence:**
  - `ev_ddd36b7af4bb369c09fc582d6784cb29d0995c10a5026a895724846b3d67be3e` — org.keycloak.workflow.admin.resource.WorkflowsResource (Java 17) extends Object: 3 fields, 5 methods, from WorkflowsResource.java. (path=(session scratchpad, not kept)/keycloak-jars/org.keycloak.keycloak-services-26.4.7.jar, class=org/keycloak/workflow/admin/resource/WorkflowsResource)
  - `ev_714562cee4ed6626de49d2c5f8270e566d6406a82760750f25952201481c06c6` — org.keycloak.workflow.admin.resource.WorkflowStepsResource (Java 17) extends Object: 2 fields, 5 methods, from WorkflowStepsResource.java. (path=(session scratchpad, not kept)/keycloak-jars/org.keycloak.keycloak-services-26.4.7.jar, class=org/keycloak/workflow/admin/resource/WorkflowStepsResource)
  - `ev_41d3119c6700e565b03ea30233fc9e10bd0f229be0619991479a7432efa0654e` — Ran 12 of 12 scripted step(s) on http://127.0.0.1:58180/admin/master/console/#/study/workflows. (url=http://127.0.0.1:58180/admin/master/console/#/study/workflows)

### Keycloak event listeners implement two callbacks (user event; admin event with an include-representation flag) and are invoked from a transaction hook after commit, so a listener that pushes to an external system can lose events: there is no built-in outbox, retry or webhook.

- **Confidence:** Worked it out (derived)
- **Evidence:**
  - `ev_224d57c4e6ec71a8e99db06bf78689402460540b0b1528246564bdea56957e2b` — org.keycloak.events.EventListenerProvider (Java 17) extends Object: 0 fields, 2 methods, from EventListenerProvider.java. (path=(session scratchpad, not kept)/keycloak-jars/org.keycloak.keycloak-server-spi-private-26.4.7.jar, class=org/keycloak/events/EventListenerProvider)
  - `ev_23ae59e1d7c76b0292ad34883d59531eb6d2f8fd38ad03bf9340316d6543280a` — org.keycloak.events.EventListenerTransaction (Java 17) extends org.keycloak.models.AbstractKeycloakTransaction: 4 fields, 6 methods, from EventListenerTransaction.java. (path=(session scratchpad, not kept)/keycloak-jars/org.keycloak.keycloak-server-spi-private-26.4.7.jar, class=org/keycloak/events/EventListenerTransaction)
  - `ev_69f9e48bcab6d69735082ac16ed3f08ed0e9e22011321a49ac8814f02015c726` — org.keycloak.events.EventListenerProviderFactory (Java 17) extends Object: 0 fields, 1 methods, from EventListenerProviderFactory.java. (path=(session scratchpad, not kept)/keycloak-jars/org.keycloak.keycloak-server-spi-private-26.4.7.jar, class=org/keycloak/events/EventListenerProviderFactory)

### A user event carries id, time, type, realm id and name, client id, user id, session id, IP address, error and a details map; an admin event carries id, time, realm, authDetails (realm, client, user, IP), resourceType, operationType (CREATE/UPDATE/DELETE/ACTION), resourcePath, representation, error and details.

- **Confidence:** Seen it (observed)
- **Evidence:**
  - `ev_dfc1160e3da2fbb12598e4ae88d0a8f21551c00d5b6393d653bfc343a632de67` — org.keycloak.events.Event (Java 17) extends Object: 11 fields, 26 methods, from Event.java. (path=(session scratchpad, not kept)/keycloak-jars/org.keycloak.keycloak-server-spi-private-26.4.7.jar, class=org/keycloak/events/Event)
  - `ev_7cb9f6d8625a99d7c2469c60275f76a85cfaf77260f5dd7cc3e7afbcdd4b0d00` — org.keycloak.events.admin.AdminEvent (Java 17) extends Object: 11 fields, 27 methods, from AdminEvent.java. (path=(session scratchpad, not kept)/keycloak-jars/org.keycloak.keycloak-server-spi-private-26.4.7.jar, class=org/keycloak/events/admin/AdminEvent)

### Federated client authentication (client authenticator federated-jwt) lets a client authenticate with a JWT issued by a registered SPIFFE or Kubernetes identity provider; the client names the provider in attribute jwt.credential.issuer and the expected subject in jwt.credential.sub, so an agent needs no stored secret.

- **Confidence:** Seen it (observed)
- **Evidence:**
  - `ev_65e77f4e2765c7429332e20702462179e187b9b01a40754738a63d7ddc6b86e2` — org.keycloak.authentication.authenticators.client.FederatedJWTClientAuthenticator (Java 17) extends org.keycloak.authentication.authenticators.client.AbstractClientAuthenticator: 6 fields, 14 methods, from FederatedJWTClientAuthenticator.java. (path=(session scratchpad, not kept)/keycloak-jars/org.keycloak.keycloak-services-26.4.7.jar, class=org/keycloak/authentication/authenticators/client/FederatedJWTClientAuthenticator)
  - `ev_d7e4abb64a41776dd0bf3c5c8ff0117a75443249034638cb59e2884792521bda` — 3 of 1760 classes match "Federated" ; showing 3. (path=(session scratchpad, not kept)/keycloak-jars/org.keycloak.keycloak-services-26.4.7.jar)

### The admin console (React, Vite) calls about 30 admin REST endpoints across realm settings, authentication, workflows, events, clients, scopes, roles, groups, users, sessions, IdPs, federation and organizations, plus ui-ext helper endpoints; its bundle declares 341 console routes including /:realm/workflows and /:realm/workflows/new.

- **Confidence:** Seen it (observed)
- **Evidence:**
  - `ev_6d07098de9d83f69068d5dba18e2f0ef35ab682d08f62fa36d3cb72fae85cc99` — Ran 87 of 87 scripted step(s) on about:blank. (url=about:blank)
  - `ev_e8fd784225497c2aedd04ceac9e9d467aa5ce99705e28ade2bc4efb5b3ea8f9d` — Analysed 9 script(s) from http://127.0.0.1:58180/admin/master/console/#/study/workflows: 8 module(s), 15 endpoint(s), 458 route(s), bundled with vite. (url=http://127.0.0.1:58180/admin/master/console/#/study/workflows)

## Open questions

_None outstanding._

## How this was done

- **Mode:** Clean room (nothing inside the original was read)
- **Engines:** builtin, cdp
- **Limitations:**
  - 0 occurrence(s) of declared values were redacted
  - 3 method(s) contain stack operations that were approximated.
  - A fresh private browser: pages behind a login show their signed-out state.
  - Generic type arguments are erased in bytecode and are not shown.
  - Local variables are named v0, v1, … (no debug names); their declared types are not reconstructed.
  - Only the scripts this live page had loaded during the window were analysed; lazily loaded chunks may be missing.
  - Request/response bodies are reduced to outlines, cookies and auth headers are dropped, and declared secrets are redacted in every encoding.
  - Some methods contain control flow shown with labels and goto statements.
  - Static reading only: code built at run time (eval, computed imports) is invisible.
  - Synthetic members, lambda/invokedynamic desugaring, enum scaffolding and string-switch hashing are not turned back into source.
  - The requested network content is kept (capped per body); credential headers are redacted and declared secrets are redacted in every encoding.
  - This is one controlled run of scripted steps; different steps or timing would show different behaviour.
  - This pseudo-Java is reconstructed from bytecode by Craft Anything's built-in decompiler; it is a best guess, not the original source. The bytecode disassembly is the evidence.

## Evidence ledger

- `ev_c44017fbfabde5a9a4e30a51e4c20119d37b3704c1ad71ad15e9863cca3ba843` **java_classes_find** — 19 of 1760 classes match "workflow" ; showing 19. (Seen it)
- `ev_1eb7d576fccaeab43286dabb5d20be4bc2467344c7f9bf95bed851887ab4d2a0` **java_classes_find** — 19 of 1760 classes match "workflow" ; showing 19. (Seen it)
- `ev_0e3cf564865726a7698f20d14433a201a9a66092a59e84aecfb23d2c02af70f6` **java_classes_find** — 0 of 293 classes match "workflow" ; showing 0. (Seen it)
- `ev_f2da6642f1bd11c6fb864296746e081672da5fb0564a7f1d2f6b70e50d432f49` **java_classes_find** — 18 of 664 classes match "workflow" ; showing 18. (Seen it)
- `ev_5cede4f97a4edd59205d72bf5e1b67d83cccd58f4c127b4331de1047c3b2f3ba` **java_classes_find** — 36 of 270 classes match "workflow" ; showing 36. (Seen it)
- `ev_3c890fc14214045c05a531bf32c774cc95912976f26626b42ee1475fc267cd43` **java_classes_find** — 13 of 394 classes match "workflow" ; showing 13. (Seen it)
- `ev_53138c3dda0d2f4a2c4af9a71289ce885689c1abcc9cc561eb03961af6360d80` **java_class_show** — org.keycloak.representations.workflows.WorkflowConstants (Java 8) extends Object: 16 fields, 1 methods, from WorkflowConstants.java. (Seen it)
- `ev_1712e7d6854222f74ceb99e5c10439fbba764f2a4c9e78d0ed5beb5d277c3d8b` **java_class_show** — org.keycloak.workflow.admin.resource.WorkflowsResource (Java 17) extends Object: 3 fields, 5 methods, from WorkflowsResource.java. (Seen it)
- `ev_ddd36b7af4bb369c09fc582d6784cb29d0995c10a5026a895724846b3d67be3e` **java_class_show** — org.keycloak.workflow.admin.resource.WorkflowsResource (Java 17) extends Object: 3 fields, 5 methods, from WorkflowsResource.java. (Best guess)
- `ev_98a0f0caeb6105c3e5cd1c7e92b4ca335adae52292aec04b73e694573d8ac0ad` **java_class_show** — org.keycloak.workflow.admin.resource.WorkflowResource (Java 17) extends Object: 2 fields, 6 methods, from WorkflowResource.java. (Best guess)
- `ev_714562cee4ed6626de49d2c5f8270e566d6406a82760750f25952201481c06c6` **java_class_show** — org.keycloak.workflow.admin.resource.WorkflowStepsResource (Java 17) extends Object: 2 fields, 5 methods, from WorkflowStepsResource.java. (Best guess)
- `ev_aa48ff288be69db916c3cd30798e0f7766dbd3a1c0d0547d281f3a7175fe075b` **java_class_show** — org.keycloak.models.workflow.ResourceOperationType (Java 17) extends java.lang.Enum: 10 fields, 12 methods, from ResourceOperationType.java. (Seen it)
- `ev_97e0666b53f220f0bf5814602bda0c8ed7bb7a6f3238951fc238ce4d63a5ef3d` **java_class_show** — org.keycloak.models.workflow.ResourceType (Java 17) extends java.lang.Enum: 6 fields, 10 methods, from ResourceType.java. (Seen it)
- `ev_58218b7480550ec29f3c818ac7bcb5aded65e65731092e3904f322569b4db2b0` **java_class_show** — org.keycloak.models.workflow.Workflow (Java 17) extends Object: 4 fields, 12 methods, from Workflow.java. (Seen it)
- `ev_e889c6a5c570c32b47e57ee3ff2f86ada936d101d6490b74f52d65be33ed71a6` **java_class_show** — org.keycloak.models.workflow.WorkflowStep (Java 17) extends Object: 3 fields, 12 methods, from WorkflowStep.java. (Seen it)
- `ev_ab05f72562c177b7d5349c2207fc0fec49a24f835a594036f0dc9680ea826fa9` **java_class_show** — org.keycloak.models.workflow.WorkflowEvent (Java 17) extends Object: 4 fields, 5 methods, from WorkflowEvent.java. (Seen it)
- `ev_ca8eacabd61d3844706163c9d03b30fe796540ce75f6e7cf8a5db8cccaa4fe77` **java_class_show** — org.keycloak.models.workflow.WorkflowStateEntity (Java 17) extends Object: 7 fields, 17 methods, from WorkflowStateEntity.java. (Seen it)
- `ev_ecc4a94e5b6fa27b1a0afe601bce486461ff89eb5f7192571f32125919112b5e` **java_class_show** — org.keycloak.models.workflow.WorkflowsEventListenerFactory (Java 17) extends Object: 3 fields, 13 methods, from WorkflowsEventListenerFactory.java. (Seen it)
- `ev_a9e2beec9dc32a84998984cbd0c6cf75fbc3d9607f12091ffde4e7d04f54050c` **java_class_show** — org.keycloak.models.workflow.WorkflowRunnerScheduledTask (Java 17) extends Object: 2 fields, 5 methods, from WorkflowRunnerScheduledTask.java. (Seen it)
- `ev_18e157ece2a0f82ebcb50b045c01d4fee4b470b75f3871d146bdebcfa2dcba0a` **java_classes_find** — 1 of 293 classes match "EventListener" ; showing 1. (Seen it)
- `ev_e26c8664de7d40e481422309db3527ebed010e6c861dc9d0eb718e29ab6be80f` **java_classes_find** — 0 of 293 classes match "org.keycloak.events" ; showing 0. (Seen it)
- `ev_9a659710498a5c116880e9cdcc61cf6ef43e391c32009540b2ab6828518a9ed0` **java_classes_find** — 20 of 664 classes match "org.keycloak.events" ; showing 20. (Seen it)
- `ev_c07e65cee6b2760efb344cfbcefaef5b65caccdfd9abcb8b3490c89a98a92968` **java_classes_find** — 5 of 1760 classes match "org.keycloak.events" ; showing 5. (Seen it)
- `ev_224d57c4e6ec71a8e99db06bf78689402460540b0b1528246564bdea56957e2b` **java_class_show** — org.keycloak.events.EventListenerProvider (Java 17) extends Object: 0 fields, 2 methods, from EventListenerProvider.java. (Seen it)
- `ev_69f9e48bcab6d69735082ac16ed3f08ed0e9e22011321a49ac8814f02015c726` **java_class_show** — org.keycloak.events.EventListenerProviderFactory (Java 17) extends Object: 0 fields, 1 methods, from EventListenerProviderFactory.java. (Seen it)
- `ev_23ae59e1d7c76b0292ad34883d59531eb6d2f8fd38ad03bf9340316d6543280a` **java_class_show** — org.keycloak.events.EventListenerTransaction (Java 17) extends org.keycloak.models.AbstractKeycloakTransaction: 4 fields, 6 methods, from EventListenerTransaction.java. (Seen it)
- `ev_dfc1160e3da2fbb12598e4ae88d0a8f21551c00d5b6393d653bfc343a632de67` **java_class_show** — org.keycloak.events.Event (Java 17) extends Object: 11 fields, 26 methods, from Event.java. (Seen it)
- `ev_7cb9f6d8625a99d7c2469c60275f76a85cfaf77260f5dd7cc3e7afbcdd4b0d00` **java_class_show** — org.keycloak.events.admin.AdminEvent (Java 17) extends Object: 11 fields, 27 methods, from AdminEvent.java. (Seen it)
- `ev_94187f2e487e3ec4edee4445e49f6b0c79c5814c81932e019f47433f6e2bc74c` **web_walkthrough_record** — Ran 0 of 1 scripted step(s) on about:blank (step 1 failed). (Seen it)
- `ev_58ed8549d1016686c539d6a7ef6bc20bba0c146d16abc6cd5651090fb1806a5a` **web_walkthrough_record** — Ran 60 of 60 scripted step(s) on about:blank. (Seen it)
- `ev_83897d1e6f2dbc817548525525d21733e762458a96284564c08b829b45fb48bb` **web_walkthrough_record** — Ran 6 of 87 scripted step(s) on about:blank (step 7 failed). (Seen it)
- `ev_6d07098de9d83f69068d5dba18e2f0ef35ab682d08f62fa36d3cb72fae85cc99` **web_walkthrough_record** — Ran 87 of 87 scripted step(s) on about:blank. (Seen it)
- `ev_2e688d69ed9e67ba589aee565b78e60025394dd117475bd6f0755dea46a6705d` **web_site_open** — Opened http://127.0.0.1:58180/realms/study/protocol/openid-connect/auth: "Sign in to study". (Seen it)
- `ev_6228335c97d26bb06547e96ec1aa54d6b546adf63f4680e7b5ad22cf924078b8` **web_site_open** — Opened http://127.0.0.1:58180/realms/study/protocol/openid-connect/auth: "Sign in to study". (Seen it)
- `ev_04314cee7d98821c0582c3b3596988532a5592917239a17d3346d3a0ed4208cb` **web_walkthrough_record** — Ran 6 of 8 scripted step(s) on about:blank (step 7 failed). (Seen it)
- `ev_e8fd784225497c2aedd04ceac9e9d467aa5ce99705e28ade2bc4efb5b3ea8f9d` **web_page_js_analyze** — Analysed 9 script(s) from http://127.0.0.1:58180/admin/master/console/#/study/workflows: 8 module(s), 15 endpoint(s), 458 route(s), bundled with vite. (Worked it out)
- `ev_41d3119c6700e565b03ea30233fc9e10bd0f229be0619991479a7432efa0654e` **web_walkthrough_record** — Ran 12 of 12 scripted step(s) on http://127.0.0.1:58180/admin/master/console/#/study/workflows. (Seen it)
- `ev_d7e4abb64a41776dd0bf3c5c8ff0117a75443249034638cb59e2884792521bda` **java_classes_find** — 3 of 1760 classes match "Federated" ; showing 3. (Seen it)
- `ev_65e77f4e2765c7429332e20702462179e187b9b01a40754738a63d7ddc6b86e2` **java_class_show** — org.keycloak.authentication.authenticators.client.FederatedJWTClientAuthenticator (Java 17) extends org.keycloak.authentication.authenticators.client.AbstractClientAuthenticator: 6 fields, 14 methods, from FederatedJWTClientAuthenticator.java. (Seen it)

