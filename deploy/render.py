"""Render deploy/service.yaml: validate the settings, substitute ${VARS} in one pass (env values as
quoted strings), drop env entries whose value is empty (optional settings), and fail on anything
left unresolved. Standard library only."""
import json
import os
import re
import sys

REQUIRED = [
    "SERVICE", "IMAGE", "RUNTIME_SA", "MAX_INSTANCES", "REGION", "SLACK_TEAM_ID",
    "SLACK_TEAM_DOMAIN", "PUBLIC_BASE_URL", "GE_PROJECT", "GE_LOCATION", "GE_ENGINE", "IDP_KIND",
    "IDP_ISSUER", "IDP_CLIENT_ID", "GE_SLACK_KMS_KEY", "CRON_INVOKER", "SOURCES_VERSION",
    "AGENTS_VERSION",
]

SA = r"^[a-z0-9-]+@[a-z0-9-]+\.iam\.gserviceaccount\.com$"
# Values that land outside a quoted env value must match a strict shape (no YAML injection).
SHAPES = {
    "SERVICE": r"^[a-z][a-z0-9-]{0,62}$",
    "MAX_INSTANCES": r"^[1-9][0-9]{0,3}$",
    "RUNTIME_SA": SA,
    "CRON_INVOKER": SA,
    "IMAGE": r"^[a-z0-9.-]+(:[0-9]+)?/[A-Za-z0-9._/-]+(:[A-Za-z0-9._-]+)?(@sha256:[0-9a-f]{64})?$",
    "REGION": r"^[a-z]+-[a-z]+[0-9]+$",
    "SOURCES_VERSION": r"^(latest|[1-9][0-9]*)$",
    "AGENTS_VERSION": r"^(latest|[1-9][0-9]*)$",
}

# Cloud Run regions that keep processing inside each Gemini Enterprise location's residency.
RESIDENCY = {
    "eu": ("europe-",),
    "us": ("us-",),
    "ca": ("northamerica-northeast",),
    "in": ("asia-south",),
    "sg": ("asia-southeast1",),
    "asia-northeast1": ("asia-northeast1",),
    "europe-west2": ("europe-west2",),
}


def validate(env: dict) -> None:
    missing = [k for k in REQUIRED if not env.get(k)]
    if env.get("IDP_KIND") == "oidc":
        missing += [k for k in ("WIF_POOL_ID", "WIF_PROVIDER_ID") if not env.get(k)]
    if env.get("GE_SERVICE_MODE", "none") != "none" and not env.get("GE_SERVICE_ACCOUNT"):
        missing.append("GE_SERVICE_ACCOUNT")
    if missing:
        raise SystemExit(f"missing required settings: {', '.join(missing)}")
    for key, value in env.items():
        if re.search(r"[\x00-\x1f\x7f]", value or "") and key in REQUIRED:
            raise SystemExit(f"{key} contains control characters")
    for key, shape in SHAPES.items():
        if not re.match(shape, env[key]):
            raise SystemExit(f"{key} has an unexpected value: {env[key]!r}")
    if not env["PUBLIC_BASE_URL"].startswith("https://"):
        raise SystemExit("PUBLIC_BASE_URL must be https")
    location, region = env["GE_LOCATION"], env["REGION"]
    if location == "global":
        if env.get("ALLOW_GLOBAL_REGION") != "1":
            raise SystemExit("GE_LOCATION=global: set ALLOW_GLOBAL_REGION=1 to confirm any region")
    elif not region.startswith(RESIDENCY.get(location, ("\0",))):
        raise SystemExit(f"REGION {region} is outside the GE_LOCATION={location} residency")


PLACEHOLDER = re.compile(
    r"^(?P<pre>\s*value: )\$\{(?P<key>[A-Z_]+)\}$|\$\{(?P<bare>[A-Z_]+)\}", re.M
)


def render(template: str, env: dict) -> str:
    validate(env)
    unset = sorted(
        {m.group("bare") for m in PLACEHOLDER.finditer(template) if m.group("bare")}
        - {k for k, v in env.items() if v}
    )
    if unset:
        raise SystemExit(f"template placeholders without a value: {', '.join(unset)}")

    def sub(m: "re.Match[str]") -> str:
        if m.group("key"):  # `value: ${X}` → a quoted YAML string, or empty (dropped below)
            value = env.get(m.group("key"), "")
            return m.group("pre") + (json.dumps(value) if value else "")
        return env[m.group("bare")]  # validated shapes only (see SHAPES)

    # One pass: a value containing "${…}" is never expanded again.
    out = PLACEHOLDER.sub(sub, template)
    lines = out.splitlines()
    kept = []
    i = 0
    while i < len(lines):
        name = re.match(r"^\s*- name: [A-Z_]+$", lines[i])
        nxt = lines[i + 1] if i + 1 < len(lines) else ""
        if name and re.match(r"^\s*value:\s*$", nxt):
            i += 2  # optional setting left empty: omit it entirely
            continue
        kept.append(lines[i])
        i += 1
    return "\n".join(kept) + "\n"


if __name__ == "__main__":
    src, dst = sys.argv[1], sys.argv[2]
    with open(src, encoding="utf8") as f:
        text = render(f.read(), dict(os.environ))
    with open(dst, "w", encoding="utf8") as f:
        f.write(text)
    print(f"rendered {dst}")
