# The backdrop

`backdrop.avif` and `backdrop.webp` are the picture behind the page where it
has three columns (85em and wider). `apps/web/src/components/shell/art/Backdrop.tsx`
is the element, `apps/web/src/backdrop.css` names the picture and places it,
and `packages/ui/src/theme.css` ("Art") fixes the layer behind the page.

Both files are 2560 × 1440 and carry the same grade. The AVIF (AV1 4:4:4,
crf 26, 70,465 bytes) is what a browser that can choose by `type()` loads.
The WebP (quality 80, 108,690 bytes) is for every other browser.

## How it was made

The picture was generated on a local machine from text prompts with Krea 2
Turbo (fp8 weights, run in ComfyUI: 8 steps, euler, cfg 1). Under the Krea 2
Community License, Krea claims no rights in the outputs. In short, the prompt
asked for this:

- A wide, pale panorama in the manner of Moebius and French ligne claire: fine
  grey ink, silver washes, high-key and nearly colourless, with no lettering.
- On the left, a cliff of crystal bedrock etched with circuit traces, where
  travellers hold banners on poles, with small flying sailing ships beside
  them.
- On the right, a floating clear crystal octahedron (the model's drawing, not
  the Ethereum logo glyph) above a camp of tents, lanterns and a binary-tree
  tree.
- In the middle, a calm sky over a plain that fades to mist, where the centre
  column sits.

Next came edits from scripts rather than the model: the lead banner's folds
and pole, and the coins, described below. After that the same model redrew
small areas at low denoise (inpainting), such as the glass over the
crystal's coin and a thin ring around the banner print's rim. The logo's own
letters were put back exactly afterwards. Last, the whole was graded to
near-monochrome, with only the coins keeping a pale gold.

The full prompts, seeds and scripts are kept outside this repository. This
section is their summary.

## The coin

The coin sealed inside the crystal, and printed on the lead traveller's
banner, is SPX6900's logo. It was composited from the logo file, not drawn by
the model: the logo's own letters were only moved geometrically to follow the
cloth, and graded to match the drawing. It is used the way the SPX6900
community uses it, to say what the page is for.

The logo is SPX6900's mark, and the repository's licence does not cover it
(README, License). UI rule R8 in `docs/ARCHITECTURE.md`, which copies no
wording or artwork from spx6900.com, names it as its one exception.

spDEX stays a community project that speaks for nobody but itself, and
nothing in this picture says otherwise.

## Replacing it

Replace both files together, keep the name and the 2560 × 1440 size, and keep
each file under 160 KB (`apps/web/src/no-requests.test.ts` checks this). Then
look at `apps/web/src/backdrop.css` again: it places this picture's banner
print (x 134-233, y 579-683) and crystal coin (x 1933-2080, y 468-632), in the
picture's pixels, and no other picture's. `e2e/shell.spec.ts` ("the backdrop")
holds the same two boxes and fails where either lands under a sticker, the
widget or the centre column.
