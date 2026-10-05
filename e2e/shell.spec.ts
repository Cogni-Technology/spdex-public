/**
 * The page's shell: the tiles, the display dock, the status widget and the
 * disclaimer gate (docs/ARCHITECTURE.md, "The page"). What each promises a
 * keyboard user, a screen reader and the network service, checked on the real
 * page.
 */

import type { Page } from "@playwright/test";
import { recommendedConfig, shareFragment } from "../packages/config/src/index.js";
import {
  test,
  expect,
  FORK_CHAIN_ID,
  FORK_URL,
  installWallet,
  seedConfig,
  openSection,
  openTile,
  seedDisclaimer,
  watchRpc,
} from "./fixtures.js";
import { DISCLAIMER_KEY, DISCLAIMER_VERSION, OFFICIAL_RELEASE } from "../apps/web/src/lib/disclaimer.js";

/** Controls that ask the wallet or change money or settings (UI rule R2, docs/ARCHITECTURE.md); lib/tiles.ts MONEY_CONTROLS. */
const MONEY = [
  "swap-button",
  "dca-form-start",
  "dca-confirm-buy",
  "fallback-accept",
  "accept-staged",
  "dca-remove-plans-confirm",
  "reset-config",
  "change-rpc",
  "dca-enable",
  "rpc-use-bundled",
  "rpc-use-fallback",
  "builtin-use-fallback",
  "builtin-choose",
  "connect-button",
  "connect-to-swap",
  "status-connect",
  "yours-connect",
  "welcome-connect",
  "dca-form-connect",
  "dca-panel-connect",
  "add-network",
];
/** Money controls named by a prefix: a Permit2 revoke, and Tip this address (UI rule R2). */
const MONEY_PREFIX = /^(permit2-revoke-|tip-add-|expert-tip-add-)/;

async function focusedTestId(page: Page): Promise<string | null> {
  return page.evaluate(() => document.activeElement?.getAttribute("data-testid") ?? null);
}

/** Whether focus is on a control that asks the wallet or changes money or settings (UI rule R2), by lib/tiles.ts's own list. */
async function focusOnMoney(page: Page): Promise<boolean> {
  return page.evaluate(({ ids, prefix }) => {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement)) return false;
    if (active.matches("[data-money-control]")) return true;
    const id = active.getAttribute("data-testid") ?? "";
    return ids.includes(id) || new RegExp(prefix).test(id);
  }, { ids: MONEY, prefix: MONEY_PREFIX.source });
}

/** The SPX motto, quoted and attributed to the community: the one place the page may say it (UI rule R7). */
const MOTTO = /STOP TRADING AND BELIEVE IN SOMETHING/gi;
const TRADE_WORD = /\btrad(e|es|ed|ing)\b/i;

/**
 * Every word the page holds, open or not: each text node (closed tiles and
 * folds included, since they are still in the document), and the labels,
 * titles, placeholders and alt text assistive technology reads, and the tab
 * title. Joined with spaces so two nodes never run into one word.
 */
async function everyWord(page: Page): Promise<string> {
  return page.evaluate(() => {
    const parts: string[] = [document.title];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      const parent = node.parentElement;
      if (parent === null || parent.closest("script, style, noscript") !== null) continue;
      parts.push(node.textContent ?? "");
    }
    for (const el of document.querySelectorAll("[aria-label], [title], [placeholder], [alt], [aria-description]")) {
      for (const name of ["aria-label", "title", "placeholder", "alt", "aria-description"]) {
        const value = el.getAttribute(name);
        if (value !== null) parts.push(value);
      }
    }
    return parts.join(" ");
  });
}

/**
 * "Official", "unofficial" or "commandment" anywhere on the page, with a
 * little context each: spDEX says none of them, but for the disclaimer's
 * one "On an official release" (`OFFICIAL_RELEASE`, UI rule R8), taken out
 * once here, so a second would still be found.
 */
async function standingWords(page: Page): Promise<string[]> {
  const text = (await everyWord(page)).replace(OFFICIAL_RELEASE, "");
  const found: string[] = [];
  for (const match of text.matchAll(/official|commandment/gi)) found.push(text.slice(Math.max(0, match.index - 30), match.index + 30));
  return found;
}

/** The words on the page that call spDEX a trading tool, with a little context each. */
async function tradeWords(page: Page): Promise<string[]> {
  const text = (await everyWord(page)).replace(MOTTO, "");
  const found: string[] = [];
  const all = new RegExp(TRADE_WORD.source, "gi");
  for (let match = all.exec(text); match !== null; match = all.exec(text)) {
    found.push(text.slice(Math.max(0, match.index - 40), match.index + 40).replace(/\s+/g, " "));
  }
  return found;
}

/**
 * Words that would sell community keeping, or anything else here, as an
 * investment: a rate of return (APR, APY), a yield, a "reward", a projection
 * or an "earn up to" (decision 23 of docs/V2_UPGRADE.md). Keeping is paid
 * work, a buy fee earned for each buy made, and said as such; past fees are
 * stated only after the fact. Capitals only for the two abbreviations, so a
 * date's "Apr" is no match.
 */
const INCOME_WORDS = /\bAP[RY]\b|\byield(?:s|ed|ing)?\b|\brewards?\b|\bprojected\b|\bearn up to\b/g;

async function incomeWords(page: Page): Promise<string[]> {
  const text = await everyWord(page);
  const found: string[] = [];
  for (const match of text.matchAll(new RegExp(INCOME_WORDS.source, "gi"))) {
    // The abbreviations only in capitals: "apr" inside a date is a month.
    if (/^ap[ry]$/i.test(match[0]) && match[0] !== match[0].toUpperCase()) continue;
    found.push(text.slice(Math.max(0, match.index - 40), match.index + 40).replace(/\s+/g, " "));
  }
  return found;
}

test.describe("the tiles", () => {
  test("Buy SPX is open on load once Welcome is hidden; one opens at a time; arrows, Home, End and Esc move and close", async ({
    page,
    account,
  }) => {
    await installWallet(page, { address: account });
    await seedConfig(page);
    await page.goto("/");
    const trade = page.getByTestId("tile-trade");
    // Never a page of closed headers: with Welcome hidden, Buy SPX is open.
    await expect(trade).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator('[data-tile][data-open="true"]')).toHaveCount(1);
    // A closed body is hidden until found, and takes no room.
    await expect(page.locator("#tile-markets")).toHaveAttribute("hidden", "until-found");
    expect(await page.locator("#tile-markets").evaluate((el) => el.getBoundingClientRect().height)).toBe(0);

    await trade.focus();
    await page.keyboard.press("ArrowDown");
    await expect(page.getByTestId("tile-yours")).toBeFocused();
    await page.keyboard.press("End");
    await expect(page.getByTestId("tile-settings")).toBeFocused();
    // Home: the first tile, Trade here (no Welcome, no shared receipt).
    await page.keyboard.press("Home");
    await expect(trade).toBeFocused();

    // Enter closes the open tile, and opens it again.
    await page.keyboard.press("Enter");
    await expect(trade).toHaveAttribute("aria-expanded", "false");
    await page.keyboard.press("Enter");
    await expect(trade).toHaveAttribute("aria-expanded", "true");
    await page.getByTestId("tile-markets").click();
    await expect(trade).toHaveAttribute("aria-expanded", "false");
    await expect(page.getByTestId("tile-markets")).toHaveAttribute("aria-expanded", "true");

    // Esc: the open section first, then the tile, and focus on its header.
    await openTile(page, "settings");
    await openSection(page, "settings-network");
    await page.getByTestId("settings-network-summary").focus();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("settings-network")).not.toHaveAttribute("open", "");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("tile-settings")).toHaveAttribute("aria-expanded", "false");
    await expect(page.getByTestId("tile-settings")).toBeFocused();
    expect(MONEY).not.toContain(await focusedTestId(page));
  });

  test("hiding Welcome puts focus on the tile header now in its place, not on the page", async ({ page, account }) => {
    await installWallet(page, { address: account });
    await seedConfig(page, {}, { showWelcome: true });
    await page.goto("/");
    await openTile(page, "start");
    await page.getByTestId("welcome-hide").click();
    await expect(page.getByTestId("tile-start")).toHaveCount(0);
    // Welcome was first; Buy SPX is first now.
    await expect(page.getByTestId("tile-trade")).toBeFocused();
    expect(await focusOnMoney(page)).toBe(false);
  });

  test("the footer's Check this build opens Settings at the section, and focuses its summary", async ({ page, account }) => {
    await installWallet(page, { address: account });
    await seedConfig(page);
    await page.goto("/");
    await page.getByTestId("goto-trust").click();
    await expect(page.getByTestId("tile-settings")).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByTestId("settings-trust")).toHaveAttribute("open", "");
    await expect(page.getByTestId("settings-trust-summary")).toBeFocused();
  });

  test("the chrome never covers the tiles", async ({ page, account }) => {
    await installWallet(page, { address: account });
    await seedConfig(page);
    await page.goto("/");
    await openTile(page, "trade");
    // null is the default, A+.
    for (const text of ["100", null, "130"]) {
      await page.evaluate((t) => (t === null ? document.documentElement.removeAttribute("data-text") : document.documentElement.setAttribute("data-text", t)), text);
      for (const width of [1280, 1366, 1440, 1536, 1707]) {
        await page.setViewportSize({ width, height: 900 });
        const tiles = await page.getByTestId("tiles").boundingBox();
        for (const id of ["display-dock", "key-hints", "status-widget"]) {
          const box = await page.getByTestId(id).boundingBox();
          if (box === null || tiles === null || box.width === 0) continue;
          const overlaps =
            box.x < tiles.x + tiles.width && tiles.x < box.x + box.width && box.y < tiles.y + tiles.height && tiles.y < box.y + box.height;
          expect(overlaps, `${id} at ${width}, text ${text ?? 115}`).toBe(false);
        }
      }
    }
  });

  test("a place in the Expert view: GoTo switches views, opens the section and focuses it, never a money control", async ({
    page,
    account,
  }) => {
    await installWallet(page, { address: account });
    await seedConfig(page);
    await page.goto("/");
    await openTile(page, "settings");
    await expect(page.getByTestId("mode-toggle-recommended")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("expert-submitter")).toHaveCount(0);
    await openSection(page, "settings-trust");
    await page.getByTestId("walkaway-exits-summary").click();
    await page.getByTestId("walkaway-exits").getByTestId("goto-sending").click();
    await expect(page.getByTestId("mode-toggle-expert")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("status-live")).toHaveText("Switched to Expert view");
    await expect(page.getByTestId("expert-submitter")).toHaveAttribute("open", "");
    await expect(page.getByTestId("expert-submitter-summary")).toBeFocused();
    expect(await focusOnMoney(page)).toBe(false);
  });

  test("a Welcome step shows its place in another tile, and the back chip returns to the step", async ({ page, account }) => {
    await installWallet(page, { address: account });
    await seedConfig(page, {}, { showWelcome: true });
    await page.goto("/");
    await openTile(page, "start");
    const step = page.getByTestId("welcome-to-amount");
    await step.click();
    await expect(page.getByTestId("tile-trade")).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByTestId("tile-start")).toHaveAttribute("aria-expanded", "false");
    const back = page.getByTestId("goto-back");
    await expect(back).toHaveText(/^← Back to steps \(\d of 4\)$/);
    expect(await focusOnMoney(page)).toBe(false);
    await back.click();
    await expect(page.getByTestId("tile-start")).toHaveAttribute("aria-expanded", "true");
    await expect(step).toBeFocused();
    await expect(back).toHaveCount(0);
  });

  test("no word on the page calls spDEX a trading tool, or anything official or a commandment, or sells it as a yield, in either view, with the disclaimer, Features and a wallet", async ({
    page,
    account,
  }) => {
    await installWallet(page, { address: account });
    await seedConfig(page, {}, { showWelcome: true });
    await page.goto("/");
    await page.getByTestId("footer-disclaimer").click();
    await expect(page.getByTestId("disclaimer")).toBeVisible();
    expect(await tradeWords(page)).toEqual([]);
    expect(await standingWords(page)).toEqual([]);
    expect(await incomeWords(page)).toEqual([]);
    // It takes input once it has been up for a moment.
    await page.waitForTimeout(450);
    await page.getByTestId("disclaimer-continue").click();
    await expect(page.getByTestId("disclaimer")).toHaveCount(0);

    await openTile(page, "trade");
    await page.getByTestId("connect-button").click();
    await expect(page.getByTestId("account-label")).not.toContainText("not connected");
    // The Recurring form, with the vault chosen, is the page's longest text.
    await page.getByTestId("buy-mode-recurring").click();
    await page.getByTestId("dca-form-signer-vault").click();
    // Every tile opened once, so each has read what it shows.
    for (const id of ["start", "yours", "markets", "community", "settings"]) await openTile(page, id);
    // And Community keeping, at the foot of Help run, which draws nothing until opened.
    await openTile(page, "community");
    await page.getByTestId("keeper-panel-summary").click();
    await expect(page.getByTestId("keeper-standing")).toBeVisible({ timeout: 60_000 });
    expect(await tradeWords(page)).toEqual([]);
    expect(await standingWords(page)).toEqual([]);
    expect(await incomeWords(page)).toEqual([]);

    await openTile(page, "settings");
    await page.getByTestId("mode-toggle-expert").click();
    for (const id of ["trade", "markets", "settings"]) await openTile(page, id);
    expect(await tradeWords(page)).toEqual([]);
    expect(await standingWords(page)).toEqual([]);
    expect(await incomeWords(page)).toEqual([]);

    await page.getByTestId("open-features").click();
    await expect(page.getByTestId("features-modal")).toBeVisible();
    expect(await tradeWords(page)).toEqual([]);
    expect(await standingWords(page)).toEqual([]);
    expect(await incomeWords(page)).toEqual([]);
  });

  test("on a phone, every button, link, summary and select is a 44px target", async ({ browser, account }) => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    await seedDisclaimer(context);
    const page = await context.newPage();
    await installWallet(page, { address: account });
    await seedConfig(page, {}, { showWelcome: true });
    await page.goto("/");
    for (const id of [null, "start", "trade", "recurring", "yours", "markets", "community", "settings"]) {
      // "recurring": the Buy SPX tile on its Recurring tab, with its count chip.
      if (id === "recurring") {
        await openTile(page, "trade");
        await page.getByTestId("buy-mode-recurring").click();
      } else if (id !== null) await openTile(page, id);
      const small = await page.evaluate(() => {
        const out: string[] = [];
        for (const el of document.querySelectorAll<HTMLElement>("button, a[href], summary, select")) {
          const box = el.getBoundingClientRect();
          // Not on screen: in a closed tile or fold, or a skip link until it is focused.
          if (box.width <= 1 || box.height <= 1 || el.closest("[inert]") !== null) continue;
          // A link inside a sentence is excepted (WCAG 2.5.8's inline exception).
          if (el.tagName === "A" && getComputedStyle(el).display === "inline") continue;
          if (box.width >= 43.5 && box.height >= 43.5) continue;
          out.push(`${el.getAttribute("data-testid") ?? el.className} ${Math.round(box.width)}×${Math.round(box.height)}`);
        }
        return out;
      });
      expect(small, `tile ${id ?? "open on load"} open`).toEqual([]);
    }
    await context.close();
  });
});

test.describe("the footer", () => {
  test("is the page's contentinfo, and on the first-run screen offers nothing that needs tiles or Settings", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("first-run")).toBeVisible();
    const footer = page.getByRole("contentinfo");
    await expect(footer).toHaveCount(1);
    await expect(footer).toContainText("Community project.");
    await expect(page.getByTestId("goto-trust")).toHaveCount(0);
    await expect(page.getByTestId("key-hints")).toHaveCount(0);
    await expect(page.getByTestId("footer-disclaimer")).toBeVisible();
  });
});

/** A backdrop picture's path, as served in development or from the build's assets. */
const PICTURE = /\/backdrop[^/]*\.(avif|webp)$/;

/**
 * Where the backdrop puts the lead banner's SPX print and the crystal's SPX
 * coin (as ellipses, from the layer's computed size and position), and how
 * each overlaps what covers the picture: the centre column with its tiles'
 * 4px shadow, the widget, the masthead, the pinned dock and key hints, and
 * every sticker showing, turned as it is drawn. Run in the page.
 */
function backdropOverlaps(): string[] {
  const W = document.documentElement.clientWidth;
  const H = document.documentElement.clientHeight;
  const cs = getComputedStyle(document.querySelector(".spdex-bgart")!);
  // The picture is the second layer; the halftone is the first. Its width,
  // with the height left automatic: "1495.87px", or "1495.87px auto" as newer
  // Chromium writes the same size.
  const size = cs.backgroundSize.split(",")[1]!.trim().replace(/ auto$/, "");
  const position = cs.backgroundPosition.split(",")[1]!.trim().split(/\s+/);
  if (!/^[\d.]+px$/.test(size) || position.length !== 2 || !position.every((v) => /^-?[\d.e-]+px$/.test(v))) {
    return [`not in px: ${size} / ${position.join(" ")}`];
  }
  const s = parseFloat(size) / 2560;
  const [x, y] = position.map(parseFloat) as [number, number];
  const ellipse = ([x0, y0, x1, y1]: number[]) => ({
    cx: x + ((x0! + x1!) / 2) * s,
    cy: y + ((y0! + y1!) / 2) * s,
    rx: ((x1! - x0!) / 2) * s,
    ry: ((y1! - y0!) / 2) * s,
  });
  const things = { print: ellipse([134, 579, 233, 683]), coin: ellipse([1933, 468, 2080, 632]) };
  type Box = { name: string; cx: number; cy: number; hw: number; hh: number; angle: number };
  const covers: Box[] = [];
  const box = (name: string, r: DOMRect, grow = 0) =>
    covers.push({ name, cx: (r.left + r.right + grow) / 2, cy: (r.top + r.bottom + grow) / 2, hw: (r.width + grow) / 2, hh: (r.height + grow) / 2, angle: 0 });
  box("centre column", document.querySelector(".spdex-shell__centre")!.getBoundingClientRect(), 4);
  box("widget", document.querySelector(".spdex-widget")!.getBoundingClientRect(), 4);
  box("masthead", document.querySelector(".spdex-shell__head")!.getBoundingClientRect());
  for (const el of document.querySelectorAll<HTMLElement>('[data-testid="display-dock"], .spdex-keyhints')) {
    if (getComputedStyle(el).position === "fixed" && el.getBoundingClientRect().width > 0) box(el.className, el.getBoundingClientRect(), 4);
  }
  for (const el of document.querySelectorAll<SVGSVGElement>(".spdex-sticker")) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || getComputedStyle(el).display === "none") continue;
    const m = new DOMMatrix(getComputedStyle(el).transform);
    covers.push({ name: el.dataset["art"] ?? "sticker", cx: (r.left + r.right) / 2, cy: (r.top + r.bottom) / 2, hw: el.clientWidth / 2, hh: el.clientHeight / 2, angle: Math.atan2(m.b, m.a) });
  }
  const problems: string[] = [];
  for (const [what, e] of Object.entries(things)) {
    for (let k = 0; k < 48; k++) {
      const t = (k / 48) * 2 * Math.PI;
      const px = e.cx + e.rx * Math.cos(t);
      const py = e.cy + e.ry * Math.sin(t);
      if (px < 2 || py < 2 || px > W - 2 || py > H - 2) problems.push(`${what} off the window`);
      for (const c of covers) {
        const dx = px - c.cx;
        const dy = py - c.cy;
        const u = Math.abs(dx * Math.cos(c.angle) + dy * Math.sin(c.angle)) - c.hw;
        const v = Math.abs(-dx * Math.sin(c.angle) + dy * Math.cos(c.angle)) - c.hh;
        if (Math.hypot(Math.max(u, 0), Math.max(v, 0)) < 2) problems.push(`${what} under the ${c.name}`);
      }
    }
  }
  return [...new Set(problems)];
}

test.describe("the backdrop", () => {
  test("fills the window behind the page from 85em with the app's own picture, as decoration only", async ({ page, account }) => {
    await installWallet(page, { address: account });
    await seedConfig(page);
    await page.setViewportSize({ width: 1707, height: 1067 });
    // The picture is a file of the app's, from this origin, and it arrives.
    const arrived = page.waitForResponse((response) => PICTURE.test(new URL(response.url()).pathname));
    await page.goto("/");
    const response = await arrived;
    expect(response.ok()).toBe(true);
    expect(new URL(response.url()).origin).toBe(new URL(page.url()).origin);
    expect(response.headers()["content-type"]).toMatch(/^image\/(avif|webp)\b/);
    const wrap = page.locator(".spdex-bgart");
    await expect(wrap).toHaveClass(/(^|\s)spdex-art(\s|$)/);
    await expect(wrap).toHaveAttribute("aria-hidden", "true");
    // One empty element: the stylesheet draws the picture.
    expect(await wrap.evaluate((el) => el.childElementCount)).toBe(0);
    const cs = await wrap.evaluate((el) => {
      const s = getComputedStyle(el);
      return [s.display, s.position, s.zIndex, s.pointerEvents];
    });
    expect(cs).toEqual(["block", "fixed", "-1", "none"]);
    const image = await wrap.evaluate((el) => getComputedStyle(el).backgroundImage);
    const urls = [...image.matchAll(/url\("([^"]+)"\)/g)].map((m) => m[1]!);
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) {
      expect(new URL(url).origin).toBe(new URL(page.url()).origin);
      expect(new URL(url).pathname).toMatch(PICTURE);
    }
    // The sticky masthead and the widget's gap lay the same picture, fixed to
    // the window: no paper box over it.
    const pieces = await page.evaluate(() =>
      [getComputedStyle(document.querySelector(".spdex-shell__head")!), getComputedStyle(document.querySelector(".spdex-widget")!, "::before")].map((s) => [
        s.backgroundImage,
        s.backgroundAttachment,
      ]),
    );
    for (const [pieceImage, attachment] of pieces) {
      expect(pieceImage).toBe(image);
      expect(attachment).toBe("fixed, fixed");
    }
    // The first child of .spdex-app: never inside the centre column, whose
    // stacking context would put it over the stickers.
    expect(await wrap.evaluate((el) => el.parentElement?.classList.contains("spdex-app") === true && el.parentElement.firstElementChild === el)).toBe(true);
    // Nothing on the page is the backdrop under the pointer.
    const hit = await page.evaluate(() => document.elementFromPoint(window.innerWidth - 60, window.innerHeight / 2)?.closest(".spdex-bgart") ?? null);
    expect(hit).toBeNull();
    // The line map under the footer goes where the picture shows.
    await expect(page.locator(".spdex-linkmap")).toBeHidden();
    // Gone under more contrast, with the rest of the decoration, the
    // masthead's copy of the picture included.
    await page.evaluate(() => document.documentElement.setAttribute("data-contrast", "more"));
    await expect(wrap).toBeHidden();
    expect(await page.locator(".spdex-shell__head").evaluate((el) => getComputedStyle(el).backgroundImage)).not.toContain("url(");
    await page.evaluate(() => document.documentElement.removeAttribute("data-contrast"));
    await expect(wrap).toBeVisible();
    // In one column there are no rails to show it in: plain paper, and the line map back.
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(wrap).toBeHidden();
    await expect(page.locator(".spdex-linkmap")).toBeVisible();
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--bgart-image"))).toBe("");
    // And on a phone.
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(wrap).toBeHidden();
  });

  test("keeps the banner's print and the crystal's coin clear of the stickers, the widget and the centre column", async ({ page, account }) => {
    await installWallet(page, { address: account });
    await seedConfig(page, {}, { showWelcome: true });
    await page.setViewportSize({ width: 1707, height: 1067 });
    await page.goto("/");
    await expect(page.locator(".spdex-bgart")).toBeVisible();
    // A sample of the sizes apps/web/src/backdrop.css was checked at: laptops
    // and desktops, full screen and in a browser window, 16:10 to 21:9. (Not
    // 3:2 and squarer, where the print gives way, nor under about 700px tall,
    // where the pinned dock can cover it: backdrop.css says so.)
    const sizes: [number, number][] = [
      [1366, 768], [1440, 790], [1440, 900], [1470, 956], [1512, 982], [1536, 864], [1600, 900], [1680, 1050], [1707, 950], [1707, 1067],
      [1728, 1117], [1920, 970], [1920, 1080], [1920, 1200], [2048, 1152], [2560, 1080], [2560, 1440], [2560, 1600], [3440, 1440],
    ];
    // At every text size: the rules are in the layout's own units.
    for (const text of [null, "100", "130"]) {
      await page.evaluate((t) => (t === null ? document.documentElement.removeAttribute("data-text") : document.documentElement.setAttribute("data-text", t)), text);
      for (const [width, height] of sizes) {
        await page.setViewportSize({ width, height });
        expect(await page.evaluate(backdropOverlaps), `${width}×${height}, text ${text ?? "115"}`).toEqual([]);
      }
    }
  });

  test("is never loaded on a phone, held either way", async ({ browser, page, account }) => {
    const asked: string[] = [];
    page.on("request", (request) => {
      if (PICTURE.test(new URL(request.url()).pathname)) asked.push(request.url());
    });
    await installWallet(page, { address: account });
    await seedConfig(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    await expect(page.getByTestId("masthead")).toBeVisible();
    await expect(page.locator(".spdex-bgart")).toBeHidden();
    // Nothing on the page names the picture below 85em, so nothing can load it.
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--bgart-image"))).toBe("");
    expect(await page.locator(".spdex-bgart").evaluate((el) => getComputedStyle(el).backgroundImage)).not.toContain("url(");
    // Held sideways, a phone is wider than the one-column layout's 48em, and still no picture.
    const context = await browser.newContext({ viewport: { width: 844, height: 390 }, deviceScaleFactor: 3, hasTouch: true, isMobile: true });
    await seedDisclaimer(context);
    const sideways = await context.newPage();
    sideways.on("request", (request) => {
      if (PICTURE.test(new URL(request.url()).pathname)) asked.push(request.url());
    });
    await installWallet(sideways, { address: account });
    await seedConfig(sideways);
    await sideways.goto("/");
    await expect(sideways.getByTestId("masthead")).toBeVisible();
    expect(await sideways.evaluate(() => window.innerWidth)).toBeGreaterThanOrEqual(768);
    expect(await sideways.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--bgart-image"))).toBe("");
    expect(asked).toEqual([]);
    await context.close();
  });
});

test.describe("the display dock", () => {
  test("pinned on a wide screen at every text size: a size changes how big it is, never where, and keeps focus", async ({
    page,
    account,
  }) => {
    await installWallet(page, { address: account });
    await seedConfig(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    // A+ is the default: no attribute.
    await expect(page.locator("html")).not.toHaveAttribute("data-text", /.*/);
    const dock = page.getByTestId("display-dock");
    const boxes = new Map<string, { x: number; bottom: number; width: number }>();
    for (const size of ["100", "130", "115"]) {
      const button = page.getByTestId(`text-size-${size}`);
      await button.focus();
      await page.keyboard.press("Enter");
      await expect(button).toHaveAttribute("aria-pressed", "true");
      await expect(button).toBeFocused();
      // Pinned: always shown, and Aa DISPLAY hidden, at every size.
      await expect(page.getByTestId("display-open")).toBeHidden();
      await expect(dock).toBeVisible();
      const box = (await dock.boundingBox())!;
      boxes.set(size, { x: box.x, bottom: box.y + box.height, width: box.width });
    }
    const [a, aPlus, aPlusPlus] = ["100", "115", "130"].map((size) => boxes.get(size)!);
    // Same corner at every size, and sized in proportion to the text.
    for (const box of [aPlus!, aPlusPlus!]) {
      expect(Math.abs(box.x - a!.x)).toBeLessThanOrEqual(1);
      expect(Math.abs(box.bottom - a!.bottom)).toBeLessThanOrEqual(1);
    }
    expect(aPlus!.width / a!.width).toBeCloseTo(1.15, 2);
    expect(aPlusPlus!.width / a!.width).toBeCloseTo(1.3, 2);
    // Back at the default, nothing is stored or set.
    await expect(page.locator("html")).not.toHaveAttribute("data-text", /.*/);
  });

  test("keeps text size, motion and contrast across a reload, and nothing scrolls sideways at A++", async ({ page, account }) => {
    await installWallet(page, { address: account });
    await seedConfig(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    await page.getByTestId("display-open").click();
    await expect(page.getByTestId("display-open")).toHaveAttribute("aria-expanded", "true");
    await page.getByTestId("text-size-130").click();
    await page.getByTestId("motion-reduce").click();
    await page.getByTestId("contrast-more").click();
    await page.reload();
    const root = page.locator("html");
    await expect(root).toHaveAttribute("data-text", "130");
    await expect(root).toHaveAttribute("data-motion", "reduce");
    await expect(root).toHaveAttribute("data-contrast", "more");
    for (const width of [320, 390]) {
      await page.setViewportSize({ width, height: 800 });
      await openTile(page, "trade");
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
    }
  });
});

test.describe("the status widget", () => {
  test("reads the block once, not on a timer, and again on ↻", async ({ page, account }) => {
    const heads: number[] = [];
    page.on("request", (request) => {
      if (request.method() === "POST" && (request.postData() ?? "").includes('"eth_blockNumber"')) heads.push(Date.now());
    });
    await installWallet(page, { address: account });
    await seedConfig(page);
    const traffic = watchRpc(page);
    await page.goto("/");
    await expect(page.getByTestId("status-state")).toContainText(/online/i, { timeout: 30_000 });
    await expect(page.getByTestId("status-block")).toContainText(/^#[\d,]+ · /);
    await traffic.quiet();
    const settled = heads.length;
    // Idle: nothing reads it again. (Pool statistics read it once for volume, at load.)
    await page.waitForTimeout(60_000);
    expect(heads.length).toBe(settled);
    await page.getByTestId("strip-details-summary").click();
    await page.getByTestId("status-refresh").click();
    await expect.poll(() => heads.length).toBe(settled + 1);
  });

  test("masks the service's address, and SHOW reveals it until the details close", async ({ page, account }) => {
    // A service address with a key in its path, as hosted services hand them
    // out. Answered by the fork, so the page is on the same chain.
    const keyed = "https://eth-mainnet.spdex-test.invalid/v2/k3yK3yK3y0123456789abcdefSECRET";
    await page.route("https://eth-mainnet.spdex-test.invalid/**", async (route) => {
      const response = await route.fetch({ url: FORK_URL });
      await route.fulfill({ response });
    });
    await installWallet(page, { address: account });
    await seedConfig(page, { rpc: { url: keyed, source: "user" }, chainId: FORK_CHAIN_ID });
    await page.goto("/");
    await expect(page.getByTestId("status-state")).toContainText(/online/i, { timeout: 30_000 });
    const label = page.getByTestId("rpc-label");
    await expect(label).toHaveText("https://eth-mainnet.spdex-test.invalid");
    expect(await everyWord(page)).not.toContain("SECRET");

    await page.getByTestId("strip-details-summary").click();
    await page.getByTestId("rpc-show").click();
    await expect(label).toHaveText(keyed);
    // Closing the details hides it again.
    await page.getByTestId("strip-details-summary").click();
    await page.getByTestId("strip-details-summary").click();
    await expect(label).toHaveText("https://eth-mainnet.spdex-test.invalid");

    // Settings → Network service shows it the same way.
    await openTile(page, "settings");
    await openSection(page, "settings-network");
    await expect(page.getByTestId("settings-rpc-label")).toHaveText("https://eth-mainnet.spdex-test.invalid");
    expect(await everyWord(page)).not.toContain("SECRET");
  });
});

/** A point on Apply these settings, behind the gate, that is outside the gate's text box and its Continue button. */
async function exposedApply(page: Page, viewportHeight: number): Promise<{ x: number; y: number } | null> {
  const inside = (p: { x: number; y: number }, b: { x: number; y: number; width: number; height: number } | null) =>
    b !== null && p.x >= b.x && p.x <= b.x + b.width && p.y >= b.y && p.y <= b.y + b.height;
  const apply = await page.getByTestId("accept-staged").boundingBox();
  const text = await page.getByTestId("disclaimer-text").boundingBox();
  const cont = await page.getByTestId("disclaimer-continue").boundingBox();
  if (apply === null) return null;
  for (let fx = 0.1; fx <= 0.9; fx += 0.1) {
    for (let fy = 0.2; fy <= 0.8; fy += 0.3) {
      const p = { x: apply.x + apply.width * fx, y: apply.y + apply.height * fy };
      if (p.y >= 0 && p.y <= viewportHeight && !inside(p, text) && !inside(p, cont)) return p;
    }
  }
  return null;
}

test.describe("the disclaimer", () => {
  test.use({ showDisclaimer: true });

  test("Enter continues; scrolling keys, shortcuts and an early key don't; the footer shows it again", async ({ page, account }) => {
    await installWallet(page, { address: account });
    await seedConfig(page);
    await page.goto("/");
    const gate = page.getByTestId("disclaimer");
    await expect(gate).toBeVisible();
    await page.keyboard.press("x");
    await expect(gate).toBeVisible();
    await expect(page.getByTestId("disclaimer-text")).toBeFocused();
    await page.waitForTimeout(500);
    for (const key of ["ArrowDown", "PageDown", "Space", "Control+c"]) {
      await page.keyboard.press(key);
      await expect(gate, key).toBeVisible();
    }
    await page.keyboard.press("Enter");
    await expect(gate).toHaveCount(0);
    expect(await page.evaluate((key) => localStorage.getItem(key), DISCLAIMER_KEY)).toBe(DISCLAIMER_VERSION);
    // The Enter reached nothing behind it: Buy SPX, open on load, is still open.
    await expect(page.getByTestId("tile-trade")).toHaveAttribute("aria-expanded", "true");

    await page.getByTestId("footer-disclaimer").click();
    await expect(gate).toBeVisible();
    await page.waitForTimeout(450);
    await page.keyboard.press("Escape");
    await expect(gate).toHaveCount(0);
    await expect(page.getByTestId("footer-disclaimer")).toBeFocused();
  });

  test("a tap outside the text continues, and changes no setting", async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
    const page = await context.newPage();
    await page.goto("/");
    await expect(page.getByTestId("disclaimer")).toBeVisible();
    await page.waitForTimeout(450);
    await page.touchscreen.tap(8, 8);
    await expect(page.getByTestId("disclaimer")).toHaveCount(0);
    expect(await page.evaluate(() => localStorage.getItem("spdex.config.v1"))).toBeNull();
    await context.close();
  });

  // The second half of a double tap or double click lands 100 to 500 ms after
  // the first closed the gate; where Apply these settings sits under the
  // pointer, it must press nothing (UI rule R2): the page stays inert that long, and
  // Apply is armed only after a moment on a page that takes input.
  for (const { what, viewport, touch } of [
    { what: "a double tap on a phone", viewport: { width: 360, height: 740 }, touch: true },
    // 1280x720: where the default page (A+, one column) shows Apply beside the gate's text.
    { what: "a double click on a laptop", viewport: { width: 1280, height: 720 }, touch: false },
  ]) {
    test(`opened from a settings link, ${what} that closes it never reaches Apply these settings`, async ({ browser }) => {
      const context = await browser.newContext({ viewport, ...(touch ? { hasTouch: true, isMobile: true } : {}) });
      const page = await context.newPage();
      const seeded = await seedConfig(page);
      const shared = { ...recommendedConfig(), chainId: FORK_CHAIN_ID, rpc: { url: FORK_URL, source: "user" as const }, deadlineSeconds: 900 };
      await page.goto(`/#config=${shareFragment(shared)}`);
      const gate = page.getByTestId("disclaimer");
      await expect(gate).toBeVisible();
      await expect(page.getByTestId("staged-config")).toHaveCount(1);
      await page.waitForTimeout(450);
      const spot = await exposedApply(page, viewport.height);
      expect(spot, "Apply these settings shows beside the gate's text at this size").not.toBeNull();
      if (touch) {
        await page.touchscreen.tap(spot!.x, spot!.y);
        await page.waitForTimeout(150);
        await page.touchscreen.tap(spot!.x, spot!.y);
      } else {
        await page.mouse.click(spot!.x, spot!.y);
        await page.waitForTimeout(120);
        await page.mouse.click(spot!.x, spot!.y);
      }
      await expect(gate).toHaveCount(0);
      await page.waitForTimeout(800);
      await expect(page.getByTestId("staged-config")).toBeVisible();
      const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("spdex.config.v1") ?? "null") as { deadlineSeconds?: number });
      expect(stored?.deadlineSeconds).toBe(seeded.deadlineSeconds);
      await context.close();
    });
  }

  test("taller than a landscape phone, the dialog starts on the page and scrolls to its chip", async ({ page, account }) => {
    await installWallet(page, { address: account });
    await seedConfig(page);
    await page.setViewportSize({ width: 568, height: 320 });
    await page.goto("/");
    const gate = page.getByTestId("disclaimer");
    await expect(gate).toBeVisible();
    // null is the default, A+.
    for (const text of ["100", null, "130"]) {
      await page.evaluate((t) => (t === null ? document.documentElement.removeAttribute("data-text") : document.documentElement.setAttribute("data-text", t)), text);
      await page.getByTestId("disclaimer-backdrop").evaluate((el) => el.scrollTo(0, 0));
      const box = (await gate.boundingBox())!;
      expect(box.height, `taller than the viewport at text ${text ?? 115}`).toBeGreaterThan(320);
      expect(box.y, `text ${text ?? 115}`).toBeGreaterThanOrEqual(0);
    }
  });
});
