/**
 * Said once, on the first load of the build with "My tip list": the people
 * chosen before it existed keep being tipped, and are now in the list. Shown
 * in the Tip row and in Settings → Tips until dismissed or the page reloads.
 */

import { Banner, Button } from "@spdex/ui";
import { useTips } from "./context.js";

export function MigratedBanner() {
  const tips = useTips();
  if (tips.migrated === 0) return null;
  const count = tips.migrated === 1 ? "The address" : `The ${tips.migrated} addresses`;
  return (
    <Banner tone="ok" title="Tip addresses kept" testId="tip-migrated">
      {count} you chose before {tips.migrated === 1 ? "is" : "are"} now in My tip list.{" "}
      <Button variant="ghost" testId="tip-migrated-dismiss" onClick={tips.dismissMigrated}>
        OK
      </Button>
    </Banner>
  );
}
