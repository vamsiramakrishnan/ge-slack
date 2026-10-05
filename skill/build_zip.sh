#!/usr/bin/env bash
# Build a reproducible skill bundle zip: ./build_zip.sh <skill-dir>   (default: slack-surface-commander)
#
# The archive holds SKILL.md at its root plus references/, patterns/, scripts/ and assets/ — the
# layout Gemini Enterprise unpacks into `instruction` + `subfiles` on a skill agent upload. Files are
# sorted, timestamps fixed and permissions normalized, so identical sources give identical zips.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
skill="${1:-slack-surface-commander}"
skill="${skill%/}"
src="$here/$skill"
out="$here/$skill.zip"

[[ -f "$src/SKILL.md" ]] || { echo "build_zip: $src/SKILL.md not found" >&2; exit 1; }
head -n1 "$src/SKILL.md" | grep -qx -- '---' || {
  echo "build_zip: $skill/SKILL.md must start with YAML frontmatter (---)" >&2; exit 1; }
grep -q "^name: $skill\$" "$src/SKILL.md" || {
  echo "build_zip: frontmatter name must equal the directory name ($skill)" >&2; exit 1; }

python3 - "$src" "$out" <<'PY'
import os, sys, zipfile
src, out = sys.argv[1], sys.argv[2]
SKIP_DIRS = {"__pycache__", ".pytest_cache"}
files = []
for root, dirs, names in os.walk(src):
    dirs[:] = sorted(d for d in dirs if d not in SKIP_DIRS and not d.startswith("."))
    for n in names:
        if n.startswith(".") or n.endswith((".pyc", ".zip")):
            continue
        files.append(os.path.relpath(os.path.join(root, n), src))
tmp = out + ".tmp"
with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as z:
    for rel in sorted(files):
        info = zipfile.ZipInfo(rel.replace(os.sep, "/"), date_time=(1980, 1, 1, 0, 0, 0))
        info.compress_type = zipfile.ZIP_DEFLATED
        mode = 0o755 if rel.endswith((".py", ".sh")) else 0o644
        info.external_attr = (0o100000 | mode) << 16
        with open(os.path.join(src, rel), "rb") as f:
            z.writestr(info, f.read())
os.replace(tmp, out)
print(f"built {out} ({len(files)} files)")
PY
