"""Generate the "detection paused" toolbar icons.

The normal icon is a blue-to-teal gradient rounded square. Two signals are
combined so the state reads at 16px, where a lone grey tint is indistinguishable
from a loading placeholder and a thin slash disappears into the artwork:

  * a desaturated, dimmed copy of the original art (colour = "off")
  * a thick diagonal bar (shape = "blocked")

At 16/32 the bar is drawn wider relative to the canvas and the drop shadow is
dropped, because antialiasing eats both at that size. The diagonal is drawn with
a polygon rather than a line so its width is exact at every scale.
"""

from PIL import Image, ImageDraw, ImageEnhance, ImageFilter

SIZES = [16, 32, 48, 96, 128]
SOURCE = "public/icon/%d.png"
TARGET = "public/icon/paused-%d.png"

# Same hue family as the active/amber state used in the panel, dark enough to
# stay legible on both light and dark toolbars.
BAR_COLOR = (71, 85, 105, 255)      # slate-600
BAR_EDGE = (248, 250, 252, 255)     # slate-50 hairline, keeps it off the art


def muted(base: Image.Image) -> Image.Image:
    """Grey the art down without making it look like a different product."""
    rgb = base.convert("RGB")
    grey = ImageEnhance.Color(rgb).enhance(0.15)
    dimmed = ImageEnhance.Brightness(grey).enhance(0.82)
    out = dimmed.convert("RGBA")
    # Preserve the original alpha so the rounded corners stay transparent.
    out.putalpha(base.getchannel("A"))
    return out


def draw_bar(image: Image.Image, size: int) -> Image.Image:
    draw = ImageDraw.Draw(image, "RGBA")

    # Bar thickness as a fraction of the canvas: chunky at small sizes so the
    # slash survives 16px rasterisation, proportionally thinner when large.
    if size <= 16:
        width = size * 0.30
        inset = size * 0.06
    elif size <= 32:
        width = size * 0.24
        inset = size * 0.08
    else:
        width = size * 0.20
        inset = size * 0.10

    # A diagonal from bottom-left to top-right, inset from the corners so the
    # rounded-square silhouette still reads underneath it.
    x0 = inset
    y0 = size - inset
    x1 = size - inset
    y1 = inset

    # Unit normal of the line, used to give the bar its width.
    dx, dy = x1 - x0, y1 - y0
    length = (dx * dx + dy * dy) ** 0.5
    nx, ny = -dy / length, dx / length
    half = width / 2

    quad = [
        (x0 + nx * half, y0 + ny * half),
        (x1 + nx * half, y1 + ny * half),
        (x1 - nx * half, y1 - ny * half),
        (x0 - nx * half, y0 - ny * half),
    ]

    # Hairline first, slightly wider than the bar, so the bar separates from a
    # dark toolbar background as well as from the icon art.
    if size >= 32:
        edge = max(1.0, width * 0.16)
        ehalf = half + edge
        edge_quad = [
            (x0 + nx * ehalf, y0 + ny * ehalf),
            (x1 + nx * ehalf, y1 + ny * ehalf),
            (x1 - nx * ehalf, y1 - ny * ehalf),
            (x0 - nx * ehalf, y0 - ny * ehalf),
        ]
        draw.polygon(edge_quad, fill=BAR_EDGE)

    draw.polygon(quad, fill=BAR_COLOR)

    if size >= 48:
        # A soft contact shadow lifts the bar off the artwork at large sizes.
        shadow = Image.new("RGBA", image.size, (0, 0, 0, 0))
        sdraw = ImageDraw.Draw(shadow, "RGBA")
        sdraw.polygon(quad, fill=(15, 23, 42, 90))
        shadow = shadow.filter(ImageFilter.GaussianBlur(size * 0.02))
        image = Image.alpha_composite(image, shadow)
        draw = ImageDraw.Draw(image, "RGBA")
        draw.polygon(quad, fill=BAR_COLOR)

    return image


def main() -> None:
    for size in SIZES:
        base = Image.open(SOURCE % size).convert("RGBA")
        out = muted(base)
        out = draw_bar(out, size)
        out.save(TARGET % size, "PNG", optimize=True)
        print("wrote", TARGET % size)


if __name__ == "__main__":
    main()
