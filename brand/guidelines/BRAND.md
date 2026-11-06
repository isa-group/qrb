# QRB brand kit

**Name:** QRB. Long form: Quantum Resource Binder. Never “Qrb”, “Q.R.B.” or “QRB™”.

## The mark: “Bound Q”
- **Ring:** the circuit.
- **Amber core:** what you declare matters.
- **Violet tail and node:** the binding to the one QPU that wins.

The colour mark is for hero moments. The **mono marks are the workhorses**: use them on photos, ASCII backdrops, merch, slides, embroidery, one-colour print and anywhere the background is busy.

## Which file
| Need | File |
|---|---|
| Site header (dark) | `logo/svg/qrb-lockup-color-on-dark.svg` |
| Docs, papers, print (light) | `logo/svg/qrb-lockup-color-on-light.svg` or `…-mono-ink.svg` |
| Footer, partner logos, one colour | `logo/svg/qrb-lockup-mono-white.svg` / `-mono-ink.svg` / `-mono-black.svg` |
| Brand moment, accent on dark | `logo/svg/qrb-mark-mono-violet.svg` |
| With descriptor | `logo/svg/qrb-lockup-descriptor-*.svg` |
| Square spaces | `logo/svg/qrb-stacked-*.svg` |
| Under 24 px | `logo/svg/qrb-mark-small-*.svg` (heavier strokes, no core) |
| Favicon, PWA, touch icon | `web/` + paste `web/head-snippet.html` |
| iOS / Android | `app/ios/`, `app/android/` (adaptive foreground, background, monochrome) |
| Social, README, talks | `media/` |

All wordmark text in the SVGs is outlined, so no font install is needed.

## Rules
- **Clear space:** keep one node diameter (14/64 of mark height) clear on all sides.
- **Minimum size:** 24 px for the full mark; 16 px for the small mark.
- **Tail:** keep the tail at 45°. In colour versions it is always violet.
- **Don't** rotate, outline, stretch, recolour single parts, or add gradients or shadows to the vector.
- **Glow:** belongs only to the ASCII treatment (`media/qrb-ascii-mark*`).
- **Mono versions:** use one colour only: white, ink, black or violet.

## Colour
| Token | Hex | Use |
|---|---|---|
| ink | #0E1320 | Primary ground |
| text | #E8EAF0 | Ring, headings (15:1 on ink) |
| violet | #A78BFA | Binding, primary CTA (ink text on it) |
| amber | #F2A93B | Core, ASCII art |
| violet-on-light | #6D4AE0 | Binding on paper |
| amber-on-light | #C9780A | Core on paper |

## Type
- **Display and wordmark:** Inter Display 600, −0.035em.
- **Body:** Inter.
- **Code and labels:** JetBrains Mono.

## Media placeholders
`media/slide-title-1920x1080.png` has [TALK TITLE] · [SPEAKER] · [VENUE, DATE] placeholders. Regenerate with `build.py` after editing.
