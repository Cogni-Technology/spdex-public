/**
 * The display dock: colour mode, text size, motion and contrast, four rows
 * of the MODE chip's switch. It replaces the lone MODE chip.
 *
 * None of it is React state. Each row reads and writes its store (the colour
 * mode in lib/theme.ts, the rest in lib/a11y.ts), which boot applied before
 * the first paint and which follows other tabs, so every tab agrees.
 *
 * Rendered once. Where it sits is the stylesheet's call: in flow under the
 * masthead when Aa DISPLAY opens it, or pinned to the bottom-left corner,
 * always shown, where a wide screen has room beside the column (theme.css,
 * "Page layout"). `open` only matters where it isn't pinned.
 *
 * AUTO follows the system, and a setting here can only add accessibility:
 * AUTO motion under a system that reduces motion is reduced.
 *
 * The dock sits in the same place at every text size (theme.css, Page
 * layout): pinned bottom-left where the window is at least 90em wide, in
 * flow under the masthead otherwise. Changing the size resizes it, never
 * moves it, so the button just pressed stays where it was, with focus.
 */

import { useSyncExternalStore } from "react";
import { ModeSwitch } from "@spdex/ui";
import { a11yStore, setA11y, type ContrastPref, type MotionPref, type TextSize } from "../../lib/a11y.js";
import { themeStore, type Theme } from "../../lib/theme.js";
import { DISPLAY_DOCK_ID } from "./Masthead.js";

const THEMES: readonly { value: Theme; label: string }[] = [
  { value: "neon", label: "Neon" },
  { value: "pastel", label: "Pastel" },
];

const TEXT: readonly { value: `${TextSize}`; label: string }[] = [
  { value: "100", label: "A" },
  { value: "115", label: "A+" },
  { value: "130", label: "A++" },
];

const MOTION: readonly { value: MotionPref; label: string }[] = [
  { value: "auto", label: "Auto" },
  { value: "reduce", label: "Less" },
];

const CONTRAST: readonly { value: ContrastPref; label: string }[] = [
  { value: "auto", label: "Auto" },
  { value: "more", label: "More" },
];

export function DisplayDock({ open }: { open: boolean }) {
  const theme = themeStore();
  const mode = useSyncExternalStore(theme.subscribe, theme.get);
  const store = a11yStore();
  const prefs = useSyncExternalStore(store.subscribe, store.get);
  return (
    <section
      id={DISPLAY_DOCK_ID}
      className="spdex-dock"
      data-testid="display-dock"
      data-open={open ? "true" : "false"}
      aria-label="Display settings"
    >
      <ModeSwitch label="Mode" groupLabel="Colour mode" options={THEMES} value={mode} onChange={theme.set} testId="theme-toggle" />
      <ModeSwitch
        label="Text"
        groupLabel="Text size"
        options={TEXT}
        value={`${prefs.text}`}
        onChange={(value) => setA11y({ text: Number(value) as TextSize })}
        testId="text-size"
      />
      <ModeSwitch
        label="Motion"
        groupLabel="Motion"
        options={MOTION}
        value={prefs.motion}
        onChange={(motion) => setA11y({ motion })}
        testId="motion"
      />
      <ModeSwitch
        label="Contrast"
        groupLabel="Contrast"
        options={CONTRAST}
        value={prefs.contrast}
        onChange={(contrast) => setA11y({ contrast })}
        testId="contrast"
      />
    </section>
  );
}
