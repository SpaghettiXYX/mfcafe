#!/usr/bin/env python3
"""
Convert arbitrary images into the exact format the screen expects:
800 x 1280, baseline JPEG, cover-cropped (no distortion).

The admin panel already does this in the browser before uploading, so this
script is only for bulk/offline preparation:

    python3 prepare_posters.py src/*.png -o ../poster-fw/posters
"""
from __future__ import annotations

import argparse
import os

from PIL import Image

W, H = 800, 1280


def cover_resize(img: Image.Image) -> Image.Image:
    img = img.convert("RGB")
    scale = max(W / img.width, H / img.height)
    nw, nh = max(W, round(img.width * scale)), max(H, round(img.height * scale))
    img = img.resize((nw, nh), Image.LANCZOS)
    left = (nw - W) // 2
    top = (nh - H) // 2
    return img.crop((left, top, left + W, top + H))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("inputs", nargs="+")
    ap.add_argument("-o", "--out", required=True)
    ap.add_argument("-q", "--quality", type=int, default=88)
    args = ap.parse_args()

    os.makedirs(args.out, exist_ok=True)
    for i, path in enumerate(args.inputs):
        out = os.path.join(args.out, f"{i:04d}_{os.path.splitext(os.path.basename(path))[0]}.jpg")
        with Image.open(path) as img:
            cover_resize(img).save(out, "JPEG", quality=args.quality, optimize=True)
        print(f"{path} -> {out} ({os.path.getsize(out) // 1024} KB)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
