/** Types for the verify gate's argument parser, which is plain JS so `node scripts/verify.mjs` runs it directly. */
export type VerifyArgs =
  | { ok: true; strict: boolean; json: boolean; only: string[] | null }
  | { ok: false; strict: boolean; json: boolean; error: string };

export declare function parseVerifyArgs(argv: readonly string[], stageIds: readonly string[]): VerifyArgs;
