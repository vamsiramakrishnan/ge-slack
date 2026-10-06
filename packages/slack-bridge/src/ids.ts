/** Block Kit action/callback ids. One table so app wiring and renderers can't drift. */
export const ACTIONS = {
  approve: 'ge_approve',
  cancel: 'ge_cancel',
  edit: 'ge_edit',
  share: 'ge_share',
  followUp: 'ge_followup',
  feedback: 'ge_feedback',
  connect: 'ge_connect',
  useService: 'ge_use_service',
  undo: 'ge_undo',
  autoCreate: 'ge_auto_create',
  autoCancel: 'ge_auto_cancel',
  autoToggle: 'ge_auto_toggle',
  autoRunNow: 'ge_auto_run_now',
  autoDelete: 'ge_auto_delete',
  allowUnattended: 'ge_allow_unattended',
  disconnect: 'ge_disconnect',
  quickStart: 'ge_quick_start',
  related: 'ge_related',
  /** Per-row Post/Skip on a review findings table; suffixed `_<n>` (unique per block). */
  findingToggle: 'ge_finding_toggle',
  openPolicy: 'ge_open_policy',
  /** Paused agents (ADR-0002): start a research plan, open the reply modal, retry, authorize. */
  agentStart: 'ge_agent_start',
  agentReply: 'ge_agent_reply',
  agentRetry: 'ge_agent_retry',
  agentAuthorize: 'ge_agent_authorize',
  /** Forget one channel note; value `<channel>:<noteId>`. */
  memoryForget: 'ge_memory_forget',
  /** Admin: DM the 30-day ledger CSV. */
  exportLedger: 'ge_export_ledger',
  /** Cancel one of your background jobs; value = job id. */
  jobCancel: 'ge_job_cancel',
} as const;

export const CALLBACKS = {
  composer: 'ge_composer',
  planEdit: 'ge_plan_edit',
  policy: 'ge_policy',
  messageAsk: 'ge_msg_ask',
  messageSummarize: 'ge_msg_summarize',
  messageDraftReply: 'ge_msg_draft_reply',
  messageReview: 'ge_msg_review',
  messageCanvas: 'ge_msg_canvas',
  messageRemember: 'ge_msg_remember',
  globalNew: 'ge_global_new',
  agentReply: 'ge_agent_reply_modal',
} as const;

export const WORKFLOW_STEPS = {
  ask: 'ge_ask',
  summarize: 'ge_summarize',
  draft: 'ge_draft',
} as const;
