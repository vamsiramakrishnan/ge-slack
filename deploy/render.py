"""Render deploy/service.yaml: substitute ${VARS} from the environment, drop env entries whose
value is empty (optional settings), and fail on anything left unresolved. Standard library only."""
import json
import os
import re
import sys

REQUIRED = [
    "SERVICE", "IMAGE", "RUNTIME_SA", "MAX_INSTANCES", "SLACK_TEAM_ID", "SLACK_TEAM_DOMAIN",
    "PUBLIC_BASE_URL", "GE_PROJECT", "GE_LOCATION", "GE_ENGINE", "IDP_KIND", "IDP_ISSUER",
    "IDP_CLIENT_ID", "GE_SLACK_KMS_KEY",
]


def render(template: str, env: dict) -> str:
    missing = [k for k in REQUIRED if not env.get(k)]
    if missing:
        raise SystemExit(f"missing required settings: {', '.join(missing)}")
    if not env["PUBLIC_BASE_URL"].startswith("https://"):
        raise SystemExit("PUBLIC_BASE_URL must be https")
    # env values are emitted as JSON strings (valid YAML), so ": " or "#" in a value is harmless.
    out = re.sub(
        r"^(\s*value: )\$\{([A-Z_]+)\}$",
        lambda m: m.group(1) + (json.dumps(env[m.group(2)]) if env.get(m.group(2)) else ""),
        template,
        flags=re.M,
    )
    out = re.sub(r"\$\{([A-Z_]+)\}", lambda m: env.get(m.group(1), ""), out)
    lines = out.splitlines()
    kept = []
    i = 0
    while i < len(lines):
        name = re.match(r"^(\s*)- name: [A-Z_]+$", lines[i])
        nxt = lines[i + 1] if i + 1 < len(lines) else ""
        if name and re.match(r"^\s*value:\s*$", nxt):
            i += 2  # optional setting left empty: omit it entirely
            continue
        kept.append(lines[i])
        i += 1
    rendered = "\n".join(kept) + "\n"
    if "${" in rendered:
        raise SystemExit("unresolved ${...} placeholders remain")
    return rendered


if __name__ == "__main__":
    src, dst = sys.argv[1], sys.argv[2]
    with open(src, encoding="utf8") as f:
        text = render(f.read(), dict(os.environ))
    with open(dst, "w", encoding="utf8") as f:
        f.write(text)
    print(f"rendered {dst}")
