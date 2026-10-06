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
export SOURCES_VERSION="${SOURCES_VERSION:-latest}" AGENTS_VERSION="${AGENTS_VERSION:-latest}"
: "${REGION:?set REGION (a Cloud Run region inside the GE_LOCATION residency)}"
export REGION
: "${PROJECT:?set PROJECT}"
export IMAGE="${IMAGE:-${REGION}-docker.pkg.dev/${PROJECT}/ge-slack/ge-slack:$(git -C "$root" rev-parse --short HEAD)}"

python3 "$here/render.py" "$here/service.yaml" "$out"
if [[ "${1:-}" == "--render-only" ]]; then
  exit 0
fi

gcloud builds submit "$root" --project "$PROJECT" --region "$REGION" --tag "$IMAGE"
gcloud run services replace "$out" --project "$PROJECT" --region "$REGION"

# Slack reaches the bot unauthenticated at the Cloud Run layer; every request is authenticated in
# the app (Slack signing secret; Cloud Scheduler OIDC on /cron/tick). An org policy restricting
# allUsers bindings will refuse this: then front the service with a load balancer instead.
gcloud run services add-iam-policy-binding "$SERVICE" --project "$PROJECT" --region "$REGION" \
  --member allUsers --role roles/run.invoker >/dev/null

# Cloud Scheduler drives automations: POST /cron/tick every minute with a Google-signed OIDC token
# for CRON_INVOKER (no shared secret in the job, argv or gcloud logs).
base="${PUBLIC_BASE_URL%/}"
verb=create
if gcloud scheduler jobs describe ge-slack-tick --project "$PROJECT" --location "$REGION" >/dev/null 2>&1; then
  verb=update
fi
gcloud scheduler jobs "$verb" http ge-slack-tick --project "$PROJECT" --location "$REGION" \
  --schedule '* * * * *' --uri "${base}/cron/tick" --http-method POST \
  --oidc-service-account-email "$CRON_INVOKER" --oidc-token-audience "${base}/cron/tick" \
  --attempt-deadline 60s >/dev/null

echo "Deployed ${SERVICE}. Point the Slack manifest URLs at ${PUBLIC_BASE_URL%/}/slack/events,"
echo "then run: bun run probe   (see docs/SETUP.md §6)"
