# ADR-0003 — Identity amendment: licence onboarding, delegated runs, proactive turns, knowledge capture

**Status:** §1 Accepted and implemented (2026-10-06). §2–§5 Accepted as design; not built yet.
Amends ADR-0001 §3 (linking), §5 (policy table) and §6 (membership gate). ADR-0001 still holds
wherever this ADR is silent: exactly one principal per turn, the human must be a member, writes
need approval, no service-account keys, no persisted bearer tokens.

## Context

The roadmap after stage 3 ("make Slack the place people actually use Gemini Enterprise") has five
items. Each one changes *who* a turn runs as, *when* it runs without someone clicking, or *where*
its output lands — so each needs an identity decision before any code:

| # | Item | What changes for identity |
|---|---|---|
| 1 | Licence-aware onboarding | the bot reads (and, with approval, assigns) licences |
| 2 | Assistant pane first: free text, native streaming, low-risk auto-apply | auto-apply runs without a per-change click |
| 3 | Proactive turns: daily brief, suggested answers in help channels | turns nobody invoked |
| 4 | Delegated runs: automations as you, per automation, time-boxed | an unattended *user* principal |
| 5 | Knowledge loop: resolved thread → FAQ in a Gemini Enterprise data store | a write outside Slack that others will read |

A correction to the roadmap note that prompted this ADR: ADR-0001 already lets an automation run as
its owner, but only behind **one account-wide switch** ("Allow my automations to run as me while
I'm away", `allowUnattended`). §4 replaces that switch with a grant per automation.

## Decision

### 1. Licence-aware onboarding (implemented)

A Gemini Enterprise licence belongs to the person's **workforce identity** (or Google identity),
assigned in Gemini Enterprise's user store — never to the Slack account. The bot does not grant
access. It **reads** licences so it can tell people before a request fails, and routes a request
to an admin.

- **Lookup.** `GET v1alpha/projects/{p}/locations/{GE_LOCATION}/userStores/{store}/userLicenses
  ?filter=user_principal = "<principal>"` **[schema]**. `<principal>` is the linked email (the
  email binding of ADR-0001 §3 has already proven it is this Slack user's), or the IdP subject with
  `GE_LICENCE_PRINCIPAL=subject`. The row is matched again client-side, so a filter quirk can never
  return someone else's state.
- **Who calls it.** An **admin-plane identity**: the runtime service account, or
  `GE_LICENCE_ADMIN_SERVICE_ACCOUNT` by impersonation. It needs only
  `discoveryengine.userLicenses.list` (+ `discoveryengine.userStores.batchUpdateUserLicenses` if
  assignment is on). A person's own token can't read the user store and is never used for this. The
  GE-licensed service account (ADR-0001 §4) is not given these grants unless it is also the runtime
  account (`GE_SERVICE_MODE=metadata`). In that case keep `GE_LICENCE_CONFIG` unset, or use a
  separate admin account.
- **States.** `ASSIGNED` → assigned. `UNASSIGNED`, `NO_LICENSE` and `NO_LICENSE_ATTEMPTED_LOGIN` →
  unlicensed. `BLOCKED` → blocked. Anything else, including *not in the user store* (auto-register
  may license them on first use) or a failed lookup → **unknown**.
- **Never fail open on access, never fail closed on a guess.** Only a *known* missing licence stops
  a turn early. `unknown` lets the turn go to Gemini Enterprise, which enforces licences itself. A
  403 there triggers a **fresh** lookup and shows the licence card if that lookup confirms it.
- **Cache.** In the shared store, keyed `(team, user)` and bound to the principal string: 6 h when
  assigned, 15 min otherwise. Assigning a licence through the bot clears it.
- **Service fallback.** The card offers "Answer with the Gemini service" only when the channel
  policy is not `user-only`, a service is configured, no named agent bars the service, `--as me`
  wasn't asked, and the turn touches no Slack Connect conversation.
- **Requests.** One open request per person, posted to `GE_LICENCE_REQUESTS_CHANNEL` and showing
  only the requester and their verified email. A declined or approved-but-unassigned request
  can't be repeated for 7 days.
- **Decisions.** The decider must be a workspace admin/owner of this team, or listed in
  `GE_LICENCE_APPROVERS`. They must be a member of the requests channel and must not be the
  requester. Each request is decided once, through an atomic lock in the store.
  - Without `GE_LICENCE_CONFIG`, "approve" only tells the requester an admin will assign the licence.
  - With `GE_LICENCE_CONFIG` (validated to `GE_LOCATION`), approving calls
    `userStores:batchUpdateUserLicenses` for the requester's **current** linked principal. This is
    refused if they unlinked or relinked as someone else since asking.
  - A failed assignment leaves the request open.
- **Unattended runs** of an unlicensed owner are denied and reported to the owner, never prompted.

### 2. Assistant pane first

The split-view agent DM becomes the primary way in. The slash grammar stays, for power users.

- **Free text goes to the planner.** Nothing about identity changes: the invoker is the human in
  the DM, principal resolution is unchanged, and the planner's output is still a plan.
- **Low-risk auto-apply ("trust levels").** A person may opt in, per change kind, to auto-apply
  changes whose blast radius is only themselves:
  - a reply in their own agent DM thread;
  - a reminder to themselves;
  - a row in a List they own.
  These are added as a new `canAutoApply` class, `self-scoped`. Everything that reaches another
  person (posts and replies in shared conversations, canvases, connector actions) keeps per-change
  approval. The opt-in is stored per user, shown in App Home, cleared on disconnect, and recorded in
  the ledger as `approval: 'trust:self-scoped'`.

### 3. Proactive turns

Proactive turns are turns nobody clicked. They are never a way to read more than the person could
read themselves.

- **Daily brief** (DM to one person) runs **as that person**, under a §4 grant they created by
  opting in.
  - **Reads:** channels they are a member of at run time (membership is re-checked per channel, and
    channels they left are dropped); their own connectors through Gemini Enterprise.
  - **Excludes:** Slack Connect conversations, unless the brief runs as the service and the channel
    is allow-listed.
  - **Output:** the person's DM only, so it is a self-scoped write.
  - **Unlicensed:** the brief stops and §1 applies.
- **Suggested answers in help channels** are opt-in per channel, by an admin, and run as the
  **service principal**: nobody else has consented to the question being answered as them.
  - **Reads:** only service-allow-listed sources, and only when the channel is on the service
    allow-list (ADR-0001 §4–§6).
  - **Delivery:** a private message to the asker (`chat.postEphemeral`). It is posted to the
    channel only when the asker clicks *Post as answer*, which is an approval by the asker, in a
    channel they are a member of.
  - **Not in:** Slack Connect channels; threads that already have a human reply.

### 4. Delegated runs: grants per automation

ADR-0001 §5's "owner (run-as-me + offline)" becomes a **delegation grant** per automation:

```ts
interface DelegationGrant {
  automationId: string; ownerId: string; teamId: string;
  subject: string;            // the linked IdP subject at grant time
  scopes: { channels: string[]; destinations: string[]; connectors: string[] };
  grantedAt: string; expiresAt: string;   // ≤ 30 days; renewed with one click
}
```

- **Granting.** The grant is created on the automation's confirm card. It shows exactly the
  channels it reads, where it posts, and which of the owner's connectors it uses. Confirming the
  card is the consent.
- **Expiry.** The grant expires after at most 30 days. Three days before, the owner gets a DM with
  *Renew*. When it expires, the automation is suspended.
- **Every run re-checks:**
  - that the link exists with the same `subject`;
  - that the owner is still a member of every channel in `scopes`;
  - that the owner is licensed (§1);
  - that the destination is still in `scopes`.
  The run fails closed on any mismatch and suspends the automation with a reason.
- **What a grant does not change.** Writes still go through ADR-0001's unattended gate (reply or
  post to the configured destination only; everything else becomes a plan DM'd to the owner).
- **Ledger.** Each run's ledger row names the grant (`approval: 'delegated:<automationId>'`).
- **Migration.** The account-wide `allowUnattended` flag is retired. Existing run-as-me automations
  get a grant that expires 7 days after deploy, with a renewal DM.
- **IdP side.** `offline_access` is still requested only from people who create a delegated
  automation (step-up linking); everyone else's link keeps the IdP's default session policy.

### 5. Knowledge loop: thread → FAQ

Turning a resolved thread into a Gemini Enterprise document is a **write that other people will
read**, outside Slack. So it gets the strictest path.

- **Source.** Only **public, non-Slack-Connect channels**. Gemini Enterprise documents can't
  inherit a Slack channel's membership, so private-channel or DM content would leak to everyone
  who can search the data store. Admins name the channels that may contribute.
- **Draft.** `/gemini draft faq` (or *Save as FAQ* on an answer) produces a plan card. It shows the
  exact question/answer text, the source permalinks and the target data store. Like every write,
  it is drafted as the invoker.
- **Approval.** By a **knowledge steward** for that data store (named in config). The invoker can't
  approve their own FAQ unless they are a steward.
- **Write.** `documents.create` on a dedicated data store, performed by a **curator service
  account** that holds `roles/discoveryengine.editor` on that data store only. It is never the
  licensed service account and never a person.
- **Provenance.** Kept in the document's `structData`: source permalinks, drafter, approver, change
  id. A matching ledger row gets *Undo* (`documents.delete`).
- **Content.** Model output is sanitized as for any write: no mentions, no user ids. People are
  named only as they appear in the visible thread. Model Armor screens the document at ingestion as
  engine config.

## Consequences

- §1 adds a second Google identity to the deployment (admin-plane). Its grants are narrow and
  listed in SETUP §2.
- The bot still never decides who is licensed: Gemini Enterprise does. The bot reads that state and,
  only with an admin's click and opt-in config, writes it.
- §3–§5 each add one principal role (delegated user, curator SA) with a narrow, auditable scope.
  None of them lets the bot read a conversation the human can't, or write somewhere the human didn't
  approve.
- Before each of §2–§5 is built: update EXPERIENCE.md, add the contracts (`DelegationGrant`, the
  `self-scoped` auto-apply class, the `faq` actuation kind) with parser and parity updates, write
  tests against fakes, then run the security review. The same sequence was followed for §1.
