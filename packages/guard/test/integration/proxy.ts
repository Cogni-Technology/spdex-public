/**
 * A JSON-RPC proxy in this test process, in front of the local fork: a
 * second "network service" whose answers a test can rewrite — a transfer
 * changed in a test-run, a head moved, silence — to stand for a service that
 * lies, lags or fails, without touching the fork itself.
 *
 * Node's `http` is reached with a dynamic import and typed here by the little
 * of it this uses, because this package carries no Node types (its sources
 * must not use Node APIs; see `process` in vault.test.ts).
 */

interface IncomingMessage {
  on(event: "data", listener: (chunk: Uint8Array) => void): void;
  on(event: "end", listener: () => void): void;
}
interface ServerResponse {
  writeHead(status: number, headers: Record<string, string>): void;
  end(body: string): void;
}
interface Server {
  listen(port: number, host: string, callback: () => void): void;
  address(): { port: number } | string | null;
  close(callback: () => void): void;
  closeAllConnections(): void;
}
interface NodeHttp {
  createServer(handler: (request: IncomingMessage, response: ServerResponse) => void): Server;
}

export interface RpcAnswer {
  result?: unknown;
  error?: unknown;
}

/**
 * How the proxy answers one request: `upstream()` asks the fork. Return the
 * answer to give, or "hang" to never answer.
 */
export type Rewrite = (method: string, params: unknown[], upstream: () => Promise<RpcAnswer>) => Promise<RpcAnswer | "hang">;

export interface Proxy {
  url: string;
  /** Every method asked, in order. */
  methods: string[];
  close(): Promise<void>;
}

export async function startProxy(target: string, rewrite: Rewrite): Promise<Proxy> {
  const http = (await import(/* @vite-ignore */ `node:${"http"}`)) as NodeHttp;
  const methods: string[] = [];
  const server = http.createServer((request, response) => {
    const chunks: Uint8Array[] = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      void (async () => {
        const text = new TextDecoder().decode(concat(chunks));
        const body = JSON.parse(text) as { jsonrpc: string; id: unknown; method: string; params: unknown[] };
        methods.push(body.method);
        const upstream = async (): Promise<RpcAnswer> => {
          const answer = await fetch(target, { method: "POST", headers: { "content-type": "application/json" }, body: text });
          return (await answer.json()) as RpcAnswer;
        };
        const answer = await rewrite(body.method, body.params, upstream);
        if (answer === "hang") return;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, ...answer }));
      })();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("the proxy has no port");
  return {
    url: `http://127.0.0.1:${address.port}`,
    methods,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

/** Passes everything through. */
export const passThrough: Rewrite = (_method, _params, upstream) => upstream();
