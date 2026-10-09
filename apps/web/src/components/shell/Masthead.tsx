/**
 * The masthead: the page's one `h1`, spDEX (in its own case), with
 * COMMUNITY PROJECT directly under it at every width (spDEX must never look
 * like it is spx6900.com, or speak for SPX6900), the tagline, and
 * Aa DISPLAY, which shows the display dock in place.
 *
 * Aa DISPLAY is a disclosure, not a dialog: `aria-expanded` on the button,
 * the dock in flow under the masthead, no focus trap. Where the layout pins
 * the dock (theme.css, windows at least 90em wide, at every text size) the
 * dock is always shown and the button is hidden.
 */

export const DISPLAY_DOCK_ID = "display-dock";

export function Masthead({ displayOpen, onToggleDisplay }: { displayOpen: boolean; onToggleDisplay: () => void }) {
  return (
    <header className="spdex-masthead" data-testid="masthead">
      <h1 className="spdex-masthead__title">spDEX</h1>
      <p className="spdex-masthead__community" data-testid="masthead-community">
        Community project
      </p>
      <p className="spdex-masthead__tagline">Swap and auto-buy SPX.</p>
      <button
        type="button"
        id="display-open"
        className="spdex-masthead__display"
        data-testid="display-open"
        aria-expanded={displayOpen}
        aria-controls={DISPLAY_DOCK_ID}
        onClick={onToggleDisplay}
      >
        <span aria-hidden="true" className="spdex-masthead__aa">
          Aa
        </span>{" "}
        Display
      </button>
    </header>
  );
}
