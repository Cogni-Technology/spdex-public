/**
 * Decision 31's notice: none in this build, and, in a build that sets one,
 * shown for v2's vaults only (lib/dca/advisory.ts). Where it is drawn is the
 * vault card's, the form's and Community keeping's to show
 * (components/network/RegistryAdvisory.tsx, VaultCard.laterWindow.test.ts,
 * network.test.ts).
 */

import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LATEST_RELEASE } from "@spdex/vault";
import { REGISTRY_ADVISORY, REGISTRY_ADVISORY_TITLE, registryAdvisoryFor } from "./advisory.js";
import { RegistryAdvisory } from "../../components/network/RegistryAdvisory.js";

const NOTICE = "A bug in the SPX holder registry lets some addresses that never held SPX be paid inside community windows. No vault's money is at risk.";

describe("decision 31's notice", () => {
  it("is none in this build: a build sets it only once a registry bug is known", () => {
    expect(REGISTRY_ADVISORY).toBeNull();
    expect(registryAdvisoryFor("v2", REGISTRY_ADVISORY)).toBeNull();
    expect(renderToStaticMarkup(createElement(RegistryAdvisory, { release: "v2", testId: "x" }))).toBe("");
  });

  it("is about v2's vaults alone, the release new vaults are created on, and a blank one is none", () => {
    expect(LATEST_RELEASE).toBe("v2");
    expect(registryAdvisoryFor("v2", `  ${NOTICE}\n`)).toBe(NOTICE);
    expect(registryAdvisoryFor("v1", NOTICE)).toBeNull();
    expect(registryAdvisoryFor(null, NOTICE)).toBeNull();
    expect(registryAdvisoryFor(undefined, NOTICE)).toBeNull();
    expect(registryAdvisoryFor("v2", "  ")).toBeNull();
  });

  it("is drawn as a warning, its heading and its words, with the test id it is given", () => {
    const html = renderToStaticMarkup(createElement(RegistryAdvisory, { release: "v2", testId: "dca-vault-advisory", advisory: NOTICE }));
    expect(html).toContain('class="spdex-banner spdex-banner--warn"');
    expect(html).toContain('data-testid="dca-vault-advisory"');
    expect(html).toContain(REGISTRY_ADVISORY_TITLE);
    expect(html).toContain("No vault&#x27;s money is at risk.");
    expect(renderToStaticMarkup(createElement(RegistryAdvisory, { release: "v1", testId: "x", advisory: NOTICE }))).toBe("");
  });
});
