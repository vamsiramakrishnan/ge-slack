# Live testing — iterate on real Slack and Gemini Enterprise

The loop: deploy (or run locally in Socket Mode), run `/gemini diag`, walk the checklist for the
feature you're testing, and record the outcome in [STATUS.md](STATUS.md). Each feature is behind
`GE_FEATURES`, so you can switch one on in a sandbox while it settles.

## 0. Set up a sandbox

1. **Engine side first:** `bun run probe` (SETUP §6) as yourself, then `--as service`. Fix
   anything red before touching Slack: Slack only adds noise on top of an engine problem.
2. **Slack app:** create it from `manifests/slack-app.manifest.json` in a sandbox workspace.
   - For a local loop, enable Socket Mode, set `SLACK_APP_TOKEN` (`xapp-…`), and run `bun run dev`.
     No public URL is needed.
   - For Cloud Run, run `deploy/deploy.sh` and point the manifest URLs at `${PUBLIC_BASE_URL}/slack/events`.
3. **Features:** `GE_FEATURES=default` (memory, analytics, jobs, diag). Add `,connector-actions`
   only when you're testing §5.
4. **Logs:** `gcloud run services logs tail ge-slack --region $REGION`, or the local console.
   Logs never contain message content or tokens. A turn that fails shows
   `[ge-slack] turn failed: …` with a redacted reason.

## 1. Diagnostics (`diag`)

| Step | Expect |
|---|---|
| `/gemini diag` before connecting | 🔓 Identity line naming the policy; no Gemini call |
| `/gemini connect`, then `/gemini diag` | ✅ Identity as you · your email; ✅ Access; ✅ Gemini answered in N s |
| Set `@unit` to a federated source you haven't authorized, then `diag` | ⚠️ Sources … not authorized: <name>, plus an *Authorize sources* link |
| `/gemini diag service` in a channel with service read off | 🏢 / 🚫 lines say the service may not read it |
| `GE_FEATURES=-diag`, redeploy, `/gemini diag` | "Diagnostics are switched off" |
