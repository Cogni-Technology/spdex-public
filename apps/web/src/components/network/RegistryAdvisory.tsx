/**
 * Decision 31's notice (lib/dca/advisory.ts): a warning on every v2 vault's
 * card, above the form that creates one, and in Community keeping, shown
 * only by a build that sets `REGISTRY_ADVISORY`. Every build until then draws
 * nothing here.
 */

import { Banner } from "@spdex/ui";
import type { VaultRelease } from "@spdex/vault";
import { REGISTRY_ADVISORY, REGISTRY_ADVISORY_TITLE, registryAdvisoryFor } from "../../lib/dca/advisory.js";

export function RegistryAdvisory({
  release,
  testId,
  advisory = REGISTRY_ADVISORY,
}: {
  /** The release of the vault it is about: the latest one for a vault about to be created. */
  release: VaultRelease | null | undefined;
  testId: string;
  /** The build's notice by default; a test passes its own. */
  advisory?: string | null;
}) {
  const text = registryAdvisoryFor(release, advisory);
  if (text === null) return null;
  return (
    <Banner tone="warn" title={REGISTRY_ADVISORY_TITLE} testId={testId}>
      <p className="spdex-network-line">{text}</p>
    </Banner>
  );
}
