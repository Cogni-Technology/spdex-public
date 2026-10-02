import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { loadEnvFiles } from "../../scripts/env.mjs";

/** The repo root, where the env files live. */
const ROOT = fileURLToPath(new URL("../..", import.meta.url));

/**
 * The committed `.env.defaults`' `VITE_*` values, under everything Vite reads
 * itself: the real environment, `.env`, `.env.local` and the mode's files.
 *
 * Vite reads `.env` files by its own names only, never `.env.defaults`, so
 * without this a value committed there (the public fallback service, above
 * all) reached no build, dev server or release, and its button never showed.
 * Put into `process.env`, where Vite looks next, only for a name nothing
 * else set: the defaults are the lowest layer, as `scripts/env.mjs` has them
 * for every other tool. The values are part of what's built, so a release
 * publishes them with the rest (docs/IPFS-RELEASE.md).
 */
function applyEnvDefaults(mode: string): void {
  const set = loadEnv(mode, ROOT, "VITE_");
  for (const [name, value] of Object.entries(loadEnvFiles([".env.defaults"]))) {
    if (name.startsWith("VITE_") && !(name in set) && process.env[name] === undefined) process.env[name] = value;
  }
}

/**
 * `VITE_SPDEX_CANONICAL_ORIGIN`'s entries that aren't an http(s) origin
 * ("spdex.example", say, which is how Alchemy's Domains list writes a host).
 *
 * The app fails closed on any of them (lib/store.ts `canonicalOrigins`): the
 * built-in service is then used and offered nowhere, so a newcomer at the real
 * domain would be asked to choose a service. A release refuses to build with
 * one; a dev server says so and carries on.
 */
function unreadableCanonical(value: string): string[] {
  const bad: string[] = [];
  for (const part of value.split(/[\s,]+/)) {
    if (part === "") continue;
    try {
      const { protocol } = new URL(part);
      if (protocol !== "https:" && protocol !== "http:") bad.push(part);
    } catch {
      bad.push(part);
    }
  }
  return bad;
}

function checkCanonical(mode: string, command: "build" | "serve"): void {
  // As the build will see it: the real environment, the .env files, then the defaults.
  const bad = unreadableCanonical(loadEnv(mode, ROOT, "VITE_")["VITE_SPDEX_CANONICAL_ORIGIN"] ?? "");
  if (bad.length === 0) return;
  const message =
    `VITE_SPDEX_CANONICAL_ORIGIN has ${bad.map((part) => JSON.stringify(part)).join(", ")}, which isn't an origin. ` +
    "Write each as the browser does, scheme included (https://spdex.example). Until then the built-in network " +
    "service is used and offered nowhere (docs/RPC-RUNBOOK.md).";
  if (command === "build") throw new Error(message);
  console.warn(`\n${message}\n`);
}

/**
 * The bundled fonts' licence, in every build.
 *
 * The three display families (src/fonts.css) are under the SIL Open Font
 * License 1.1, which asks that the licence travel with each copy of the
 * fonts. The build copies the font files (hashed, by Vite) but nothing
 * references the OFL.txt beside each, so this emits them, unhashed and
 * byte for byte, at `assets/fonts/<family>/OFL.txt`. Same bytes, same
 * names, every build: the release stays reproducible.
 */
function fontLicences(): Plugin {
  const families = ["orbitron", "spacemono", "bebasneue"];
  return {
    name: "spdex-font-licences",
    apply: "build",
    generateBundle() {
      for (const family of families) {
        this.emitFile({
          type: "asset",
          fileName: `assets/fonts/${family}/OFL.txt`,
          source: readFileSync(fileURLToPath(new URL(`./src/assets/fonts/${family}/OFL.txt`, import.meta.url))),
        });
      }
    },
  };
}

export default defineConfig(({ mode, command }) => {
  applyEnvDefaults(mode);
  checkCanonical(mode, command);
  return {
    plugins: [react(), fontLicences()],
    // Env files live at the repo root, not in this app. Without this, every
    // VITE_SPDEX_* value silently reads as undefined — which does not error, it
    // just makes the built-in service and the public fallback quietly vanish
    // from the first-run screen.
    envDir: ROOT,
    server: { port: 5173, strictPort: true },
    build: {
      // Relative so a build works from any IPFS gateway path, not just a domain root.
      assetsDir: "assets",
      // Off for a release: source maps embed absolute build paths, so two
      // machines producing byte-identical application code would still produce
      // different files — and therefore a different CID, which is
      // indistinguishable from a tampered build.
      sourcemap: process.env["SPDEX_RELEASE"] !== "1",
    },
    base: "./",
  };
});
