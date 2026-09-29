# Swagpay brand kit

[Preview the kit](../public/brandkit.html) · [Download the package](../public/swagpay-brandkit.zip)

## Idea

**One ribbon, every order.** A flat ribbon turns through an S, linking sponsor payment, local printing, and delivery. Its pale rectangular upper fold gives the agent a friendly face. The full-color icon, one-color marks, mascot, and sticker are built from the same vector geometry.

Core line: **Swag, paid in stablecoins.**

## Source and delivery files

| File | Use |
| --- | --- |
| [`mascot.svg`](../public/mascot.svg) | Editable master vector artwork; scale freely for banners and print |
| [`logo.svg`](../public/logo.svg), [`logo-on-dark.svg`](../public/logo-on-dark.svg) | Primary horizontal logo on light or dark surfaces |
| [`logo-mono.svg`](../public/logo-mono.svg), [`logo-mono-light.svg`](../public/logo-mono-light.svg), [`logo-mono-magenta.svg`](../public/logo-mono-magenta.svg) | One-ink logo for stamps, shirts, and simple print jobs |
| [`mark.svg`](../public/mark.svg), [`mark-mono.svg`](../public/mark-mono.svg) | App icon, favicon, compact navigation, or one-ink icon |
| [`mascot-sticker.svg`](../public/mascot-sticker.svg) | 60 mm vector sticker with white border and a separate `CutContour` layer |
| [`mascot-sticker.pdf`](../public/mascot-sticker.pdf) | Vector proof of the sticker artwork and visible contour |
| [`mascot-cutline.svg`](../public/mascot-cutline.svg) | Isolated 60 mm cut contour for a printer's template |
| [`mascot.webp`](../public/mascot.webp), [`agent-avatar.webp`](../public/agent-avatar.webp) | Lightweight transparent character and square agent avatar for web use |
| [`mascot.png`](../public/mascot.png), [`agent-avatar.png`](../public/agent-avatar.png) | PNG fallbacks and editing references |
| [`brand-tokens.css`](../public/brand-tokens.css) | Product color and type tokens, including dark mode |

The wordmark is outlined artwork. Use the supplied file rather than retyping `swagpay`.

### Sticker production

The sticker SVG is 60 × 60 mm. The magenta hairline in the `CutContour` group marks a continuous die-cut path outside the white border; it is a production guide and must not print. Send the vector artwork to the printer and have them map `CutContour` to their required spot swatch and line weight. Confirm their bleed, safe-area, and export requirements before ordering. The isolated contour is included if their prepress workflow needs a separate layer or file.

## Color

These colors come from the current [Swagpay landing page](../../event-swag/landing/landing.css). Magenta is the stronger shirt, sticker, and campaign color. The product retains paper and white surfaces so forms and payment details stay clear.

| Role | Light | Dark | Use |
| --- | --- | --- | --- |
| Ink | `#171A38` | `#ECEEF9` | Wordmark, outlines, text |
| Magenta | `#D7266F` | `#FF5B9B` | Ribbon, primary actions, merch |
| USDC blue | `#2466C4` | `#6EA2FF` | Payment context and supporting accents |
| Paper | `#F5F6F9` | `#0F1124` | Page background and face |
| Sheet | `#FFFFFF` | `#171A33` | Cards and forms |
| Muted text | `#4A4F72` | `#A9AECB` | Secondary copy |
| Rule | `#D9DCEA` | `#2C3052` | Dividers and fields |
| Agent tint | `#FBE3EE` | `#3A1830` | Agent messages and supporting panels |
| Payment tint | `#E2ECFA` | `#182A4D` | Host/payment messages |

White on light-mode magenta is about **4.8:1** contrast. Ink on paper is about **15.7:1**; muted text on paper is about **7.3:1**. Use `#B91E5A` for small error text on paper. Keep yellow and neon out of the identity.

For one-color printing, use ink, white, or the landing magenta SVG variant. Ask the printer for a proof on the actual shirt or sticker stock; screen hex values do not define a print ink by themselves.

## Type and voice

| Role | Typeface | Treatment |
| --- | --- | --- |
| Product and brand-kit headings | Figtree | 700, sentence case |
| Body and UI | Figtree | 400–700 |
| Utility | IBM Plex Mono | Small labels, amounts, timestamps, order IDs |
| Landing campaign headline | Big Shoulders Display | 800–900, short uppercase statement on the existing landing page |

Keep product headings in sentence case beside the soft mascot. The condensed campaign headline remains a specific landing-page treatment. Use the outlined logo artwork instead of a font substitute.

Say what happened and what comes next. Be warm and specific about people, payments, and printing. For example: “I have the artwork. I’ll request a local print quote next.”

## Spacing and use

- Allow clear space around a logo equal to at least one quarter of the square mark's height.
- Use the horizontal logo at 180 px or wider on screens. Below that, use the mark.
- Keep the square mark at least 24 px wide. Use the supplied SVG favicon, with the 32 px PNG fallback.
- Keep the mascot at least 64 px tall when its expression matters; use the square mark below that.
- Preserve the supplied fold, proportions, expression, and negative space. Do not stretch or rotate the artwork.
- Use the WebP files on web pages, with PNG fallbacks where needed. Use SVG for new print sizes rather than enlarging a raster export.

## Handoff

The static preview is [`public/brandkit.html`](../public/brandkit.html). The app imports [`brand-tokens.css`](../public/brand-tokens.css) through `app.css`. Run `python3 scripts/build_brand_assets.py` after changing the mascot or wordmark master, then rebuild the downloadable ZIP.
