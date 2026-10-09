import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseVerifyArgs } from "./verify-args.mjs";

// The gate's real stage ids, read from its source rather than copied, so a
// stage added or renamed there is what these tests check against.
const SOURCE = readFileSync(new URL("./verify.mjs", import.meta.url), "utf8");
const STAGE_IDS = [...SOURCE.matchAll(/^ {4}id: "([a-z-]+)",$/gm)].map((m) => m[1] as string);

describe("parseVerifyArgs", () => {
  it("reads the gate's stage ids from its source", () => {
    expect(STAGE_IDS).toContain("typecheck");
    expect(STAGE_IDS).toContain("redteam");
    expect(STAGE_IDS).toContain("contracts");
  });

  it("runs every stage when --only is absent", () => {
    expect(parseVerifyArgs([], STAGE_IDS)).toEqual({ ok: true, strict: false, json: false, only: null });
    expect(parseVerifyArgs(["--strict", "--json"], STAGE_IDS)).toEqual({
      ok: true,
      strict: true,
      json: true,
      only: null,
    });
  });

  it("accepts one stage and a comma list", () => {
    expect(parseVerifyArgs(["--only=unit"], STAGE_IDS)).toMatchObject({ ok: true, only: ["unit"] });
    expect(parseVerifyArgs(["--only=typecheck,unit,redteam"], STAGE_IDS)).toMatchObject({
      ok: true,
      only: ["typecheck", "unit", "redteam"],
    });
    expect(parseVerifyArgs(["--only= unit , redteam,"], STAGE_IDS)).toMatchObject({
      ok: true,
      only: ["unit", "redteam"],
    });
  });

  it("adds up several --only flags", () => {
    expect(parseVerifyArgs(["--only=unit", "--only=redteam"], STAGE_IDS)).toMatchObject({
      ok: true,
      only: ["unit", "redteam"],
    });
  });

  it("ignores the bare -- that pnpm can pass through", () => {
    expect(parseVerifyArgs(["--", "--strict", "--only=unit"], STAGE_IDS)).toMatchObject({
      ok: true,
      strict: true,
      only: ["unit"],
    });
  });

  it("refuses a typo, naming the valid stages", () => {
    const r = parseVerifyArgs(["--only=unti"], STAGE_IDS);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("unti");
    for (const id of STAGE_IDS) expect(r.error).toContain(id);
  });

  it("refuses a comma list with one unknown id rather than running the rest", () => {
    const r = parseVerifyArgs(["--only=typecheck,unit,redtaem"], STAGE_IDS);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("Unknown stage in --only: redtaem.");
  });

  it("refuses an --only that names nothing", () => {
    expect(parseVerifyArgs(["--only="], STAGE_IDS).ok).toBe(false);
    expect(parseVerifyArgs(["--only=,"], STAGE_IDS).ok).toBe(false);
  });

  it("refuses --only without an equals sign instead of running everything", () => {
    const r = parseVerifyArgs(["--only", "unit"], STAGE_IDS);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("--only=");
  });

  it("refuses a misspelt flag, which would otherwise run non-strict", () => {
    const r = parseVerifyArgs(["--stirct"], STAGE_IDS);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("--stirct");
  });

  it("still reports --json on a refusal, so the refusal can be printed as JSON", () => {
    expect(parseVerifyArgs(["--json", "--only=nope"], STAGE_IDS)).toMatchObject({ ok: false, json: true });
  });
});
