/**
 * A JsonRpc for the smoke suite's endpoint, with a retry for the answers that
 * mean "not now" (a rate limit, a gateway error, a dropped connection, a
 * fork's failed upstream fetch) and for nothing else. A revert, a bad
 * parameter or a wrong balance is never retried: the point is to measure
 * spDEX, not the endpoint's mood.
 */

import type { JsonRpc } from "../packages/chain/src/index.js";

/** JSON-RPC errors that mean "not now": a rate limit (Alchemy's says "compute units"), or a fork's failed upstream fetch. */
const TRANSIENT = /error sending request for url|failed to get account for|dns error|rate limit|too many requests|compute units/i;

let nextId = 0;

/** A JsonRpc over `url`, retrying only what is transient. */
export function smokeRpc(url: string): JsonRpc {
  return async (method: string, params: unknown[]) => {
    for (let attempt = 1; ; attempt++) {
      let transient: string;
      let response: Response | null = null;
      try {
        response = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: ++nextId, method, params }),
        });
      } catch (error) {
        // No answer at all: a dropped connection or a failed lookup.
        transient = (error as Error).message;
      }
      if (response !== null) {
        if (response.status === 429 || response.status >= 500) {
          transient = `HTTP ${response.status}`;
        } else {
          const json = (await response.json()) as { result?: unknown; error?: { code?: number; message: string; data?: unknown } };
          if (!json.error) return json.result;
          if (!TRANSIENT.test(json.error.message)) {
            // The code and data ride along, as a revert's reason is in its data.
            throw Object.assign(new Error(`${method}: ${json.error.message}`), { code: json.error.code, data: json.error.data });
          }
          transient = json.error.message;
        }
      }
      if (attempt >= 6) throw new Error(`${method}: still failing after ${attempt} tries (${transient!})`);
      await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
    }
  };
}
