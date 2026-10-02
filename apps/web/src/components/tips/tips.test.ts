/**
 * The tip registry's screens as the page first draws them: the first-tip
 * check, the settings-link listing and "My tip list". What matters here is
 * what a person reads before money follows an address — the tag from the
 * address, the whole address, the lookalike result — and that the one button
 * that moves money is marked as such (UI rule R2, docs/ARCHITECTURE.md).
 * Every address is made up, or a public development account.
 */

import { describe, expect, it } from "vitest";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { recommendedConfig, setFeature, TIP_FEATURE_ID } from "@spdex/config";
import type { SpdexConfig, TipRecipient } from "@spdex/core";
import type { DiscoveredRecipient } from "../../lib/engine.js";
import { checksumAddress } from "../../lib/culture/contract.js";
import { tippableRecipients } from "../../lib/tiplist/checks.js";
import { createTipListStore, EMPTY_TIPLIST, type TipListState } from "../../lib/tiplist/store.js";
import { TOKEN_LIST } from "../../lib/tokens.js";
import { TipRow } from "../TipRow.js";
import { TipsContext, type TipsEnv } from "./context.js";
import { MyTipList } from "./MyTipList.js";
import { StagedTipRecipients } from "./StagedTipRecipients.js";
import { RetiredChoice, TipConfirm } from "./TipConfirm.js";

const fake = (first: string, last: string) => checksumAddress(`0x${first}${"abcdef".repeat(5)}ab${last}`);
const MARIA = fake("a1b2", "c3d4");
const LOOKALIKE = checksumAddress(`0xa1b2${"0".repeat(32)}c3d4`);
const LISTED = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

const DEFAULTS: DiscoveredRecipient[] = [
  { address: LISTED, label: "Placeholder: dev fund", handle: "@spx_placeholder_1", id: "dev-fund", registryId: "tiplist-dev-fixtures", test: true },
];

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, "")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");

function render(
  element: ReactElement,
  list: TipListState,
  chosen: TipRecipient[] = [],
  defaults: DiscoveredRecipient[] | null = DEFAULTS,
): string {
  const env: TipsEnv = {
    list,
    store: createTipListStore(null, null),
    defaults,
    tipsOn: true,
    signed: new Set(),
    rpc: null,
    second: null,
    account: null,
    chainId: 690069,
    tippable: tippableRecipients({ enabled: true, recipients: chosen }, list, defaults, 690069),
    migrated: 0,
    dismissMigrated: () => undefined,
  };
  return renderToStaticMarkup(createElement(TipsContext.Provider, { value: env }, element));
}

/** A config with tips on and these recipients chosen. */
function configWith(recipients: TipRecipient[]): SpdexConfig {
  const on = setFeature(recommendedConfig(), TIP_FEATURE_ID, true);
  return { ...on, chainId: 690069, tips: { enabled: true, recipients } };
}

const recipient = (address: string, label: string, source?: string): TipRecipient => ({
  address: address.toLowerCase() as `0x${string}`,
  label,
  bps: 25,
  ...(source === undefined ? {} : { source }),
});

describe("TipConfirm", () => {
  it("shows the tag, the name and the whole checksummed address before the first tip", () => {
    const list = { ...EMPTY_TIPLIST, mine: [{ address: MARIA, name: "Maria", ens: "maria.eth", added: 1 }] };
    const html = render(
      createElement(TipConfirm, { recipient: recipient(MARIA, "My tip list"), chosen: [], focus: false, onConfirm: () => undefined, onCancel: () => undefined }),
      list,
    );
    expect(text(html)).toContain("First tip to this address");
    expect(html).toContain('data-tag="MINE"');
    expect(text(html)).toContain("Maria · maria.eth");
    expect(text(html)).toContain(MARIA);
    expect(text(html)).toContain("Check it with the person — a wrong address can't be undone.");
    // The one button that moves money is marked, so nothing ever focuses it on its own (UI rule R2).
    expect(html).toMatch(/<button[^>]*data-testid="tip-confirm-accept"[^>]*data-money-control=""/);
    // Focus goes to the container, which is focusable but not in the tab order.
    expect(html).toMatch(/<div[^>]*role="group"[^>]*tabindex="-1"[^>]*data-testid="tip-confirm"/);
  });

  it("names an address only a settings link names as a quote, and shows a lookalike as a danger", () => {
    const list = { ...EMPTY_TIPLIST, mine: [{ address: MARIA, name: "Maria", added: 1 }] };
    const forged = recipient(LOOKALIKE, "Placeholder: dev fund", "tiplist-spx-community");
    const html = render(
      createElement(TipConfirm, { recipient: forged, chosen: [forged], focus: false, onConfirm: () => undefined, onCancel: () => undefined }),
      list,
      [forged],
    );
    expect(html).toContain('data-tag="UNLISTED"');
    expect(text(html)).toContain("named “Placeholder: dev fund” by loaded settings");
    expect(text(html)).toContain("Looks like Maria's address but isn't. Address-poisoning scams do this.");
    expect(html).toContain('role="alert"');
  });

  it("checks the name a link or a file gives, as a typed name is checked", () => {
    // A link names someone else's address with the listed entry's own name,
    // and a file's entry spells a saved name with a Cyrillic letter.
    const stranger = fake("e1e2", "0a0b");
    const linked = recipient(stranger, "Placeholder: dev fund");
    const html = render(
      createElement(TipConfirm, { recipient: linked, chosen: [linked], focus: false, onConfirm: () => undefined, onCancel: () => undefined }),
      EMPTY_TIPLIST,
      [linked],
    );
    expect(html).toMatch(/data-testid="tip-confirm-name-warning-same-name"[^>]*role="alert"|role="alert"[^>]*data-testid="tip-confirm-name-warning-same-name"/);
    expect(text(html)).toContain("Placeholder: dev fund is listed with a different address.");

    const list = {
      ...EMPTY_TIPLIST,
      mine: [
        { address: MARIA, name: "Maria", added: 1 },
        { address: stranger, name: "Mаria", added: 2, imported: true as const },
      ],
    };
    const imported = render(
      createElement(TipConfirm, { recipient: recipient(stranger, "My tip list", "my-tip-list"), chosen: [], focus: false, onConfirm: () => undefined, onCancel: () => undefined }),
      list,
    );
    expect(text(imported)).toContain("imported");
    expect(text(imported)).toContain("Maria is in My tip list with a different address.");
    expect(text(imported)).toContain("The name mixes alphabets");
  });
});

describe("RetiredChoice", () => {
  it("says why, shows both addresses whole, and marks the two answers that move money", () => {
    const retired = recipient(LISTED, "Placeholder: dev fund", "tiplist-dev-fixtures");
    const replacement: DiscoveredRecipient = { address: MARIA, label: "Placeholder: dev fund", id: "dev-fund-2", registryId: "tiplist-dev-fixtures" };
    const html = render(
      createElement(RetiredChoice, {
        recipient: retired,
        replacement,
        reason: "Retired: Key compromised",
        focus: false,
        onKeep: () => undefined,
        onReplace: () => undefined,
        onStop: () => undefined,
      }),
      EMPTY_TIPLIST,
      [],
      [{ ...DEFAULTS[0]!, retired: "Key compromised", replacedBy: "dev-fund-2" }, replacement],
    );
    expect(text(html)).toContain("Placeholder: dev fund was retired from the list");
    expect(text(html)).toContain("Retired: Key compromised. Not tipped until you choose.");
    expect(html).toMatch(/data-testid="tip-retired-old"[^>]*>/);
    expect(text(html)).toContain(LISTED);
    expect(text(html)).toContain(MARIA);
    expect(html).toMatch(/<button[^>]*data-testid="tip-retired-replace"[^>]*data-money-control=""/);
    expect(html).toMatch(/<button[^>]*data-testid="tip-retired-keep"[^>]*data-money-control=""/);
  });
});

describe("TipRow with a retired entry", () => {
  const retiredDefaults = (): DiscoveredRecipient[] => [
    { ...DEFAULTS[0]!, retired: "Key compromised", replacedBy: "dev-fund-2" },
    { address: MARIA, label: "Placeholder: dev fund", id: "dev-fund-2", registryId: "tiplist-dev-fixtures" },
  ];

  function row(list: TipListState): string {
    const chosen = [recipient(LISTED, "Placeholder: dev fund", "tiplist-dev-fixtures")];
    const config = configWith(chosen);
    return render(
      createElement(TipRow, {
        config,
        candidates: retiredDefaults(),
        quote: null,
        tokenOut: TOKEN_LIST[1]!,
        delivery: { kind: "none" },
        disabled: false,
        onChange: () => undefined,
      }),
      list,
      chosen,
      retiredDefaults(),
    );
  }

  it("asks, with the reason and the replacement, and sends nothing meanwhile", () => {
    const html = row(EMPTY_TIPLIST);
    expect(html).toContain('data-testid="tip-retired"');
    expect(text(html)).toContain("Retired: Key compromised");
    expect(html).toContain('data-testid="tip-retired-new"');
    expect(html).toMatch(/data-tag="RETIRED"/);
    expect(text(html)).toContain("not tipped");
  });

  it("asks even when the address was saved and confirmed before it was retired", () => {
    const html = row({ ...EMPTY_TIPLIST, mine: [{ address: checksumAddress(LISTED), name: "Dev fund", added: 1, confirmed: 2 }] });
    expect(html).toContain('data-testid="tip-retired"');
    expect(html).not.toContain('data-testid="tip-confirm"');
  });

  it("asks the first-tip check once the person kept it, and not before", () => {
    const kept = { ...EMPTY_TIPLIST, mine: [{ address: checksumAddress(LISTED), name: "Dev fund", added: 1, keptRetired: "Key compromised" }] };
    const html = row(kept);
    expect(html).toContain('data-testid="tip-confirm"');
    expect(html).not.toContain('data-testid="tip-retired"');
    expect(text(html)).toContain("needs a check");
  });
});

describe("StagedTipRecipients", () => {
  it("says the listed entries weren't checked while the list is unread, and that unlisted addresses ask", () => {
    const forged = recipient(MARIA, "Placeholder: dev fund", "tiplist-dev-fixtures");
    const html = render(createElement(StagedTipRecipients, { staged: [forged], current: [] }), EMPTY_TIPLIST, [], null);
    expect(text(html)).toContain("Listed entries not checked yet.");
    expect(text(html)).not.toContain("no other listed");
    expect(text(html)).toContain("Unlisted addresses ask before their first tip.");
  });

  it("lists only the addresses a link adds, each tagged from the address", () => {
    const kept = recipient(LISTED, "Placeholder: dev fund", "tiplist-dev-fixtures");
    const forged = recipient(MARIA, "Placeholder: dev fund", "tiplist-dev-fixtures");
    const html = render(createElement(StagedTipRecipients, { staged: [kept, forged], current: [kept] }), EMPTY_TIPLIST);
    expect(html).toContain(`data-testid="staged-tip-${MARIA.toLowerCase()}"`);
    expect(html).not.toContain(`data-testid="staged-tip-${LISTED.toLowerCase()}"`);
    expect(html).toContain('data-tag="UNLISTED"');
    expect(text(html)).toContain("New tip addresses (1)");
    expect(text(html)).toContain(MARIA);
  });

  it("draws nothing when a link adds no tip address", () => {
    expect(render(createElement(StagedTipRecipients, { staged: [], current: [] }), EMPTY_TIPLIST)).toBe("");
  });
});

describe("MyTipList", () => {
  it("names every control by whose place it changes, and keeps the end buttons focusable", () => {
    const list = {
      ...EMPTY_TIPLIST,
      mine: [
        { address: MARIA, name: "Maria", added: 1, confirmed: 2 },
        { address: fake("b1b2", "d3d4"), name: "Sam", added: 1 },
      ],
    };
    const html = render(createElement(MyTipList, { config: configWith([]), onChange: () => undefined }), list);
    expect(text(html)).toContain("My tip list (2)");
    expect(html).toContain('aria-label="Move Maria up"');
    expect(html).toContain('aria-label="Remove Sam"');
    // The first entry can't move up: said, not removed, so focus never falls to the page.
    expect(html).toMatch(/aria-label="Move Maria up" aria-disabled="true"|aria-disabled="true"[^>]*aria-label="Move Maria up"/);
    expect(text(html)).toContain("checked");
    expect(text(html)).toContain("needs a check");
    // The listed entries and the file are secondary, one open at a time.
    expect(html.match(/<details[^>]*name="tips"/g)).toHaveLength(2);
    expect(text(html)).toContain("Listed in spDEX (1)");
  });

  it("says when the list can't be saved in this browser", () => {
    expect(text(render(createElement(MyTipList, { config: configWith([]), onChange: () => undefined }), EMPTY_TIPLIST))).toContain(
      "Can't save in this browser",
    );
  });

  it("gives no count for the listed entries until they are read: unread is not zero", () => {
    const html = render(createElement(MyTipList, { config: configWith([]), onChange: () => undefined }), EMPTY_TIPLIST, [], null);
    expect(text(html)).toContain("Listed in spDEX");
    expect(text(html)).not.toMatch(/Listed in spDEX \(/);
    expect(text(html)).toContain("Not read yet");
  });
});
