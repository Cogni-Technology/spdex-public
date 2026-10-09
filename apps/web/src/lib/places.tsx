/**
 * Every place the copy points people to, by name, and the button that goes
 * there.
 *
 * Prose names a place with its `label` ("Settings → Network service"), and a
 * line that tells someone to go somewhere ends with a `GoTo`, which brings the
 * place into view wherever it lives (`reveal`): it opens the tile, unfolds the
 * section and, for a place only the Expert view has, switches to it first. No
 * string says "Expert → …" any more; apps/web/src/copy.test.ts holds that.
 *
 * `testId` is the place's root `data-testid`; lib/places.test.ts checks each
 * is rendered by the source.
 */

import { useState, type ReactNode, type RefObject } from "react";
import { useTiles } from "./tiles.js";

export interface Place {
  label: string;
  testId: string;
  /** "expert" when only the Expert view renders it; `reveal` switches the view first. */
  view: "any" | "expert";
}

export const PLACES = {
  networkService: { label: "Settings → Network service", testId: "settings-network", view: "any" },
  tips: { label: "Settings → Tips", testId: "settings-tips", view: "any" },
  trust: { label: "Settings → Check this build", testId: "settings-trust", view: "any" },
  features: { label: "Settings → Features", testId: "open-features", view: "any" },
  sending: { label: "Settings → Sending", testId: "expert-submitter", view: "expert" },
  safety: { label: "Settings → Safety", testId: "expert-safety", view: "expert" },
  settingsFile: { label: "Settings → Settings file", testId: "config-panel", view: "expert" },
  markets: { label: "Settings → Markets used", testId: "expert-pools", view: "expert" },
  activityCsv: { label: "Your SPX → Download CSV", testId: "activity-csv", view: "any" },
} as const satisfies Record<string, Place>;

export type PlaceKey = keyof typeof PLACES;

/** Whether `testId` is a place only the Expert view renders: `reveal` switches views for it. */
export function isExpertOnly(testId: string): boolean {
  return Object.values(PLACES).some((place: Place) => place.testId === testId && place.view === "expert");
}

/**
 * A link-styled button that goes to a place (`data-testid="goto-${place}"`).
 * Its words are `children`, or the place's label.
 *
 * `returnTo` shows "← Back to …" in the tile it opens, to come back to that
 * element once the thing over there is done: an element, a ref to one, or
 * "here" for this button itself. Without it, it just goes.
 *
 * If the place isn't on the page yet (a section this build doesn't render,
 * or Settings before a network service is chosen), the button stays where it
 * is, with focus, and says the place's label instead, so the words still say
 * where. It tries again on the next press, and goes back to its own words
 * once the place is there: nothing about a missing place is remembered.
 */
export function GoTo({
  place,
  children,
  returnTo,
  backLabel,
}: {
  place: PlaceKey;
  children?: ReactNode;
  returnTo?: HTMLElement | RefObject<HTMLElement | null> | "here" | null;
  backLabel?: string;
}) {
  const tiles = useTiles();
  const [missing, setMissing] = useState(false);
  const { label, testId } = PLACES[place];
  return (
    <button
      type="button"
      className="spdex-goto"
      data-testid={`goto-${place}`}
      data-missing={missing ? "true" : undefined}
      onClick={(event) => {
        const here = event.currentTarget;
        const back =
          returnTo === "here" ? here : returnTo instanceof HTMLElement ? returnTo : (returnTo?.current ?? undefined);
        void tiles
          .reveal(testId, { ...(back ? { returnTo: back } : {}), ...(backLabel ? { backLabel } : {}) })
          .then((found) => setMissing(!found));
      }}
    >
      {missing ? label : (children ?? label)}
    </button>
  );
}
