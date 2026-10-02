/**
 * Lets plain `node` run this repo's TypeScript sources, for `pnpm keeper`.
 *
 * The packages are TypeScript with ESM-style `.js` specifiers that name `.ts`
 * files (the bundler and vitest resolve them; node does not). Node strips the
 * types itself (`--experimental-transform-types`, which also covers the
 * constructor parameter properties some packages use); this hook only maps a
 * relative `./x.js` imported from a `.ts` file to `./x.ts` when that is the
 * file that exists. Nothing else is rewritten, so a real `.js` file still wins.
 */

import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

if (typeof registerHooks !== "function") {
  throw new Error("pnpm keeper needs Node 22.15 or later (module.registerHooks)");
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (/^\.\.?\//.test(specifier) && specifier.endsWith(".js") && context.parentURL?.endsWith(".ts")) {
      const candidate = new URL(specifier.replace(/\.js$/, ".ts"), context.parentURL);
      if (existsSync(fileURLToPath(candidate))) return nextResolve(candidate.href, context);
    }
    return nextResolve(specifier, context);
  },
});
