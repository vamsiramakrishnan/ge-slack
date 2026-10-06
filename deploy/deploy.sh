#!/usr/bin/env bash
# Build and deploy the bot to Cloud Run, then (re)create the Cloud Scheduler tick.
#
#   deploy/deploy.sh                # build, deploy, schedule
#   deploy/deploy.sh --render-only  # just render deploy/service.yaml (used by CI)
#
# Settings come from the environment (see docs/SETUP.md §5): PROJECT, REGION, SERVICE, RUNTIME_SA,
# the GE_*/SLACK_*/IDP_* values, and the Secret Manager secrets named in deploy/service.yaml.
# Secret values are read from Secret Manager by gcloud and never echoed.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(dirname "$here")"
out="${RENDERED:-$(mktemp -d)/service.yaml}"

export SERVICE="${SERVICE:-ge-slack}"
export MAX_INSTANCES="${MAX_INSTANCES:-10}"
export IDP_KIND="${IDP_KIND:-oidc}"
export GE_SERVICE_MODE="${GE_SERVICE_MODE:-none}"
: "${REGION:?set REGION (a Cloud Run region inside the GE_LOCATION residency)}"
: "${PROJECT:?set PROJECT}"
export IMAGE="${IMAGE:-${REGION}-docker.pkg.dev/${PROJECT}/ge-slack/ge-slack:$(git -C "$root" rev-parse --short HEAD)}"

python3 "$here/render.py" "$here/service.yaml" "$out"
if [[ "${1:-}" == "--render-only" ]]; then
  exit 0
fi

gcloud builds submit "$root" --project "$PROJECT" --region "$REGION" --tag "$IMAGE"
gcloud run services replace "$out" --project "$PROJECT" --region "$REGION"

# Cloud Scheduler drives automations: POST /cron/tick every minute with the shared secret.
cron_secret="$(gcloud secrets versions access latest --secret ge-slack-cron-secret --project "$PROJECT")"
verb=create
headers_flag=--headers
if gcloud scheduler jobs describe ge-slack-tick --project "$PROJECT" --location "$REGION" >/dev/null 2>&1; then
  verb=update
  headers_flag=--update-headers
fi
gcloud scheduler jobs "$verb" http ge-slack-tick --project "$PROJECT" --location "$REGION" \
  --schedule '* * * * *' --uri "${PUBLIC_BASE_URL%/}/cron/tick" --http-method POST \
  "${headers_flag}=X-GE-Cron-Secret=${cron_secret}" --attempt-deadline 60s >/dev/null
unset cron_secret

echo "Deployed ${SERVICE}. Point the Slack manifest URLs at ${PUBLIC_BASE_URL%/}/slack/events,"
echo "then run: bun run probe   (see docs/SETUP.md §6)"
