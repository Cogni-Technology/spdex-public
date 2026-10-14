/**
 * The first-visit tour's welcome card: what spDEX is, in a sentence, and the
 * way into the tour or past it.
 *
 * In the disclaimer's frame (`spdex-gate`), so the two read as one popup's two
 * pages rather than two popups. A modal like it: focus stays inside, the page
 * behind is inert, and the dialog itself takes focus, never a button (UI rule
 * R2). Enter, once the card has been up for a moment (`TOUR_ARM_MS`), is
 * "Show me around": the key that continued past the disclaimer can't also
 * start the tour. Esc and "Skip the tour" skip it.
 *
 * The picture sits beside the words on a wide card and above them on a narrow
 * one, sized to the window so the card never needs scrolling to reach its
 * buttons; the second paragraph shows only beside the picture, where there is
 * room for it. The picture's source and licence: assets/tour/README.md.
 */

import { useEffect, useId, useRef, useState } from "react";
import { TOUR_ARM_MS, TOUR_HELLO } from "../../lib/tour.js";
import { useModal } from "../useModal.js";
import helloPicture from "../../assets/tour/hello.jpg";
import "./tour.css";

export function TourHello({ onGo, onSkip }: { onGo: () => void; onSkip: () => void }) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const bodyId = useId();
  const [armed, setArmed] = useState(false);
  const skip = useRef(onSkip);
  skip.current = onSkip;

  useEffect(() => {
    const timer = setTimeout(() => setArmed(true), TOUR_ARM_MS);
    return () => clearTimeout(timer);
  }, []);

  useModal(dialogRef, () => skip.current());

  const go = () => {
    if (armed) onGo();
  };

  return (
    <div className="spdex-modal__backdrop spdex-gate__backdrop spdex-hello__backdrop" data-testid="tour-hello-backdrop">
      <div
        className="spdex-modal spdex-gate spdex-hello"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        data-testid="tour-hello"
        tabIndex={-1}
        ref={dialogRef}
        onKeyDown={(event) => {
          if (event.key !== "Enter" || event.repeat || event.target !== event.currentTarget) return;
          event.preventDefault();
          go();
        }}
      >
        <div className="spdex-hello__grid">
          <figure className="spdex-hello__art">
            <img src={helloPicture} width={946} height={1280} alt={TOUR_HELLO.imageAlt} />
          </figure>
          <div className="spdex-hello__text">
            {/* The brackets hold to their words, as the disclaimer's chip does. */}
            <p className="spdex-gate__chip spdex-hello__chip">{`[ ${TOUR_HELLO.chip} ]`}</p>
            <h2 className="spdex-gate__title spdex-hello__title" id={titleId}>
              {TOUR_HELLO.title}
            </h2>
            <p className="spdex-hello__body" id={bodyId}>
              {TOUR_HELLO.body}
            </p>
            <p className="spdex-hello__body spdex-hello__more" data-testid="tour-hello-more">
              {TOUR_HELLO.more}
            </p>
            <div className="spdex-hello__actions">
              <button
                type="button"
                className="spdex-button"
                data-testid="tour-go"
                aria-disabled={armed ? undefined : true}
                onClick={go}
              >
                {TOUR_HELLO.go} <span aria-hidden="true">↵</span>
              </button>
              <button type="button" className="spdex-linkbutton spdex-hello__skip" data-testid="tour-skip-hello" onClick={onSkip}>
                {TOUR_HELLO.skip}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
