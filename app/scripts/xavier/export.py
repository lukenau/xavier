#!/usr/bin/env python3
"""Export chosen candidates and build contact sheets.

Usage: python export.py <id>=<cand.png> [...]   export picks to assets/xavier/<id>.jpg
       python export.py --sheet                  rebuild out/contact-sheet.png
Needs: pillow. Poses keep their own dark backdrop — they are shown as LED tiles.
"""
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

HERE = Path(__file__).resolve().parent
ASSETS = HERE.parent.parent / "assets" / "xavier"
OUT = HERE / "out"
SIZE = 600
ORDER = ["portrait", "bow", "tray-empty", "tray-offer", "sniffing", "ledger", "ears-up",
         "tilt", "oops", "triumph", "asleep", "pyjamas", "party"]


def export(src: Path, dst: Path):
    img = Image.open(src).convert("RGB")
    side = min(img.size)
    left, top = (img.width - side) // 2, (img.height - side) // 2
    img.crop((left, top, left + side, top + side)).resize((SIZE, SIZE), Image.LANCZOS).save(
        dst, quality=86, optimize=True, progressive=True
    )


def sheet(bg, fg, name):
    cols, rows, cell, label = 5, 3, 320, 40
    img = Image.new("RGB", (cols * cell, rows * (cell + label)), bg)
    draw = ImageDraw.Draw(img)
    try:
        font = ImageFont.truetype("DejaVuSans.ttf", 22)
    except OSError:
        font = ImageFont.load_default()
    for i, pid in enumerate(ORDER):
        x, y = (i % cols) * cell, (i // cols) * (cell + label)
        p = ASSETS / f"{pid}.jpg"
        if p.exists():
            img.paste(Image.open(p).convert("RGB").resize((cell - 20, cell - 20), Image.LANCZOS), (x + 10, y + 10))
        tw = draw.textlength(pid, font=font)
        draw.text((x + (cell - tw) / 2, y + cell + 6), pid, fill=fg, font=font)
    img.save(OUT / name, optimize=True)


def main(argv):
    if argv == ["--sheet"]:
        sheet("#000d0e", "#f0ab5e", "contact-sheet.png")
        return
    ASSETS.mkdir(parents=True, exist_ok=True)
    for pair in argv:
        pid, src = pair.split("=", 1)
        dst = ASSETS / f"{pid}.jpg"
        export(Path(src), dst)
        print(pid, dst.stat().st_size)


if __name__ == "__main__":
    main(sys.argv[1:])
