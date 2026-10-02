/**
 * The footer: the disclaimer in one line, and the ways to the rest of it.
 *
 * Every claim in the line is the disclaimer's, in brief, and holds for the
 * same reasons (lib/disclaimer.ts lists the sources). "Disclaimer" opens the
 * full text again, for review; "Check this build" goes to the place in
 * Settings that shows how. The source and feedback links show only when the
 * publisher set them (lib/links.ts): spDEX never guesses where its own source
 * is, or where people should write. Feedback shows on the first-run screen
 * too: whoever is stuck there is who most needs to say so.
 *
 * The key hints sit here, except where a wide screen pins them to the
 * corner; they are rendered once, and the stylesheet moves them.
 *
 * On the first-run screen there are no tiles and no Settings yet, so neither
 * the key hints (they describe tiles) nor "Check this build" (it goes to a
 * Settings section) is shown until a network service is chosen.
 *
 * Rendered after `<main>`, so it is the page's `contentinfo` landmark and a
 * screen reader can jump to the disclaimer line.
 */

import { KeyHints } from "@spdex/ui";
import { FOOTER_LINE } from "../../lib/disclaimer.js";
import { feedbackUrl, sourceUrl } from "../../lib/links.js";
import { GoTo } from "../../lib/places.js";

export function Footer({ onDisclaimer, firstRun = false }: { onDisclaimer: () => void; firstRun?: boolean }) {
  const source = sourceUrl();
  const feedback = feedbackUrl();
  return (
    <footer className="spdex-footer" data-testid="footer">
      <p className="spdex-footer__rule" aria-hidden="true">
        <span>spDEX</span>
      </p>
      <p className="spdex-footer__line">{FOOTER_LINE}</p>
      <ul className="spdex-footer__links">
        <li>
          <button type="button" className="spdex-footer__link" data-testid="footer-disclaimer" onClick={onDisclaimer}>
            Disclaimer
          </button>
        </li>
        {firstRun ? null : (
          <li>
            <GoTo place="trust">Check this build</GoTo>
          </li>
        )}
        <li>AGPL-3.0-or-later</li>
        {source !== null ? (
          <li>
            <a href={source} target="_blank" rel="noreferrer noopener" data-testid="footer-source">
              Source ↗
            </a>
          </li>
        ) : null}
        {feedback !== null ? (
          <li>
            <a href={feedback} target="_blank" rel="noreferrer noopener" data-testid="footer-feedback">
              Feedback ↗
            </a>
          </li>
        ) : null}
      </ul>
      <p className="spdex-footer__ethos">No servers · No tracking</p>
      {firstRun ? null : <KeyHints />}
    </footer>
  );
}
