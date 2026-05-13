"""Generate placeholder marketing assets for GregSweeper.

Produces:
- assets/og-card.png         (1200x630, social-share card)
- assets/icon-maskable-512.png (512x512, Android adaptive icon with 40% safe zone)

These are functional placeholders. Re-run after design polish to refresh.
Re-run is idempotent (overwrites existing files).
"""

from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
ASSETS = ROOT / "assets"

NAVY = (26, 26, 46)
NAVY_LIGHT = (46, 46, 74)
ACCENT = (92, 107, 192)
TEXT = (240, 240, 255)
TEXT_DIM = (180, 180, 210)
RED = (231, 76, 60)

def _load_font(size: int) -> ImageFont.FreeTypeFont:
    """Try a couple of common system fonts; fall back to default."""
    for name in (
        "C:\\Windows\\Fonts\\segoeui.ttf",
        "C:\\Windows\\Fonts\\arialbd.ttf",
        "C:\\Windows\\Fonts\\arial.ttf",
        "DejaVuSans-Bold.ttf",
        "Arial.ttf",
    ):
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            continue
    return ImageFont.load_default()

def gradient(size: tuple[int, int], top: tuple[int, int, int], bottom: tuple[int, int, int]) -> Image.Image:
    """Vertical gradient fill."""
    w, h = size
    img = Image.new("RGB", size, top)
    px = img.load()
    for y in range(h):
        t = y / max(1, h - 1)
        r = int(top[0] * (1 - t) + bottom[0] * t)
        g = int(top[1] * (1 - t) + bottom[1] * t)
        b = int(top[2] * (1 - t) + bottom[2] * t)
        for x in range(w):
            px[x, y] = (r, g, b)
    return img

def mine_icon(size: int) -> Image.Image:
    """Stylised mine — circle with spikes — for visual punctuation."""
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    cx = cy = size // 2
    r = int(size * 0.32)
    spike_r = int(size * 0.46)
    spike_w = max(2, size // 20)
    # spikes (8 directions)
    for ang in range(0, 360, 45):
        from math import cos, sin, radians
        x = cx + spike_r * cos(radians(ang))
        y = cy + spike_r * sin(radians(ang))
        d.line([(cx, cy), (x, y)], fill=NAVY, width=spike_w)
    # body
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=NAVY)
    # highlight
    hi_r = int(r * 0.32)
    hi_x = cx - int(r * 0.4)
    hi_y = cy - int(r * 0.4)
    d.ellipse([hi_x - hi_r, hi_y - hi_r, hi_x + hi_r, hi_y + hi_r], fill=TEXT)
    return img

def generate_og_card() -> None:
    """1200x630 social-share card."""
    img = gradient((1200, 630), NAVY, NAVY_LIGHT)
    d = ImageDraw.Draw(img)

    # Wordmark
    font_brand = _load_font(112)
    font_tag = _load_font(40)
    font_small = _load_font(28)

    # Brand line
    brand = "GregSweeper"
    d.text((80, 160), brand, fill=TEXT, font=font_brand)

    # Accent rule under brand
    d.rectangle([(80, 300), (200, 308)], fill=ACCENT)

    # Tagline
    d.text((80, 340), "The daily Minesweeper", fill=TEXT, font=font_tag)
    d.text((80, 395), "with no guesses.", fill=TEXT, font=font_tag)

    # Footer line
    d.text((80, 530), "One puzzle  ·  Ten modifiers  ·  Free in your browser", fill=TEXT_DIM, font=font_small)

    # Mine icon, right side
    mi = mine_icon(260)
    img.paste(mi, (840, 185), mi)

    # Smaller red mine icon for "no guesses" emphasis
    mi2 = mine_icon(80)
    img.paste(mi2, (1060, 460), mi2)
    # Strike-through line over small mine
    d.line([(1050, 530), (1170, 460)], fill=RED, width=8)

    ASSETS.mkdir(parents=True, exist_ok=True)
    out = ASSETS / "og-card.png"
    img.save(out, "PNG", optimize=True)
    print(f"Wrote {out}")

def generate_maskable_icon() -> None:
    """512x512 maskable icon. Content fills central 60% (308px) safe zone;
    background fills full 512x512 so any mask shape clips into solid color."""
    canvas = Image.new("RGB", (512, 512), NAVY)

    # Reuse the existing 512 icon if available — scale it to 60% and centre.
    source = ASSETS / "icon-512.png"
    if source.exists():
        src = Image.open(source).convert("RGBA")
        safe = int(512 * 0.60)  # 307 px
        src = src.resize((safe, safe), Image.LANCZOS)
        off = (512 - safe) // 2
        canvas.paste(src, (off, off), src if src.mode == "RGBA" else None)
    else:
        # Fallback: draw a centered mine on navy background
        mi = mine_icon(307)
        canvas.paste(mi, ((512 - 307) // 2, (512 - 307) // 2), mi)

    out = ASSETS / "icon-maskable-512.png"
    canvas.save(out, "PNG", optimize=True)
    print(f"Wrote {out}")

if __name__ == "__main__":
    generate_og_card()
    generate_maskable_icon()
    print("Done.")
