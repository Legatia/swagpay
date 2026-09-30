"""Build Swagpay print-registration logos and a separate mascot sticker."""

from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
PUBLIC = ROOT / "public"
source = (PUBLIC / "mascot.svg").read_text()
wordmark_source = (PUBLIC / "wordmark.svg").read_text()

art = re.search(r'<g id="ribbon-art">.*?</g>', source, re.S)
wordmark = re.search(r'<g fill="#171A38" aria-hidden="true">.*?</g>', wordmark_source, re.S)
if not (art and wordmark):
    raise SystemExit("Missing mascot or wordmark source geometry")
ART = art.group(0)
WORDMARK = wordmark.group(0)
INK = "#171A38"
PAPER = "#F5F6F9"
MAGENTA = "#D7266F"


def svg(name: str, viewbox: str, title: str, body: str, size: str = "") -> None:
    dimensions = f" {size}" if size else ""
    (PUBLIC / name).write_text(
        f'<svg xmlns="http://www.w3.org/2000/svg"{dimensions} viewBox="{viewbox}" role="img" aria-labelledby="title">\n'
        f'  <title id="title">{title}</title>\n{body}\n</svg>\n'
    )


def icon(color: str = INK, tile: bool = False) -> str:
    # Four print-registration corners frame a small payment-blue plate.
    # The symbol stays distinct from the agent's S-shaped ribbon.
    corners = "M20 33V20h13 M47 20h13v13 M60 47v13H47 M33 60H20V47"
    if tile:
        return (
            f'<rect width="80" height="80" rx="18" fill="{MAGENTA}"/>'
            f'<path d="{corners}" fill="none" stroke="#FFFFFF" stroke-width="7" stroke-linecap="square"/>'
            '<rect x="35" y="35" width="10" height="10" fill="#2466C4"/>'
        )
    return (
        f'<path d="{corners}" fill="none" stroke="{color}" stroke-width="7" stroke-linecap="square"/>'
        f'<rect x="35" y="35" width="10" height="10" fill="{color}"/>'
    )


def logo(name: str, title: str, word_color: str, icon_body: str) -> None:
    letters = WORDMARK.replace(f'fill="{INK}"', f'fill="{word_color}"', 1)
    svg(
        name, "0 18 258 56", title,
        f'<g transform="translate(0 21) scale(.625)">{icon_body}</g>\n'
        f'<g transform="translate(-31 0)">{letters}</g>',
    )


svg("mark.svg", "0 0 80 80", "Swagpay print-registration mark", icon(tile=True))
logo("logo.svg", "Swagpay logo", INK, icon(tile=True))
logo("logo-on-dark.svg", "Swagpay logo for dark backgrounds", PAPER, icon(tile=True))
for suffix, color in (("", INK), ("-light", PAPER), ("-magenta", MAGENTA)):
    svg(f"mark-mono{suffix}.svg", "0 0 80 80", "Swagpay one-color registration mark", icon(color))
    logo(f"logo-mono{suffix}.svg", "Swagpay one-color logo", color, icon(color))

# At 60 mm square, 12 viewBox units are 3 mm. The white border reaches
# approximately 3 mm beyond the artwork. A printer maps CutContour to its
# required spot-color swatch during prepress.
CUT = (
    "M109 1C140 0 179 7 197 14C212 19 218 30 213 47L205 70"
    "C201 83 202 94 208 105C219 120 217 135 211 147"
    "C218 173 208 202 186 222"
    "C170 237 128 239 94 237C54 234 31 226 28 206"
    "C24 187 31 167 50 155C39 143 31 128 29 112"
    "C24 83 37 55 54 36C74 13 92 2 109 1Z"
)
svg(
    "mascot-sticker.svg", "0 0 240 240", "Swagpay die-cut sticker with CutContour",
    f'  <g id="WhiteBorder"><path d="{CUT}" fill="#FFFFFF"/></g>\n'
    f'  {ART}\n'
    f'  <g id="CutContour"><path d="{CUT}" fill="none" stroke="#FF00FF" stroke-width=".7"/></g>',
    'width="60mm" height="60mm"',
)
svg(
    "mascot-cutline.svg", "0 0 240 240", "Swagpay sticker cut contour",
    f'  <g id="CutContour"><path d="{CUT}" fill="none" stroke="#FF00FF" stroke-width=".7"/></g>',
    'width="60mm" height="60mm"',
)
