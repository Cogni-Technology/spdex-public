/**
 * Applies the saved colour mode and display preferences (text size, motion,
 * contrast: a11y.ts) before React renders anything.
 *
 * spx6900.com does this with an inline script in the page head. spDEX cannot:
 * its CSP (`script-src 'self'`, index.html) forbids inline scripts, and adding
 * a hash or nonce to let one through would weaken the policy for a colour.
 * Instead this module is the first import of main.tsx. ES modules evaluate
 * their imports in order before the importing module's own body runs, so the
 * attribute is on the root element before `createRoot(...).render(...)` is
 * reached.
 *
 * Nothing can flash in the meantime either. Until React commits, the page is
 * an empty body on paper, and paper, ink and surfaces are the same in both
 * modes; only the accents differ, and no accent-coloured pixel exists yet.
 * The display preferences are on the root before the first paint too, so a
 * page set to A++ or to more contrast never shows a frame at 100% or at the
 * normal contrast.
 *
 * Creating each store also starts following `storage` events, so this tab
 * adopts a mode or a size chosen in another one even before any control for
 * it is mounted.
 */

import { a11yStore } from "./a11y.js";
import { themeStore } from "./theme.js";

themeStore();
a11yStore();
