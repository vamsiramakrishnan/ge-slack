"""Validate the built skill archives against the exact current source bytes (stdlib only)."""
from pathlib import Path
from zipfile import ZipFile

ROOT = Path(__file__).resolve().parent
SKILLS = ("slack-command-planner", "slack-surface-commander")

def validate() -> None:
    for name in SKILLS:
        source = ROOT / name
        expected = {
            path.relative_to(source).as_posix(): path.read_bytes()
            for path in source.rglob("*")
            if path.is_file()
            and not any(part.startswith(".") or part in {"__pycache__", ".pytest_cache"}
                        for part in path.relative_to(source).parts)
            and path.suffix not in {".pyc", ".zip"}
        }
        frontmatter = expected["SKILL.md"].decode().split("---", 2)[1]
        if f"name: {name}" not in frontmatter or "description:" not in frontmatter:
            raise ValueError(f"{name}: missing name/description frontmatter")
        with ZipFile(ROOT / f"{name}.zip") as archive:
            if len(archive.namelist()) != len(set(archive.namelist())):
                raise ValueError(f"{name}: duplicate archive entries")
            actual = {item.filename: archive.read(item) for item in archive.infolist()}
        if actual != expected:
            raise ValueError(f"{name}: archive is stale or differs from source")
        print(f"{name}: {len(expected)} exact-source files verified")

if __name__ == "__main__":
    validate()
