#!/usr/bin/env python3
"""Bakes static TTF instances of the PWA's variable fonts for React Native.

RN on iOS has no variable-font axis API (fontVariationSettings is an open
proposal), so every intermediate weight the Hub PWA actually uses has to be
baked into its own static TTF. Source: the woff2 variable fonts vendored by
the PWA's own dependencies (read-only — never copy into apps/hub/).

Weight set: this project's task brief cited {400,450,500,520,550,580,620,640}
as "the audited set (inventory/theme.md §fonts)", but that citation was
stale. A fresh grep of apps/hub/src for every fontWeight literal + Tailwind
weight class (see task-3-report.md for the full command + counts) found:
  {400, 500, 520, 540, 550, 560, 580, 600, 620, 640, 650, 700, 800}
— 450 is used nowhere; 540/560/600/650/700/800 are used (600 alone: 42
call sites, including most chips/buttons; 700 includes the header wordmark).
SANS_WEIGHTS below is that verified set, not the brief's.

MONO_WEIGHTS is a strict subset of SANS_WEIGHTS. A fix-round audit of every
weight's call site — checking same-element `font-mono` + `fontWeight`,
conditional class expressions, `...mono` SVG style spreads, and (per
ancestor -> descendant) whether a weighted element ever wraps or is wrapped
by a `font-mono` element with no fontWeight of its own — found 540/560/580/
640 are sans-only everywhere they appear (every site is a sibling-only
pattern: a plain-text title next to, never containing or contained by, a
separate font-mono metadata span). See task-3-report.md "Mono weight audit"
for the full per-site evidence and confidence level. The other 9 weights
each have at least one confirmed mono-reachable site (direct same-element,
conditional same-element, or ancestor inheritance) and keep both statics.

Stylistic sets: RESEARCH.md's settled call was ss01/ss03 stay runtime-toggled
(RN fontVariant, no freezing needed) and cv10 needs pyftfeatfreeze (no
runtime API for character variants). That assumed the vendored Onest build
actually has ss01/ss03/cv10. It doesn't: `pyftfeatfreeze -r` on the decoded
variable font reports only `calt,ccmp,locl,pnum,tnum` — no stylistic sets or
character variants at all (verified below and in task-3-report.md). The CSS
`font-feature-settings: "ss01","ss03","cv10"` in globals.css is therefore
already a no-op in the live PWA for this font version. We still run
pyftfeatfreeze -f cv10 on every Onest instance per the brief (harmless,
forward-compatible if a future Onest upgrade adds the feature) but it is
presently a no-op — do not expect any glyph difference on-device.

OFL: neither font declares a Reserved Font Name (checked LICENSE, metadata,
and the binary's own name table — see task-3-report.md), so renaming isn't
legally forced, but we do it anyway (OFL best practice for a modified font,
avoids OS-level collision with the unmodified variable font). OFL section 2
requires the licence text to travel with redistributed copies regardless of
renaming — OFL-Onest.txt / OFL-JetBrainsMono.txt sit next to the TTFs in
assets/fonts/, copied verbatim from the source packages' LICENSE files.

Usage:
    python3 instance-fonts.py            # write assets/fonts/*.ttf
    python3 instance-fonts.py --report   # print GSUB features + weight plan, no writes

Requires (scratch venv — never installed into the repo):
    python3 -m venv .venv && .venv/bin/pip install fonttools brotli opentype-feature-freezer
"""
import argparse
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont

SCRIPT_DIR = Path(__file__).resolve().parent
HUB_APP_DIR = SCRIPT_DIR.parent
REPO_ROOT = HUB_APP_DIR.parent.parent
FONTSOURCE_DIR = REPO_ROOT / "apps/hub/node_modules/@fontsource-variable"

ONEST_SRC = FONTSOURCE_DIR / "onest/files/onest-latin-wght-normal.woff2"
MONO_SRC = FONTSOURCE_DIR / "jetbrains-mono/files/jetbrains-mono-latin-wght-normal.woff2"
OUT_DIR = HUB_APP_DIR / "assets/fonts"

ONEST_LICENSE_SRC = FONTSOURCE_DIR / "onest/LICENSE"
MONO_LICENSE_SRC = FONTSOURCE_DIR / "jetbrains-mono/LICENSE"

# Verified against apps/hub/src (see module docstring + task-3-report.md).
SANS_WEIGHTS = [400, 500, 520, 540, 550, 560, 580, 600, 620, 640, 650, 700, 800]
MONO_WEIGHTS = [400, 500, 520, 550, 600, 620, 650, 700, 800]

FAMILIES = {
    "sans": {
        "src": ONEST_SRC,
        "license_src": ONEST_LICENSE_SRC,
        "license_out": "OFL-Onest.txt",
        "rename": "HubOnest",
        "weights": SANS_WEIGHTS,
        "freeze_cv10": True,
    },
    "mono": {
        "src": MONO_SRC,
        "license_src": MONO_LICENSE_SRC,
        "license_out": "OFL-JetBrainsMono.txt",
        "rename": "HubMono",
        "weights": MONO_WEIGHTS,
        "freeze_cv10": False,
    },
}


def report_plan() -> None:
    for cfg in FAMILIES.values():
        font = TTFont(str(cfg["src"]))
        tags = (
            sorted({fr.FeatureTag for fr in font["GSUB"].table.FeatureList.FeatureRecord})
            if "GSUB" in font
            else []
        )
        print(f"{cfg['src'].name}: GSUB features = {tags or '(none)'}")
        print(f"  -> {cfg['rename']}-{{weight}}.ttf for weights {cfg['weights']}")


def rename_font(font: TTFont, new_name: str) -> None:
    """OFL Reserved Font Name compliance: give every instanced/feature-frozen
    static its own family name distinct from the upstream Onest/JetBrains
    Mono, and distinct per weight (RN has no runtime weight matching, so
    each weight is its own "family" as far as fontFamily is concerned).
    Also rewrites nameID 3 (unique font identifier) — iOS font registration
    keys on name-table identity, and instancer leaves it at the *source*
    variable font's single unique ID for every weight, so all 13 outputs
    per family would otherwise share one identifier."""
    name_table = font["name"]
    for name_id in (1, 2, 3, 4, 6, 16, 17):
        name_table.removeNames(nameID=name_id)
    for platform_id, plat_enc_id, lang_id in ((3, 1, 0x409), (1, 0, 0)):
        name_table.setName(new_name, 1, platform_id, plat_enc_id, lang_id)          # Family
        name_table.setName("Regular", 2, platform_id, plat_enc_id, lang_id)         # Subfamily
        name_table.setName(f"{new_name};HubApp;1.0", 3, platform_id, plat_enc_id, lang_id)  # Unique ID
        name_table.setName(new_name, 4, platform_id, plat_enc_id, lang_id)          # Full name
        name_table.setName(new_name, 6, platform_id, plat_enc_id, lang_id)          # PostScript name

    os2 = font["OS/2"]
    os2.fsSelection = (os2.fsSelection & ~0x21) | 0x40  # clear ITALIC/BOLD, set REGULAR
    font["head"].macStyle = 0


def instance_one(src_font: TTFont, weight: int, family_rename: str) -> TTFont:
    inst = instantiateVariableFont(src_font, {"wght": weight}, inplace=False)
    inst.flavor = None
    rename_font(inst, f"{family_rename}-{weight}")
    return inst


def freeze_cv10(path: Path) -> None:
    with tempfile.NamedTemporaryFile(suffix=".ttf", delete=False) as tmp:
        tmp_path = Path(tmp.name)
    cmd = ["pyftfeatfreeze", "-f", "cv10", str(path), str(tmp_path)]
    subprocess.run(cmd, check=True)
    shutil.move(str(tmp_path), str(path))
    path.chmod(0o644)  # NamedTemporaryFile defaults to 0600; match repo convention
    print("  $ " + " ".join(cmd) + f"   # in-place over {path.name}")


def pin_timestamp(path: Path) -> None:
    """pyftfeatfreeze loads/saves the font itself, outside our
    recalcTimestamp=False instance, and re-stamps head.modified to "now" —
    the one remaining source of non-determinism between two runs. Reset it
    to head.created (stable: it comes straight from the untouched source
    variable font) on every output file, frozen or not, so the set is
    byte-identical across regenerations."""
    font = TTFont(str(path), recalcTimestamp=False)
    font["head"].modified = font["head"].created
    font.save(str(path))
    path.chmod(0o644)


def assert_unique_names(paths: list[Path]) -> None:
    seen: dict[tuple[int, str], Path] = {}
    for p in paths:
        font = TTFont(str(p))
        for name_id in (3, 6):
            value = font["name"].getDebugName(name_id)
            key = (name_id, value)
            if key in seen:
                raise SystemExit(f"nameID {name_id} collision: {p.name} and {seen[key].name} both '{value}'")
            seen[key] = p


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--report", action="store_true", help="print GSUB features + weight plan only, no writes")
    args = ap.parse_args()

    for cfg in FAMILIES.values():
        if not cfg["src"].exists():
            print(f"ERROR: source font not found: {cfg['src']}", file=sys.stderr)
            return 1
        if not cfg["license_src"].exists():
            print(f"ERROR: source license not found: {cfg['license_src']}", file=sys.stderr)
            return 1

    if args.report:
        report_plan()
        return 0

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    written = []
    for cfg in FAMILIES.values():
        shutil.copyfile(cfg["license_src"], OUT_DIR / cfg["license_out"])
        # recalcTimestamp=False: keep the source variable font's head.modified
        # (identical across every weight cut from it) instead of stamping
        # "now" on save, so regenerating the set twice is byte-identical.
        src_font = TTFont(str(cfg["src"]), recalcTimestamp=False)
        for weight in cfg["weights"]:
            inst = instance_one(src_font, weight, cfg["rename"])
            out_path = OUT_DIR / f"{cfg['rename']}-{weight}.ttf"
            inst.save(str(out_path))
            if cfg["freeze_cv10"]:
                freeze_cv10(out_path)
            pin_timestamp(out_path)
            written.append(out_path)
            print(f"wrote {out_path.relative_to(REPO_ROOT)} ({out_path.stat().st_size} bytes)")

    assert_unique_names(written)

    total = sum(p.stat().st_size for p in written)
    print(f"\n{len(written)} files, {total} bytes total ({total / 1024:.1f} KiB)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
