/**
 * What `pnpm keeper` and `pnpm keeper:report` share: JSON-RPC over fetch, a
 * file written whole or not at all, the package's version, and an error's
 * message.
 *
 * `src/` may make no request and use no Node API (boundaries.test.ts, and its
 * tsconfig, hold it to that), so the operator's scripts do both, here. This
 * file contacts nothing but the URL it is handed, and never puts that URL in
 * an error: an endpoint's path carries its API key.
 */

import { closeSync, fsyncSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import type { JsonRpc } from "@spdex/chain";

/** An endpoint's refusal, with the JSON-RPC error's `code` and `data` — a revert's, for a call — when it gave them. */
export class RpcError extends Error {
  constructor(
    message: string,
    /** A rate limit, or a server in trouble: worth asking again later, where any other refusal is the endpoint's answer. */
    readonly rateLimited: boolean,
    readonly code: number | null = null,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "RpcError";
  }
}

/**
 * JSON-RPC over fetch, shaped like `@spdex/chain`'s `httpRpc` — an error
 * keeps its `code` and `data`, so a revert can be decoded — with a timeout,
 * so a hung endpoint fails its request instead of stalling the caller.
 */
export function fetchRpc(url: string, timeoutMs: number): JsonRpc {
  let id = 0;
  return async (method, params) => {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status === 429) throw new RpcError(`${method}: rate limited (HTTP 429)`, true);
    let body: { result?: unknown; error?: { message?: string; code?: unknown; data?: unknown } };
    try {
      body = (await response.json()) as typeof body;
    } catch {
      throw new RpcError(`${method}: HTTP ${response.status}, not a JSON-RPC answer`, response.status >= 500);
    }
    if (body.error) {
      const text = body.error.message ?? "error";
      const code = typeof body.error.code === "number" ? body.error.code : null;
      throw new RpcError(`${method}: ${text}`, code === -32005 || /rate limit|too many requests/i.test(text), code, body.error.data);
    }
    return body.result;
  };
}

/**
 * Write, fsync, rename over, fsync the directory: a crash leaves the old file
 * or the new one, never half of either. `mode` is the file's before the
 * umask; private unless the caller says otherwise.
 */
export function writeAtomic(path: string, text: string, mode = 0o600): void {
  const tmp = `${path}.tmp-${process.pid}`;
  const fd = openSync(tmp, "w", mode);
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  const dir = openSync(dirname(path), "r");
  try {
    fsyncSync(dir);
  } finally {
    closeSync(dir);
  }
}

/** `@spdex/vault`'s version, for the keeper's `start` record and the report's provenance. */
export function packageVersion(): string {
  return (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;
}

/** An error's message, and its cause's (fetch puts the reason a request failed there). */
export function messageOf(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause instanceof Error ? `: ${error.cause.message}` : "";
  return `${error.message}${cause}`;
}
