/**
 * The first-visit tour (apps/web/src/lib/tour.ts): the welcome card after a
 * first visit's disclaimer, then a spotlight on one place at a time.
 *
 * Every other spec starts with the tour seen (the `tourSeen` fixture); these
 * opt in with `showTour: true`, and see the disclaimer as a newcomer does.
 * The claims are that it starts by itself only for a newcomer, that its first
 * stop is the one where a service is chosen and Next waits for that, that
 * every other stop only points (the page behind takes no click and focus is
 * never on a control that moves money), that it ends remembered, and that the
 * footer starts it again.
 */

import type { Page } from "@playwright/test";
import { TOUR_STOPS } from "../apps/web/src/lib/tour.js";
import { test, expect, FORK_URL, seedConfig } from "./fixtures.js";

test.use({ showDisclaimer: true, showTour: true });

/** Past the disclaimer with Enter, once it has been up long enough to take it. */
async function continuePastDisclaimer(page: Page): Promise<void> {
  const gate = page.getByTestId("disclaimer");
  await expect(gate).toBeVisible();
  await expect(async () => {
    await page.keyboard.press("Enter");
    await expect(gate).toHaveCount(0, { timeout: 750 });
  }).toPass({ timeout: 10_000 });
}

/**
 * Chooses the fork as the service, in Welcome's first step. At this size the
 * tour's bubble is a sheet along the bottom and the step is taller than the
 * band it leaves, so the field is scrolled to the band's middle first, as a
 * person would scroll to it.
 */
async function chooseFork(page: Page): Promise<void> {
  // The page takes input a moment after the welcome card closes (UI rule R2).
  await expect(page.locator(".spdex-app")).not.toHaveAttribute("inert");
  const input = page.getByTestId("rpc-url-input");
  await input.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await input.fill(FORK_URL);
  await page.getByTestId("rpc-save").click();
}

/** Next, once the stop has been up long enough to take it. */
async function next(page: Page): Promise<void> {
  const button = page.getByTestId("tour-next");
  await expect(button).not.toHaveAttribute("aria-disabled", "true");
  await button.click();
}

const stopOn = (page: Page) => page.getByTestId("tour");

test.describe("the tour", () => {
  test("follows a first visit's disclaimer, waits at Connect for a service, then walks the page and ends remembered", async ({ page }) => {
    await page.goto("/");
    await continuePastDisclaimer(page);

    const hello = page.getByTestId("tour-hello");
    await expect(hello).toBeVisible();
    // The card itself takes focus, never its button (UI rule R2).
    await expect(hello).toBeFocused();
    await expect(hello).toContainText("A decentralized exchange custom-built for the SPX6900 community");
    await expect(hello.locator("img")).toHaveAttribute("alt", /^Meme: /);
    await page.getByTestId("tour-go").click();

    // Connect: Welcome's first step, the one place that takes clicks, and Next waits.
    await expect(stopOn(page)).toHaveAttribute("data-stop", "connect");
    await expect(page.getByTestId("tour-bubble")).toBeFocused();
    await expect(page.getByTestId("tour-next")).toHaveAttribute("aria-disabled", "true");
    await expect(page.getByTestId("tour-wait")).toHaveText("Pick one to continue");
    await expect(page.getByTestId("tile-start")).toHaveAttribute("aria-expanded", "true");
    await chooseFork(page);

    // Choosing moves on by itself, and the first step says what was chosen.
    await expect(stopOn(page)).toHaveAttribute("data-stop", "payoff", { timeout: 30_000 });
    await expect(page.getByTestId("welcome-service")).toContainText("Using");
    for (const stop of TOUR_STOPS.slice(1)) {
      await expect(stopOn(page)).toHaveAttribute("data-stop", stop.id);
      await expect(page.getByTestId("tour-title")).toHaveText(stop.title);
      await expect(page.getByTestId("tour-body")).toHaveText(stop.body);
      await expect(page.getByTestId(`tile-${stop.tile}`)).toHaveAttribute("aria-expanded", "true");
      await next(page);
    }

    await expect(stopOn(page)).toHaveCount(0);
    await expect(page.getByTestId("tile-start")).toHaveAttribute("aria-expanded", "true");
    expect(await page.evaluate(() => localStorage.getItem("spdex.tour.v1"))).toBe("seen");
    // Not again on the next visit.
    await page.reload();
    await expect(page.getByTestId("welcome-panel")).toBeVisible();
    await expect(page.getByTestId("tour-hello")).toHaveCount(0);
  });

  test("at a stop that only points, the page takes no click and focus is never on a control that moves money", async ({ page }) => {
    await page.goto("/");
    await continuePastDisclaimer(page);
    await page.getByTestId("tour-go").click();
    await chooseFork(page);
    await expect(stopOn(page)).toHaveAttribute("data-stop", "payoff", { timeout: 30_000 });
    await next(page);
    await expect(stopOn(page)).toHaveAttribute("data-stop", "buy");

    // A $69 chip, inside the spotlight: clicked where it shows, it does nothing.
    const chip = page.getByTestId("amount-preset-6900");
    await expect(chip).toBeInViewport();
    const box = (await chip.boundingBox())!;
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await expect(page.getByTestId("amount-input")).toHaveValue("");
    await expect(page.getByTestId("tour-bubble")).toBeFocused();
    // Tab stays out of the inert page.
    await page.keyboard.press("Tab");
    const focused = await page.evaluate(() => document.activeElement?.closest(".spdex-app") !== null);
    expect(focused).toBe(false);
  });

  test("Skip and Esc end it, remembered; the footer starts it again from the card", async ({ page }) => {
    await page.goto("/");
    await continuePastDisclaimer(page);
    await expect(page.getByTestId("tour-hello")).toBeVisible();
    await page.getByTestId("tour-skip-hello").click();
    await expect(page.getByTestId("tour-hello")).toHaveCount(0);
    expect(await page.evaluate(() => localStorage.getItem("spdex.tour.v1"))).toBe("seen");
    // Skipped before a service was chosen: Welcome's first step is still where it's done.
    await expect(page.getByTestId("welcome-step-1").getByTestId("first-run")).toBeVisible();

    await page.getByTestId("footer-tour").click();
    await expect(page.getByTestId("tour-hello")).toBeVisible();
    await page.getByTestId("tour-go").click();
    await expect(stopOn(page)).toHaveAttribute("data-stop", "connect");
    await page.keyboard.press("Escape");
    await expect(stopOn(page)).toHaveCount(0);
  });

  test("doesn't start for someone who already has a service", async ({ page }) => {
    await seedConfig(page, {}, { showWelcome: true });
    await page.goto("/");
    await continuePastDisclaimer(page);
    await expect(page.getByTestId("welcome-panel")).toBeVisible();
    await expect(page.getByTestId("tour-hello")).toHaveCount(0);
  });

  test("on a phone, the count rides a bar on top and the words a sheet below, with arrows", async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    await page.goto("/");
    await continuePastDisclaimer(page);
    await page.getByTestId("tour-go").click();
    await expect(page.getByTestId("tour-bar")).toContainText(`Tour · 1 of ${TOUR_STOPS.length}`);
    await expect(page.getByTestId("tour-next")).toHaveAttribute("aria-label", "Next");
    await expect(page.getByTestId("tour-back")).toHaveAttribute("aria-label", "Back");
    // The words show at every stop unless hidden, and come back with Show text.
    await expect(page.getByTestId("tour-body")).toBeVisible();
    await page.getByTestId("tour-text").click();
    await expect(page.getByTestId("tour-body")).toBeHidden();
    await expect(page.getByTestId("tour-wait")).toBeVisible();
    await page.getByTestId("tour-text").click();
    await expect(page.getByTestId("tour-body")).toBeVisible();
    // The step it points at starts below the bar.
    const bar = (await page.getByTestId("tour-bar").boundingBox())!;
    const step = (await page.getByTestId("welcome-step-1").boundingBox())!;
    expect(step.y).toBeGreaterThan(bar.y + bar.height);
    await context.close();
  });
});
