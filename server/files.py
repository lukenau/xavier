"""hub-api files module — read-only multi-root file browser.

Per ADR 011 amendment 2026-04-20 (read-only FS surface):
- Four allowlisted roots: sites, code, hub_config, launch_agents
- Each root resolved once at import; requests validate the final resolved
  path still sits within the root (rejects traversal + symlink escapes)
- Day-1 is GET-only. No write endpoints — additions to POST_ALLOWLIST_PREFIXES
  are not required. Phase 2 may add uploads under per-action WebAuthn.
- Text preview is bounded at 256 KB and rejects non-utf-8 decodes (binary
  files get kind='binary' in the listing but /read returns 415).
"""
from __future__ import annotations

import fnmatch
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, Query

MAX_READ_BYTES = 256 * 1024
MAX_ENTRIES = 500

# GETs are unauthenticated (WebAuthn gates POSTs only), so the browser must never surface
# secrets: no dotfiles (.env, .git, .ssh), the hub's own credential-bearing stores, and
# nothing named like a credential. Names are matched case-insensitively against EVERY
# component of the requested path and of the path it resolves to, so neither a parent
# directory (secrets/…) nor a symlink can launder one.
DENY_NAMES = {"passkeys.json", "home-assistant.json", "sessions.json"}
DENY_GLOBS = (".env*", "*.env", "*.pem", "*.p8", "*.p12", "*.pfx", "*.key", "id_*",
              "*credentials*", "*secret*", "*token*")


def _denied_name(name: str) -> bool:
    low = name.lower()
    return low in DENY_NAMES or any(fnmatch.fnmatchcase(low, g) for g in DENY_GLOBS)


def _launch_agent_plist(path: Path) -> bool:
    """A launchd plist routinely carries API keys in its EnvironmentVariables."""
    return path.name.lower().endswith(".plist") and "launchagents" in (p.lower() for p in path.parent.parts)


@dataclass(frozen=True)
class Root:
    id: str
    label: str
    path: Path


def _root_registry() -> dict[str, Root]:
    # HUB_FS_ROOTS="id:label:/abs/path;id2:label2:/abs/path2" sets the registry
    # wholesale (box deploys mount roots into the container). Otherwise each per-root
    # variable adds one root when set: these reads are unauthenticated, so nothing is
    # served until the operator names it.
    spec = os.environ.get("HUB_FS_ROOTS")
    if spec:
        roots = {}
        for item in filter(None, spec.split(";")):
            rid, label, path = item.split(":", 2)
            roots[rid] = Root(rid, label, Path(path))
        return roots
    entries = [
        Root(rid, label, Path(os.environ[var]).expanduser())
        for rid, label, var in (
            ("sites", "Sites", "HUB_FS_SITES"),
            ("code", "Code", "HUB_FS_CODE"),
            ("hub_config", ".hub", "HUB_FS_HUB_CONFIG"),
            ("launch_agents", "LaunchAgents", "HUB_FS_LAUNCH_AGENTS"),
        )
        if os.environ.get(var)
    ]
    return {r.id: r for r in entries}


ROOTS = _root_registry()


def _resolve_safe(root: Root, rel: str) -> Path:
    """Resolve rel under root, rejecting traversal + symlink escapes.

    Uses .resolve(strict=False) so a not-yet-existing path still resolves,
    then checks the resolved parent is under the resolved root. A missing
    leaf returns the resolved path and the caller handles 404."""
    # ".." is left to the resolve check below so traversal still reads as "path escapes root".
    if rel and any(part.startswith(".") and part != ".." for part in Path(rel).parts):
        raise HTTPException(status_code=403, detail="hidden paths are not served")
    base = root.path.resolve()
    target = (root.path / rel).resolve() if rel else base
    try:
        resolved = target.relative_to(base).parts
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="path escapes root") from exc
    parts = (Path(rel).parts if rel else ()) + resolved
    if (any(_denied_name(part) for part in parts) or any(part.startswith(".") for part in resolved)
            or _launch_agent_plist(target)):
        raise HTTPException(status_code=403, detail="file not served")
    return target


def _entry(name: str, full: Path) -> dict[str, Any]:
    try:
        st = full.stat()
    except OSError:
        return {"name": name, "kind": "unknown", "size": None, "modified": None}
    if full.is_dir():
        kind = "dir"
    elif full.is_file():
        kind = "file"
    else:
        kind = "other"
    return {
        "name": name,
        "kind": kind,
        "size": st.st_size if kind == "file" else None,
        "modified": st.st_mtime,
    }


router = APIRouter(prefix="/api/files")


@router.get("/roots")
def list_roots() -> list[dict[str, Any]]:
    return [
        {"id": r.id, "label": r.label, "path": str(r.path), "exists": r.path.exists()}
        for r in ROOTS.values()
    ]


@router.get("/browse")
def browse(
    root: str = Query(...),
    path: str = Query(""),
) -> dict[str, Any]:
    if root not in ROOTS:
        raise HTTPException(status_code=404, detail="unknown root")
    r = ROOTS[root]
    target = _resolve_safe(r, path)
    if not target.exists():
        raise HTTPException(status_code=404, detail="not found")
    if not target.is_dir():
        raise HTTPException(status_code=400, detail="not a directory")

    entries: list[dict[str, Any]] = []
    try:
        for entry in sorted(target.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower())):
            if entry.name.startswith(".") or _denied_name(entry.name) or _launch_agent_plist(entry):
                continue
            entries.append(_entry(entry.name, entry))
            if len(entries) >= MAX_ENTRIES:
                break
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail="permission denied") from exc

    return {
        "root": root,
        "root_label": r.label,
        "path": path,
        "parent": str(Path(path).parent) if path else None,
        "entries": entries,
        "truncated": len(entries) >= MAX_ENTRIES,
    }


@router.get("/read")
def read(
    root: str = Query(...),
    path: str = Query(...),
) -> dict[str, Any]:
    if root not in ROOTS:
        raise HTTPException(status_code=404, detail="unknown root")
    r = ROOTS[root]
    target = _resolve_safe(r, path)
    if not target.exists():
        raise HTTPException(status_code=404, detail="not found")
    if not target.is_file():
        raise HTTPException(status_code=400, detail="not a file")

    size = target.stat().st_size
    if size > MAX_READ_BYTES:
        raise HTTPException(status_code=413, detail=f"file larger than {MAX_READ_BYTES} bytes")

    raw = target.read_bytes()
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise HTTPException(status_code=415, detail="binary file — preview unsupported") from exc
    return {"root": root, "path": path, "size": size, "text": text}
