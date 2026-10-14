# The welcome card's picture

`hello.jpg` is the picture on the first-visit tour's welcome card
(`apps/web/src/components/tour/TourHello.tsx`). It is bundled with the app
and served from the page's own origin: nothing is fetched from anywhere else
(AGENTS.md rule 4; the CSP's `img-src 'self' data:`).

- **What it is.** A community meme: a golf course, with the caption
  "FINANCIAL ADVISOR: PUT ONLY 3% YOUR NETWORTH IN BITCOIN" and the reply
  "ME: 3% BTC, 97% SPX6900".
- **Where it came from.** Shared in a Telegram chat; saved on 2026-10-13
  (946 × 1280, JPEG, 258,129 bytes, SHA-256
  `2a7e9e478863f62ae61375974f8d2e6ab75074837d9faee5fdb039bc77ab827c`).
- **Licence.** Unknown. It was not made for spDEX, its author is not known,
  and it carries no licence. It shows real people. It is not under the
  repository's licence.
- **Why it is here anyway.** The publisher chose it on 2026-10-14, knowing
  the above, as the second exception to UI rule R8 (docs/ARCHITECTURE.md):
  original artwork only, but for the SPX6900 logo in the backdrop and this
  picture. Its caption is a joke, not advice: the disclaimer's "Jokes aren't
  claims" and "Not advice" cover it.

To replace it, put another picture here under the same name (or change the
import in `TourHello.tsx` and its `width` and `height`), update this file,
and keep `TOUR_HELLO.imageAlt` (lib/tour.ts) describing what it shows.
