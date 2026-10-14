/**
 * Choosing the network service: how spDEX reaches Ethereum (an RPC endpoint,
 * which the UI calls the network service, since "connect" is kept for the
 * wallet).
 *
 * A new visitor chooses in Welcome's first step, "Connect to Ethereum", on
 * the main page (`ServiceChoices`; the first-visit tour's first stop points
 * at it): their own service first, and beside it the built-in service where
 * it works, or a free public service where it doesn't. Every new visitor
 * chooses, at the release's own address too (decided 2026-10-06; until then
 * the built-in service was used there without asking, lib/store.ts
 * `autoBundledRpc`).
 *
 * `FirstRun`, a page of its own in place of the tiles, is Settings' Change
 * service, the built-in notice's "Choose a service", and the way on for
 * someone with no service whose Welcome is hidden or on a chain it doesn't
 * serve. It recommends a free key of the person's own first, a public
 * service second, and the built-in key last, where it works. Self-hosting
 * genuinely meaning self-sourcing is the honest version of the sovereignty
 * pitch anyway.
 *
 * Whichever endpoint is chosen, the operator sees the user's address and every
 * query. That is stated plainly in both rather than buried in a policy page.
 */

import { useId, useState } from "react";
import { Banner, Button, Disclosure, Field, Panel } from "@spdex/ui";
import { BUILT_IN_REFUSED_TITLE } from "../lib/errors.js";
import { CONNECT_COPY } from "../lib/tour.js";
import { InfoTerm } from "./dca/common.js";

/**
 * Ask an endpoint which chain it is, and adopt the answer.
 *
 * spDEX should believe the node it was pointed at rather than assume. A fork
 * run under its own chain id — which is the sane way to run one, since a fork
 * claiming to be mainnet makes wallets price gas from the real network — would
 * otherwise mismatch the wallet forever, with no way to correct it short of
 * hand-editing a config.
 *
 * It doubles as validation: until now any string starting with http was
 * accepted, and a typo surfaced later as an unexplained failure to quote.
 */
export async function probeChainId(url: string): Promise<number> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
  });
  if (!response.ok) throw new Error(`endpoint returned HTTP ${response.status}`);
  const json = (await response.json()) as { result?: string; error?: { message: string } };
  if (json.error) throw new Error(json.error.message);
  if (typeof json.result !== "string") throw new Error("endpoint did not report a chain id");
  return Number.parseInt(json.result, 16);
}

type ServiceSource = "bundled" | "user" | "fallback";

/**
 * Choosing a service: the address checked first (`probeChainId`), then handed
 * on with the chain it reported, or a line saying why it couldn't be used.
 */
export function useServiceChoice(onChoose: (url: string, source: ServiceSource, chainId: number) => void) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const choose = async (candidate: string, source: ServiceSource) => {
    if (!/^https?:\/\//i.test(candidate)) {
      setError("Enter a full web address starting with http:// or https://.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const chainId = await probeChainId(candidate);
      onChoose(candidate, source, chainId);
    } catch (probeError) {
      setError(
        `spDEX couldn't reach it: ${probeError instanceof Error ? probeError.message : String(probeError)}.`,
      );
    } finally {
      setBusy(false);
    }
  };

  return { busy, error, choose };
}

/** Said where the page waits for a service before showing a shared transaction. */
const RECEIPT_WAITING =
  "Someone shared a transaction. Choose a network service and spDEX will show what the chain says about it.";

/**
 * Welcome's first step: the person's own service, and one other. Beside it
 * the built-in service where this copy has one that works here (and it hasn't
 * turned this page away in this visit); otherwise the free public service,
 * said plainly as limited. Never both: two ways that aren't the person's own
 * read as a choice between equals.
 *
 * The test ids are FirstRun's, so a spec that chooses a service reads the
 * same either way; the two are never on the page together.
 */
export function ServiceChoices({
  bundledUrl,
  bundledRefused = false,
  fallbackUrl,
  onChoose,
  pendingReceipt = false,
}: {
  bundledUrl: string | null;
  bundledRefused?: boolean;
  fallbackUrl: string | null;
  onChoose: (url: string, source: ServiceSource, chainId: number) => void;
  pendingReceipt?: boolean;
}) {
  const [url, setUrl] = useState("");
  const { busy, error, choose } = useServiceChoice(onChoose);
  const submitOwn = () => void choose(url.trim(), "user");

  const other =
    bundledUrl !== null && !bundledRefused
      ? {
          url: bundledUrl,
          source: "bundled" as const,
          title: "Use the built-in service",
          text: CONNECT_COPY.builtIn,
          row: "rpc-bundled-row",
          testId: "rpc-use-bundled",
        }
      : fallbackUrl !== null
        ? {
            url: fallbackUrl,
            source: "fallback" as const,
            title: "Use a free public service",
            text: CONNECT_COPY.public,
            row: "rpc-fallback-row",
            testId: "rpc-use-fallback",
          }
        : null;

  return (
    <div className="spdex-connect" data-testid="first-run">
      {pendingReceipt ? (
        <p className="spdex-first-run__receipt" data-testid="first-run-receipt">
          {RECEIPT_WAITING}
        </p>
      ) : null}
      <section className="spdex-connect__choice" data-testid="first-run-own">
        <h4 className="spdex-connect__title">Use your own service</h4>
        <p>{CONNECT_COPY.own}</p>
        <div className="spdex-inline">
          <input
            className="spdex-input"
            data-testid="rpc-url-input"
            aria-label="Your service's URL"
            placeholder="https://…"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") submitOwn();
            }}
          />
          <Button variant="solid" onClick={submitOwn} disabled={busy} testId="rpc-save">
            {busy ? "Checking…" : "Use this"}
          </Button>
        </div>
        <Disclosure summary="How to get a free key" testId="rpc-free-key">
          <FreeKeyGuide where="above" />
        </Disclosure>
      </section>
      {other !== null ? (
        <section className="spdex-connect__choice" data-testid={other.row}>
          <h4 className="spdex-connect__title">{other.title}</h4>
          <p>{other.text}</p>
          <div>
            <Button variant="solid" disabled={busy} testId={other.testId} onClick={() => void choose(other.url, other.source)}>
              Use this
            </Button>
          </div>
        </section>
      ) : null}
      {bundledUrl !== null && bundledRefused ? (
        <p className="spdex-field__hint" data-testid="rpc-bundled-refused-note">
          The built-in service turned this page away, so it isn&apos;t offered until you reload.
        </p>
      ) : null}
      {error ? (
        <Banner tone="danger" title="That service didn't work" testId="rpc-error">
          {error}
        </Banner>
      ) : null}
    </div>
  );
}

export function FirstRun({
  bundledUrl,
  bundledRefused = false,
  fallbackUrl,
  onChoose,
  pendingReceipt = false,
  keep,
}: {
  bundledUrl: string | null;
  /**
   * The built-in service turned this page away earlier in this visit
   * (BuiltInServiceNotice): it isn't offered again, and a hint says why, so
   * the first, solid option is one that can work.
   */
  bundledRefused?: boolean;
  fallbackUrl: string | null;
  onChoose: (url: string, source: "bundled" | "user" | "fallback", chainId: number) => void;
  /**
   * The page was opened from a `#receipt=` link: someone shared a
   * transaction, and it is shown once a network service is chosen, read
   * through that service. Nothing is read before then.
   */
  pendingReceipt?: boolean;
  /**
   * Settings' Change service: the service in use, by name, and the way back
   * to it. It stays in use until another is chosen here, so leaving this
   * screen loses nothing.
   */
  keep?: { name: string; onKeep: () => void };
}) {
  const [url, setUrl] = useState("");
  const { busy, error, choose } = useServiceChoice(onChoose);

  const submitOwn = () => void choose(url.trim(), "user");

  // Three ways on, in the order spDEX recommends them (decided 2026-10-06):
  // a free key of the person's own, which gives every check; a free public
  // service, which usually can't run the safety check; and last, quietly, the
  // built-in key the spDEX team provides, shared by every visitor.
  const fallback = fallbackUrl ? { url: fallbackUrl, source: "fallback" as const } : null;
  const builtIn = bundledUrl && !bundledRefused ? { url: bundledUrl, source: "bundled" as const } : null;

  return (
    <Panel
      title={keep === undefined ? "Connect to Ethereum" : "Change network service"}
      subtitle="spDEX has no server. Choose how it connects to Ethereum."
      testId="first-run"
    >
      {keep !== undefined ? (
        <div className="spdex-first-run__option" data-testid="rpc-keep-row">
          <Button variant="ghost" disabled={busy} testId="rpc-keep" onClick={keep.onKeep}>
            Keep {keep.name}
          </Button>
          <p className="spdex-field__hint">It stays in use until you pick another below.</p>
        </div>
      ) : null}
      {pendingReceipt ? (
        <p className="spdex-first-run__receipt" data-testid="first-run-receipt">
          {RECEIPT_WAITING}
        </p>
      ) : null}

      {/* 1. Recommended. A heading and an always-rendered field, not a
          disclosure: e2e fills rpc-url-input without clicking anything first. */}
      <div data-testid="first-run-own">
        <h3 className="spdex-first-run__heading">
          Your own free key{" "}
          <span className="spdex-first-run__recommended" data-testid="rpc-recommended">
            Recommended
          </span>
        </h3>
        <p className="spdex-field__hint">Free, two minutes, and every feature works.</p>
        <FreeKeyGuide />
        <Field label="Your key's URL">
          <div className="spdex-inline">
            <input
              className="spdex-input"
              data-testid="rpc-url-input"
              placeholder="https://…"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") submitOwn();
              }}
            />
            <Button variant="solid" onClick={submitOwn} disabled={busy} testId="rpc-save">
              {busy ? "Checking…" : "Use this"}
            </Button>
          </div>
        </Field>
      </div>

      {/* 2. A free public service: offered, with what it can't do. "Usually",
          because the service isn't probed before it is chosen: probing would
          send the person's IP address to a service they haven't picked. */}
      {fallback ? (
        <div className="spdex-first-run__option" data-testid="rpc-fallback-row">
          <h3 className="spdex-first-run__heading">Or a free public service</h3>
          <Button variant="ghost" disabled={busy} testId="rpc-use-fallback" onClick={() => void choose(fallback.url, fallback.source)}>
            Use a free public service
          </Button>
          <p className="spdex-field__hint">Limited: swaps aren&apos;t safety-checked, and auto-buy won&apos;t work.</p>
        </div>
      ) : null}

      {/* 3. Last, and quiet: the built-in key, shared by every visitor. */}
      {builtIn ? (
        <p className="spdex-first-run__subtle-row" data-testid="rpc-bundled-row">
          <button
            type="button"
            className="spdex-first-run__subtle"
            data-testid="rpc-use-bundled"
            disabled={busy}
            onClick={() => void choose(builtIn.url, builtIn.source)}
          >
            Continue with spDEX&apos;s built-in service
          </button>{" "}
          <span className="spdex-field__hint">Courtesy of the spDEX team, and shared by every visitor.</span>
        </p>
      ) : bundledUrl && bundledRefused ? (
        <p className="spdex-field__hint" data-testid="rpc-bundled-refused-note">
          The built-in service turned this page away, so it isn&apos;t offered until you reload.
        </p>
      ) : null}

      <Banner tone="warn" title="Who can see what" testId="rpc-privacy-notice">
        {CONNECT_COPY.privacy}
        <InfoTerm tip="True of every option here; only your own node avoids it." label="Any way around it?" />
      </Banner>

      {error ? (
        <Banner tone="danger" title="That service didn't work" testId="rpc-error">
          {error}
        </Banner>
      ) : null}
    </Panel>
  );
}

/**
 * How to get a URL for "Your own free key" from a provider's free tier, in a
 * few steps a newcomer can follow, with Alchemy's own guide linked from the
 * first. Alchemy is walked through: its free plan
 * answers both what the safety check needs (`eth_simulateV1`) and what proving
 * needs (`eth_getProof`), as docs/RPC-RUNBOOK.md records. Infura is folded
 * beside it, said plainly as unchecked for those two. Links only, which the
 * person follows; the app fetches nothing from these sites (AGENTS.md rule 4).
 * The steps name what to pick and what to copy, not where each button sits,
 * which providers move. `where` is where the URL field is from the guide:
 * under it on FirstRun, above it in Welcome's fold.
 */
export function FreeKeyGuide({ where = "below" }: { where?: "above" | "below" }) {
  return (
    <div className="spdex-first-run__guide" data-testid="rpc-free-key-guide">
      <ol>
        <li>
          Sign up free at{" "}
          <a href="https://www.alchemy.com/docs/create-an-api-key" target="_blank" rel="noreferrer noopener">
            alchemy.com
          </a>
          .
        </li>
        <li>
          Create an app: <strong>Ethereum</strong>, <strong>Mainnet</strong>.
        </li>
        <li>
          Copy its <strong>HTTPS</strong> URL (<code>https://eth-mainnet.g.alchemy.com/v2/…</code>) and paste it {where}.
        </li>
      </ol>
      <p className="spdex-field__hint">Keep it private: it&apos;s your key. Alchemy lets you limit it to this site.</p>
      <Disclosure summary="Prefer Infura?" testId="rpc-infura-guide">
        <ol>
          <li>
            Sign up free at{" "}
            <a href="https://www.infura.io" target="_blank" rel="noreferrer noopener">
              infura.io
            </a>
            .
          </li>
          <li>
            Open your API key, with <strong>Ethereum Mainnet</strong> on.
          </li>
          <li>
            Copy its <strong>HTTPS</strong> URL (<code>https://mainnet.infura.io/v3/…</code>) and paste it {where}.
          </li>
        </ol>
        <p className="spdex-field__hint">Swaps work. Its safety check and SPX proofs haven&apos;t been tested yet.</p>
      </Disclosure>
    </div>
  );
}

/**
 * The built-in service refused this page (a key allowlisted elsewhere,
 * revoked, or out of its month's capacity): said once, without taking the
 * page away, with the two ways on. Never switched for the person: the public
 * service is another operator, and it usually can't safety-check.
 *
 * "Use a free public service" goes through the same probe as FirstRun's
 * button; "Choose a service" is Settings' Change service.
 */
export function BuiltInServiceNotice({
  answer,
  fallbackUrl,
  onChoose,
  onChooseAnother,
}: {
  /** What the built-in service answered, verbatim. */
  answer: string;
  fallbackUrl: string | null;
  onChoose: (url: string, source: "fallback", chainId: number) => void;
  onChooseAnother: () => void;
}) {
  const titleId = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const useFallback = async () => {
    if (fallbackUrl === null) return;
    setBusy(true);
    setError(null);
    try {
      onChoose(fallbackUrl, "fallback", await probeChainId(fallbackUrl));
    } catch (probeError) {
      setError(`spDEX couldn't reach it: ${probeError instanceof Error ? probeError.message : String(probeError)}.`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="spdex-prompt" tabIndex={-1} role="group" aria-labelledby={titleId}>
      <Banner
        tone="warn"
        title={<span id={titleId}>{BUILT_IN_REFUSED_TITLE}</span>}
        testId="builtin-refused"
      >
        <p className="spdex-banner__text">
          It turned this page away, so spDEX can&apos;t read prices or check a swap through it. Choose another service
          to carry on.
        </p>
        {fallbackUrl !== null ? (
          <p className="spdex-field__hint">
            The free public service usually can&apos;t safety-check: swaps say &quot;Not checked&quot; and auto-buy won&apos;t run.
          </p>
        ) : null}
        <div className="spdex-actions">
          {fallbackUrl !== null ? (
            <Button testId="builtin-use-fallback" disabled={busy} onClick={() => void useFallback()}>
              {busy ? "Checking…" : "Use a free public service"}
            </Button>
          ) : null}
          <Button variant={fallbackUrl === null ? "solid" : "ghost"} testId="builtin-choose" onClick={onChooseAnother}>
            Choose a service
          </Button>
        </div>
        {error !== null ? (
          <p className="spdex-field__hint" data-testid="builtin-fallback-error">
            {error}
          </p>
        ) : null}
        {/* What it answered, verbatim, as the error banner keeps it. */}
        <Disclosure testId="builtin-refused-details" summary="Details">
          <code className="spdex-error-raw">{answer}</code>
        </Disclosure>
      </Banner>
    </div>
  );
}
