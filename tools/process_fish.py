#!/usr/bin/env python3
"""Turn a drawing or scan of a fish into a transparent PNG sprite.

The browser app performs the exact same processing client-side, so this CLI is
only needed for batch work or for feeding a physical scanner / capture rig.
It is a one-shot tool (no server, no file watching unless you ask for it) and
uses no hard-coded paths. Run it through the Nix flake for a pinned toolchain:

    nix run .#process -- scan.jpg            # -> out/scan.png
    nix develop                              # interactive shell
    process-fish scans/ -o out --watch       # poll a folder for new scans
"""

from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".bmp", ".webp", ".tif", ".tiff"}

# Detection parameters, matched to the browser implementation.
BLOCK_SIZE = 15
C_CONSTANT = 4
OPEN_KERNEL = 3
CLOSE_KERNEL = 3
CLOSE_ITERATIONS = 2
MAX_SIZE = 1024
MARGIN_RATIO = 0.03


def read_image(path: Path) -> np.ndarray | None:
    """Read an image with unicode-path support."""
    data = np.fromfile(str(path), dtype=np.uint8)
    if data.size == 0:
        return None
    return cv2.imdecode(data, cv2.IMREAD_UNCHANGED)


def has_alpha(img: np.ndarray) -> bool:
    if img.ndim != 3 or img.shape[2] != 4:
        return False
    alpha = img[:, :, 3]
    return bool((alpha < 250).mean() > 0.02)


def trim_rgba(img: np.ndarray) -> np.ndarray:
    """Crop to the non-transparent bounding box with a small margin."""
    alpha = img[:, :, 3]
    ys, xs = np.where(alpha > 8)
    if xs.size == 0:
        return img
    x0, x1 = int(xs.min()), int(xs.max())
    y0, y1 = int(ys.min()), int(ys.max())
    crop_w, crop_h = x1 - x0 + 1, y1 - y0 + 1
    pad = max(1, round(max(crop_w, crop_h) * MARGIN_RATIO))
    out = np.zeros((crop_h + pad * 2, crop_w + pad * 2, 4), dtype=np.uint8)
    out[pad : pad + crop_h, pad : pad + crop_w] = img[y0 : y1 + 1, x0 : x1 + 1]
    return out


def silhouette_mask(bgr: np.ndarray) -> np.ndarray | None:
    """Largest dark shape -> filled binary mask (0/255)."""
    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    thresh = cv2.adaptiveThreshold(
        gray, 255, cv2.ADAPTIVE_THRESH_MEAN_C, cv2.THRESH_BINARY_INV, BLOCK_SIZE, C_CONSTANT
    )
    kernel = np.ones((OPEN_KERNEL, OPEN_KERNEL), np.uint8)
    thresh = cv2.morphologyEx(thresh, cv2.MORPH_OPEN, kernel, iterations=1)
    thresh = cv2.morphologyEx(
        thresh, cv2.MORPH_CLOSE, kernel, iterations=CLOSE_ITERATIONS
    )

    contours, _ = cv2.findContours(thresh, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return None
    largest = max(contours, key=cv2.contourArea)
    if cv2.contourArea(largest) < gray.size * 0.002:
        return None
    mask = np.zeros(gray.shape, dtype=np.uint8)
    cv2.drawContours(mask, [largest], -1, 255, thickness=cv2.FILLED)
    return mask


def fit_within(img: np.ndarray, max_size: int) -> np.ndarray:
    h, w = img.shape[:2]
    scale = min(1.0, max_size / max(h, w))
    if scale >= 1.0:
        return img
    return cv2.resize(img, (max(1, round(w * scale)), max(1, round(h * scale))), interpolation=cv2.INTER_AREA)


def process_image(src: Path, out_dir: Path, max_size: int = MAX_SIZE) -> Path | None:
    img = read_image(src)
    if img is None:
        print(f"  ! could not read {src}", file=sys.stderr)
        return None

    img = fit_within(img, max_size)

    if has_alpha(img):
        rgba = cv2.cvtColor(img, cv2.COLOR_BGRA2RGBA)
        rgba = trim_rgba(rgba)
    else:
        bgr = img[:, :, :3] if img.ndim == 3 else cv2.cvtColor(img, cv2.COLOR_GRAY2BGR)
        mask = silhouette_mask(bgr)
        if mask is None:
            print(f"  ! no fish shape found in {src}", file=sys.stderr)
            return None
        bgra = cv2.cvtColor(bgr, cv2.COLOR_BGR2BGRA)
        bgra[:, :, 3] = mask
        rgba = cv2.cvtColor(bgra, cv2.COLOR_BGRA2RGBA)
        rgba = trim_rgba(rgba)

    out_dir.mkdir(parents=True, exist_ok=True)
    dest = out_dir / (src.stem + ".png")
    Image.fromarray(rgba, "RGBA").save(dest, "PNG")
    print(f"  ok {src.name} -> {dest}")
    return dest


def iter_inputs(paths: list[Path]) -> list[Path]:
    files: list[Path] = []
    for path in paths:
        if path.is_dir():
            files.extend(
                sorted(p for p in path.iterdir() if p.suffix.lower() in IMAGE_SUFFIXES)
            )
        elif path.suffix.lower() in IMAGE_SUFFIXES:
            files.append(path)
    return files


def watch(folder: Path, out_dir: Path, interval: float) -> None:
    seen = {p.name for p in iter_inputs([folder])}
    print(f"watching {folder} (Ctrl+C to stop)")
    try:
        while True:
            for p in iter_inputs([folder]):
                if p.name not in seen:
                    seen.add(p.name)
                    process_image(p, out_dir)
            time.sleep(interval)
    except KeyboardInterrupt:
        print("\nstopped")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("inputs", nargs="*", type=Path, help="image files and/or folders")
    parser.add_argument("-o", "--out", type=Path, default=Path("out"), help="output folder (default: out)")
    parser.add_argument("--watch", action="store_true", help="poll the input folder for new scans")
    parser.add_argument("--interval", type=float, default=1.0, help="poll interval in seconds")
    parser.add_argument("--max-size", type=int, default=MAX_SIZE, help="max output dimension in px")
    args = parser.parse_args(argv)

    if args.watch:
        if not args.inputs:
            parser.error("--watch requires an input folder")
        watch(args.inputs[0], args.out, args.interval)
        return 0

    files = iter_inputs(args.inputs)
    if not files:
        parser.error("no input images found")

    ok = sum(1 for f in files if process_image(f, args.out, args.max_size))
    print(f"done: {ok}/{len(files)} processed -> {args.out}")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
