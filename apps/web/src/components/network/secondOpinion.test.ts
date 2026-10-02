/**
 * The second opinion on screen: the setting in Settings → Safety and the
 * "Checked on one service" banner, rendered as the page first draws them. The
 * status widget's safety line is checked in shell/StatusWidget.test.ts.
 * Nothing here reads the chain.
 */

import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { recommendedConfig } from "@spdex/config";
import { rejected, unverified, verified, type GuardViolation, type SpdexConfig } from "@spdex/core";
import { GuardBanner, oneServiceText } from "../Swap.js";
import { SECOND_OPINION_DETAIL, SECOND_OPINION_HINT, SECOND_OPINION_LIMIT, SecondOpinionSetting } from "./SecondOpinionSetting.js";
import { secondOpinionRefusalText } from "../../lib/simulation.js";

const MAIN = "https://eth-mainnet.g.alchemy.com/v2/KEY";

function config(second: string | null): SpdexConfig {
  const base = recommendedConfig();
  return { ...base, rpc: { url: MAIN, source: "user" }, guard: { ...base.guard, secondOpinion: { url: second } } };
}

const text = (html: string) => html.replace(/<[^>]+>/g, "").replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&");

const setting = (second: string | null) =>
  renderToStaticMarkup(
    createElement(SecondOpinionSetting, {
      config: config(second),
      onChange: () => undefined,
      test: async () => ({ ok: true as const, warning: null }),
    }),
  );

describe("SecondOpinionSetting", () => {
  it("offers an empty field, says what it does, what it sees and what it doesn't check", () => {
    const html = setting(null);
    expect(html).toContain('data-testid="second-opinion-url"');
    expect(text(html)).toContain("Second opinion (optional)");
    expect(text(html)).toContain(SECOND_OPINION_HINT);
    expect(text(html)).toContain(SECOND_OPINION_DETAIL);
    expect(text(html)).toContain(SECOND_OPINION_LIMIT);
    expect(text(html)).toContain("The 10-minute price check still reads your main service only.");
    // Nothing to test, save or remove yet.
    expect(html).not.toContain('data-testid="second-opinion-test"');
    expect(html).not.toContain('data-testid="second-opinion-save"');
    expect(html).not.toContain('data-testid="second-opinion-remove"');
  });

  it("shows the one in use, with a way to remove it, and warns when it's probably the main one's operator", () => {
    const html = setting("https://eth.alchemy.com/v2/OTHER");
    expect(text(html)).toContain("In use: https://eth.alchemy.com");
    expect(html).toContain('data-testid="second-opinion-remove"');
    expect(text(html)).toContain("Both are at alchemy.com: probably the same operator, so not much of a second opinion.");
  });

  it("masks the address in use, key and all, with the full one a Show away, and leaves the field empty", () => {
    const html = setting("https://eth-mainnet.example.org/v2/SECRETKEY123");
    expect(text(html)).toContain("In use: https://eth-mainnet.example.org");
    expect(html).not.toContain("SECRETKEY123");
    expect(html).toMatch(/data-testid="second-opinion-show"[^>]*>Show</);
    expect(html).toMatch(/<input[^>]*data-testid="second-opinion-url"[^>]*value=""/);
    // Nothing typed, so nothing to test or save.
    expect(html).not.toContain('data-testid="second-opinion-test"');
    expect(html).not.toContain('data-testid="second-opinion-save"');
    // An address with nothing to hide has nothing to show.
    expect(setting("http://localhost:8545")).not.toContain('data-testid="second-opinion-show"');
  });

  it("says a copy of the main service doesn't count, when a settings link set one", () => {
    const html = setting("https://ETH-MAINNET.g.alchemy.com:443/v2/KEY/");
    expect(html).toContain('data-testid="second-opinion-same"');
    expect(text(html)).toContain("This is your main service, so it doesn't count as a second opinion");
  });

  it("says it in one line, and the rest in its fold", () => {
    expect(SECOND_OPINION_HINT).toBe(
      "Another operator's service test-runs every transaction too; if the two disagree, spDEX won't let you sign.",
    );
    expect(SECOND_OPINION_DETAIL).toContain("It sees what you're about to sign, as your main service does.");
    expect(SECOND_OPINION_DETAIL).toContain('one-time swaps say "Checked on one service"');
    expect(SECOND_OPINION_DETAIL).toContain("vault transactions that send ether wait until it does.");
  });
});

describe("the Checked on one service banner", () => {
  const unavailable = (host: string): GuardViolation => ({
    code: "SECOND_OPINION_UNAVAILABLE",
    message: "your second network service didn't answer (timeout), so this was checked on one service only",
    detail: { host, failure: "timeout" },
  });
  const banner = (verdict: Parameters<typeof GuardBanner>[0]["verdict"]) =>
    renderToStaticMarkup(createElement(GuardBanner, { verdict, previewOnly: false, mode: "recommended" }));

  it("says the swap was tested on the main service only, naming the second by host, with the unverified tag", () => {
    const html = banner(unverified([unavailable("second.example")]));
    expect(text(html)).toContain("Checked on one service");
    expect(html).toContain('data-testid="guard-level">unverified<');
    expect(text(html)).toContain(
      "Tested on your main service only: your second opinion, second.example, didn't answer. Swap, or press " +
        "Refresh price to ask both again.",
    );
    // What the main service's run says is one tap away, under "What was checked".
    expect(html).toContain('data-testid="guard-checked"');
    expect(text(html)).toContain(
      "Your main service's test-run says nothing else leaves your wallet and you get at least the amount shown.",
    );
    expect(html).toContain('data-testid="warning-SECOND_OPINION_UNAVAILABLE"');
    expect(oneServiceText("")).toMatch(/^Tested on your main service only: your second opinion didn't answer\./);
  });

  it("words the second opinion's silence as a refusal where the setting refuses anything unchecked", () => {
    const html = banner(rejected([unavailable("second.example")]));
    expect(text(html)).toContain(secondOpinionRefusalText("strict"));
    expect(text(html)).not.toContain("checked on one service only");
    expect(html).toContain('data-testid="violation-SECOND_OPINION_UNAVAILABLE"');
  });

  it("says the sentence once: the paragraph gives it, and the line under it keeps only the code", () => {
    const html = banner(unverified([unavailable("second.example")]));
    expect(text(html).match(/checked on one service only/g)).toBeNull();
    expect(html).toContain('data-testid="warning-SECOND_OPINION_UNAVAILABLE"');
  });

  it("tells a main service that failed before the comparison apart from one without eth_simulateV1", () => {
    const expertBanner = (verdict: Parameters<typeof GuardBanner>[0]["verdict"]) =>
      text(renderToStaticMarkup(createElement(GuardBanner, { verdict, previewOnly: false, mode: "expert" })));
    const uncompared: GuardViolation = {
      code: "SIMULATION_UNAVAILABLE",
      message: "your main network service failed before …",
      detail: { failure: "its test-run on the agreed block failed" },
    };
    const said = expertBanner(unverified([uncompared]));
    expect(said).toContain("Not checked");
    expect(said).toContain("failed before its test-run could be compared with your second opinion's");
    expect(said).toContain("press Refresh price to ask both again");
    expect(said).not.toContain("eth_simulateV1");
    expect(said).not.toContain("can't run spDEX's safety test");

    const probe: GuardViolation = { code: "SIMULATION_UNAVAILABLE", message: "this RPC cannot simulate", detail: { provider: "eth_simulateV1" } };
    expect(expertBanner(unverified([probe]))).toContain("(The service lacks eth_simulateV1.)");
    const threw: GuardViolation = { code: "SIMULATION_UNAVAILABLE", message: "simulation failed: HTTP 502" };
    expect(expertBanner(unverified([threw]))).not.toContain("(The service lacks eth_simulateV1.)");
  });

  it("keeps the ordinary banners for everything else", () => {
    const cannot: GuardViolation = { code: "SIMULATION_UNAVAILABLE", message: "no eth_simulateV1" };
    expect(text(banner(unverified([cannot, unavailable("x")])))).not.toContain("Checked on one service");
    expect(text(banner(unverified([cannot])))).toContain("Not checked");
    expect(text(banner(verified([])))).toContain("Checked");
    expect(text(banner(verified([])))).not.toContain("Checked on one service");
  });
});
