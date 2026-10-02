/**
 * The tag on a tip recipient, from its address alone (lib/tiplist/checks.ts):
 * LISTED (spDEX ships it), MINE (saved in this browser), UNLISTED (in
 * neither: loaded settings name it, or it was removed from My tip list;
 * warning style) or RETIRED (attention style).
 */

import { Term } from "@spdex/ui";
import type { TipTag } from "../../lib/tiplist/checks.js";

const MEANING: Record<TipTag, string> = {
  LISTED: "On the list spDEX ships, with the person's own public post of this address, or spDEX's own donation vault. Not an endorsement.",
  MINE: "Saved in My tip list, in this browser only.",
  UNLISTED: "Not on the list spDEX ships, and not in My tip list. The first tip to it asks you to check it.",
  RETIRED: "Taken off the list spDEX ships. Not tipped until you choose again.",
};

export function TipTagChip({ tag, testId }: { tag: TipTag; testId?: string }) {
  return (
    <span className={`spdex-tiptag spdex-tiptag--${tag.toLowerCase()}`} data-testid={testId} data-tag={tag}>
      <Term tip={MEANING[tag]}>{tag}</Term>
    </span>
  );
}
