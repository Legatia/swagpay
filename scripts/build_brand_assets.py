"""Build standalone Swagpay logo and sticker SVGs from one ribbon silhouette."""

from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
PUBLIC = ROOT / "public"
source = (PUBLIC / "mascot.svg").read_text()
wordmark_source = (PUBLIC / "wordmark.svg").read_text()

art = re.search(r'<g id="ribbon-art">.*?</g>', source, re.S)
silhouette = re.search(r'<path id="silhouette" d="([^"]+)"', source)
wordmark = re.search(r'<g fill="#171A38" aria-hidden="true">.*?</g>', wordmark_source, re.S)
if not (art and silhouette and wordmark):
    raise SystemExit("Missing ribbon or wordmark source geometry")
ART = art.group(0)
SILHOUETTE = silhouette.group(1)
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


def icon(color: str = INK, tile: bool = True) -> str:
    bg = f'  <rect x=".75" y=".75" width="78.5" height="78.5" rx="16" fill="{PAPER}" stroke="{INK}" stroke-width="1.5"/>\n' if tile else ""
    if color == "full":
        shape = f'  <g transform="scale(.333333333)">\n{ART}\n  </g>'
    else:
        shape = f'  <path d="{SILHOUETTE}" transform="scale(.333333333)" fill="{color}"/>'
    return bg + shape


def logo(name: str, title: str, icon_body: str, word_color: str) -> None:
    letters = WORDMARK.replace(f'fill="{INK}"', f'fill="{word_color}"', 1)
    svg(name, "0 0 298 80", title, icon_body + "\n" + letters)


svg("mark.svg", "0 0 80 80", "Swagpay ribbon mark", icon("full"))
logo("logo.svg", "Swagpay logo", icon("full"), INK)
logo("logo-on-dark.svg", "Swagpay logo for dark backgrounds", icon("full"), PAPER)
for suffix, color in (("", INK), ("-light", PAPER), ("-magenta", MAGENTA)):
    svg(f"mark-mono{suffix}.svg", "0 0 80 80", "Swagpay one-color ribbon mark", icon(color, tile=False))
    logo(f"logo-mono{suffix}.svg", "Swagpay one-color logo", icon(color, tile=False), color)

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
