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
  globalNew: 'ge_global_new',
} as const;

export const WORKFLOW_STEPS = {
  ask: 'ge_ask',
  summarize: 'ge_summarize',
  draft: 'ge_draft',
} as const;
