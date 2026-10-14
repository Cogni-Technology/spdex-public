/**
 * The tour's walk round the page: a spotlight on one place at a time, and a
 * bubble that says what it is (lib/tour.ts has the stops and the words).
 *
 * The spotlight is one fixed layer over the window: the page dimmed, with a
 * hole round each place and a lime ring on it. The dimmed part takes every
 * click; the hole takes them too, except at the one stop that is meant to be
 * used (choosing a service), where clicks pass through to the page. The page
 * itself is inert at every other stop (App), so a key can't reach it either.
 * The wheel and a finger still scroll the page, and the layer follows: it is
 * measured again on every frame while the tour is up.
 *
 * Where there are three columns (85em), the bubble sits beside the place, in
 * the column next to it. Narrower, it is a sheet along the bottom with the
 * title, two arrows and the words, and a bar along the top holds the count,
 * "Hide text" and "Skip tour"; each stop scrolls its place into the band
 * between them.
 *
 * The bubble takes focus at each stop, never one of its buttons and never a
 * control on the page (UI rule R2). Enter on it is Next, once the stop has
 * been up a moment (`TOUR_ARM_MS`); Esc ends the tour.
 */

import { useEffect, useId, useRef, useState } from "react";
import { scrollBehavior } from "../../lib/a11y.js";
import {
  TOUR_ARM_MS,
  TOUR_STOPS,
  besideWidth,
  placeBubble,
  scrollToShow,
  stopTargets,
  type Box,
  type TourStop,
} from "../../lib/tour.js";
import "./tour.css";

/** Where the page has three columns, and room for a bubble beside a place. */
const WIDE = "(min-width: 85em)";

/** How far the hole and its ring stand off the place. */
const PAD = 8;

/** The bubble's own width, as tour.css has it: 18.75rem. */
const BUBBLE_REM = 18.75;

function useWide(): boolean {
  const [wide, setWide] = useState(() => typeof window !== "undefined" && window.matchMedia(WIDE).matches);
  useEffect(() => {
    const query = window.matchMedia(WIDE);
    const change = () => setWide(query.matches);
    change();
    query.addEventListener("change", change);
    return () => query.removeEventListener("change", change);
  }, []);
  return wide;
}

/** The places a stop frames that are on the page and laid out. */
function placesOf(stop: TourStop, sheet: boolean): HTMLElement[] {
  return stopTargets(stop, sheet)
    .map((selector) => document.querySelector<HTMLElement>(selector))
    .filter((el): el is HTMLElement => el !== null && el.getClientRects().length > 0);
}

function boxOf(rect: DOMRect): Box {
  return { x: rect.left, y: rect.top, w: rect.width, h: rect.height };
}

/** One box round all of them. */
function around(boxes: readonly Box[]): Box | null {
  if (boxes.length === 0) return null;
  const left = Math.min(...boxes.map((b) => b.x));
  const top = Math.min(...boxes.map((b) => b.y));
  const right = Math.max(...boxes.map((b) => b.x + b.w));
  const bottom = Math.max(...boxes.map((b) => b.y + b.h));
  return { x: left, y: top, w: right - left, h: bottom - top };
}

const holePath = (b: Box) =>
  `M${Math.round(b.x - PAD)} ${Math.round(b.y - PAD)}h${Math.round(b.w + 2 * PAD)}v${Math.round(b.h + 2 * PAD)}h${-Math.round(b.w + 2 * PAD)}Z`;

export function TourGuide({
  index,
  ready,
  onNext,
  onBack,
  onEnd,
}: {
  /** The stop on screen, in TOUR_STOPS. */
  index: number;
  /** An interactive stop is done (a service is chosen): Next may move on. */
  ready: boolean;
  onNext: () => void;
  onBack: () => void;
  onEnd: () => void;
}) {
  const stop = TOUR_STOPS[index]!;
  const count = TOUR_STOPS.length;
  const last = index === count - 1;
  const sheet = !useWide();
  const [textShown, setTextShown] = useState(true);
  const [armed, setArmed] = useState(false);
  const bubbleRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const shadeRef = useRef<SVGPathElement>(null);
  const catchRef = useRef<SVGPathElement>(null);
  const ringRef = useRef<SVGPathElement>(null);
  const titleId = useId();
  const bodyId = useId();

  const waiting = stop.interactive === true && !ready;
  const canNext = armed && !waiting;
  const next = () => {
    if (canNext) onNext();
  };

  // Each stop: its words shown, Next held a moment, focus on the bubble.
  useEffect(() => {
    setTextShown(true);
    setArmed(false);
    bubbleRef.current?.focus({ preventScroll: true });
    const timer = setTimeout(() => setArmed(true), TOUR_ARM_MS);
    return () => clearTimeout(timer);
  }, [index]);

  // Each stop, and each switch between bubble and sheet: its place scrolled
  // into view, once its tile has opened and laid it out.
  useEffect(() => {
    let cancelled = false;
    let frames = 90;
    let settled = 0;
    let lastKey = "";
    const look = () => {
      if (cancelled) return;
      const boxes = placesOf(stop, sheet).map((el) => boxOf(el.getBoundingClientRect()));
      const box = around(boxes);
      const key = box === null ? "" : `${Math.round(box.y)}:${Math.round(box.h)}`;
      // Two frames alike in a row: the tile has finished opening.
      settled = key !== "" && key === lastKey ? settled + 1 : 0;
      lastKey = key;
      if (box === null || settled < 2) {
        if (frames-- > 0) requestAnimationFrame(look);
        return;
      }
      const viewHeight = window.innerHeight;
      const top = sheet ? (barRef.current?.getBoundingClientRect().bottom ?? 0) + PAD : 0;
      const bottom = sheet ? (bubbleRef.current?.getBoundingClientRect().top ?? viewHeight) - PAD : viewHeight;
      const by = scrollToShow(box, { top, bottom });
      if (by !== 0) window.scrollBy({ top: by, behavior: scrollBehavior() });
    };
    requestAnimationFrame(look);
    return () => {
      cancelled = true;
    };
  }, [stop, sheet]);

  // The spotlight and the bubble's place, measured on every frame while the
  // tour is up: scrolling, a tile opening, the window resized.
  useEffect(() => {
    let raf = 0;
    let last = "";
    const frame = () => {
      raf = requestAnimationFrame(frame);
      const boxes = placesOf(stop, sheet).map((el) => boxOf(el.getBoundingClientRect()));
      const viewWidth = document.documentElement.clientWidth;
      const viewHeight = window.innerHeight;
      const bubble = bubbleRef.current;
      const size = bubble === null ? "" : `${bubble.offsetWidth}x${bubble.offsetHeight}`;
      const key = `${boxes.map((b) => `${Math.round(b.x)},${Math.round(b.y)},${Math.round(b.w)},${Math.round(b.h)}`).join(";")}|${viewWidth}x${viewHeight}|${size}`;
      if (key === last) return;
      last = key;
      const holes = boxes.map(holePath).join("");
      shadeRef.current?.setAttribute("d", `M0 0H${viewWidth}V${viewHeight}H0Z${holes}`);
      ringRef.current?.setAttribute("d", holes);
      catchRef.current?.setAttribute("d", stop.interactive === true ? "" : holes);
      if (bubble === null) return;
      if (sheet) {
        // The sheet's place and width are the stylesheet's.
        bubble.style.left = "";
        bubble.style.top = "";
        bubble.style.width = "";
        return;
      }
      const first = boxes[0];
      // Narrowed to the column beside the place where its own width doesn't fit there.
      const natural = BUBBLE_REM * Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
      const width = first === undefined || stop.below === true ? null : besideWidth(first, viewWidth, natural);
      bubble.style.width = width === null ? "" : `${width}px`;
      const place = first === undefined ? null : placeBubble(first, { w: bubble.offsetWidth, h: bubble.offsetHeight }, { w: viewWidth, h: viewHeight }, stop.below);
      bubble.style.left = `${place?.left ?? Math.round((viewWidth - bubble.offsetWidth) / 2)}px`;
      bubble.style.top = `${place?.top ?? Math.round((viewHeight - bubble.offsetHeight) / 2)}px`;
      bubble.dataset["placed"] = "true";
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [stop, sheet]);

  const counter = `[ Tour · ${index + 1} of ${count} ]`;
  const skip = (
    <button type="button" className="spdex-linkbutton spdex-tour__skip" data-testid="tour-skip" onClick={onEnd}>
      Skip tour
    </button>
  );

  return (
    <div
      className="spdex-tour"
      data-testid="tour"
      data-stop={stop.id}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        onEnd();
      }}
    >
      {/* A press on the dimmed page, or on a place that only points, does
          nothing: not even move focus off the bubble. */}
      <svg className="spdex-tour__dim" aria-hidden="true" data-testid="tour-dim" onMouseDown={(event) => event.preventDefault()}>
        <path className="spdex-tour__shade" fillRule="evenodd" ref={shadeRef} />
        <path className="spdex-tour__catch" ref={catchRef} />
        <path className="spdex-tour__ring" ref={ringRef} />
      </svg>

      {sheet ? (
        <div className="spdex-tour__bar" ref={barRef} data-testid="tour-bar">
          <p className="spdex-tour__chip">{counter}</p>
          <span className="spdex-tour__links">
            <button
              type="button"
              className="spdex-linkbutton"
              data-testid="tour-text"
              aria-expanded={textShown}
              aria-controls={bodyId}
              onClick={() => setTextShown((shown) => !shown)}
            >
              {textShown ? "Hide text" : "Show text"}
            </button>
            {skip}
          </span>
        </div>
      ) : null}

      <div
        className={`spdex-tour__bubble${sheet ? " spdex-tour__bubble--sheet" : ""}`}
        role="dialog"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        tabIndex={-1}
        ref={bubbleRef}
        data-testid="tour-bubble"
        onKeyDown={(event) => {
          if (event.key !== "Enter" || event.repeat || event.target !== event.currentTarget) return;
          event.preventDefault();
          next();
        }}
      >
        {sheet ? null : <p className="spdex-tour__chip">{counter}</p>}
        <div className="spdex-tour__head">
          <h2 className="spdex-tour__title" id={titleId} data-testid="tour-title">
            {stop.title}
          </h2>
          {sheet ? (
            <span className="spdex-tour__arrows">
              <button type="button" className="spdex-tour__arrow" data-testid="tour-back" aria-label="Back" onClick={onBack}>
                <span aria-hidden="true">←</span>
              </button>
              <button
                type="button"
                className="spdex-tour__arrow spdex-tour__arrow--next"
                data-testid="tour-next"
                aria-label={last ? "Finish" : "Next"}
                aria-disabled={canNext ? undefined : true}
                onClick={next}
              >
                <span aria-hidden="true">{last ? "✓" : "→"}</span>
              </button>
            </span>
          ) : null}
        </div>
        <p className="spdex-tour__body" id={bodyId} hidden={!textShown} data-testid="tour-body">
          {stop.body}
        </p>
        {waiting && stop.wait !== undefined ? (
          <p className="spdex-tour__wait" data-testid="tour-wait">
            {stop.wait}
          </p>
        ) : null}
        {sheet ? null : (
          <div className="spdex-tour__actions">
            <button type="button" className="spdex-button spdex-button--ghost" data-testid="tour-back" onClick={onBack}>
              Back
            </button>
            <button
              type="button"
              className="spdex-button"
              data-testid="tour-next"
              aria-disabled={canNext ? undefined : true}
              onClick={next}
            >
              {last ? "Finish" : "Next"} <span aria-hidden="true">↵</span>
            </button>
            {skip}
          </div>
        )}
      </div>
    </div>
  );
}
