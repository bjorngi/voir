#!/usr/bin/env python3
"""Generate the Voir PWA icon set.

Design: a chat bubble in amber (the app's "agent working" accent)
on the app's near-black background, with a dark "V" monogram inside.

Outputs into public/icons/:
  icon-192.png          regular launcher icon (rounded corners, alpha)
  icon-512.png          regular launcher icon (rounded corners, alpha)
  icon-maskable-512.png full-bleed square, content inside the 80% safe zone
  apple-touch-icon.png  180x180 full-bleed square (iOS applies its own mask)

Run:  python3 bin/gen-icons.py
"""
from PIL import Image, ImageDraw, ImageFont

BG = (11, 13, 16, 255)        # #0b0d10 — app body background
AMBER = (251, 191, 36, 255)   # #fbbf24 — amber-400, the "busy" accent
FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"

def rounded_bg(size, radius_ratio):
    """Square canvas with a rounded-rect background (alpha corners).
    radius_ratio=0 → full-bleed square (for maskable / apple-touch)."""
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    if radius_ratio <= 0:
        d.rectangle([0, 0, size - 1, size - 1], fill=BG)
    else:
        r = int(size * radius_ratio)
        d.rounded_rectangle([0, 0, size - 1, size - 1], radius=r, fill=BG)
    return img, d

def bubble(d, size, scale=1.0, cy_ratio=0.45):
    """Chat bubble: amber circle + tail, centered. Content scale lets the
    maskable variant shrink into the safe zone."""
    cx = size / 2
    cy = size * cy_ratio
    r = size * 0.29 * scale
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=AMBER)
    # Tail: triangle from the lower-left of the bubble pointing down
    tx0, ty0 = cx - r * 0.55, cy + r * 0.62
    tx1, ty1 = tx0, ty0 + r * 0.62
    tx2, ty2 = cx - r * 0.05, ty0 + r * 0.28
    d.polygon([(tx0, ty0), (tx1, ty1), (tx2, ty2)], fill=AMBER)

def monogram(d, size, cy_ratio=0.45, scale=1.0):
    """Dark 'V' centered in the bubble, sized against the bubble radius."""
    cy = size * cy_ratio
    r = size * 0.29 * scale
    font_size = int(r * 1.15)
    font = ImageFont.truetype(FONT, font_size)
    bbox = d.textbbox((0, 0), "V", font=font)
    w, h = bbox[2] - bbox[0], bbox[3] - bbox[1]
    d.text((size / 2 - w / 2 - bbox[0], cy - h / 2 - bbox[1]), "V",
           font=font, fill=BG)

def make_icon(size, path, rounded=True, content_scale=1.0):
    img, d = rounded_bg(size, 0.22 if rounded else 0)
    bubble(d, size, scale=content_scale)
    monogram(d, size, scale=content_scale)
    img.save(path)
    print("wrote", path)

if __name__ == "__main__":
    import os
    os.makedirs("public/icons", exist_ok=True)
    make_icon(192, "public/icons/icon-192.png")
    make_icon(512, "public/icons/icon-512.png")
    # Maskable: full bleed, content shrunk to the ~80% safe zone
    make_icon(512, "public/icons/icon-maskable-512.png", rounded=False,
              content_scale=0.8)
    # Apple touch icon: full-bleed square, iOS rounds it itself
    make_icon(180, "public/icons/apple-touch-icon.png", rounded=False,
              content_scale=0.82)