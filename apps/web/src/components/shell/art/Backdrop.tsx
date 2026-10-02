/**
 * The backdrop: one pale picture fixed behind the whole page, the stickers
 * and tiles over it, as spx6900.com lays its page over an illustration.
 * Travellers carrying an SPX banner on a cliff on the left, Ethereum's
 * crystal with the SPX coin sealed inside on the right, a quiet sky and
 * plain between them behind the centre column.
 *
 * This element draws nothing itself: theme.css ("Art") fixes it behind the
 * page where there are three columns (85em), and apps/web/src/backdrop.css
 * names the picture (assets/backdrop, whose README says how it was made) and
 * places it from the layout's measures, so the banner's print and the
 * crystal's coin stay clear of the stickers. The picture is a file of the
 * app's own, never fetched from anywhere else, and never named below 85em or
 * on an iPhone or iPad, so no phone loads it.
 *
 * Decoration only: `spdex-art` keeps it from the pointer and hides it under
 * more contrast, forced colours and print. No motion. Rendered once, as the
 * first child of `.spdex-app`, never in the centre column.
 */

export function Backdrop() {
  return <div className="spdex-art spdex-bgart" aria-hidden="true" data-art="backdrop" />;
}
