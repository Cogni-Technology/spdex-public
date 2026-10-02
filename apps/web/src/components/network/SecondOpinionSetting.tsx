/**
 * Second opinion (optional), in Expert → Safety: a second network service,
 * run by someone else, that test-runs every transaction too.
 *
 * A service is tested before it can be used (`testSecondOpinion`): it has to
 * be another service than the main one, on the same chain, and its test-run
 * of one fixed 1-wei transfer has to match the main service's exactly. One
 * that didn't would disagree about every swap that moves ether and refuse
 * them all, so it is caught here instead. A service that is probably the main
 * one's operator under another name is allowed, with a warning.
 *
 * What it catches, and what it doesn't, is said under the field, not left for
 * the person to assume.
 *
 * The saved address is shown masked, as the main service's is in Settings →
 * Network service: a second service's URL carries an API key as often as the
 * main one's, and Settings is what people screenshot. The field starts empty
 * rather than holding it; the full address is one Show away.
 */

import { useState } from "react";
import { Button, Disclosure, Field } from "@spdex/ui";
import type { SpdexConfig } from "@spdex/core";
import { testSecondOpinion, type SecondOpinionTest } from "../../lib/engine.js";
import { normalizeServiceUrl, sameOperatorWarning, sameService, sharedOperator } from "../../lib/simulation.js";
import { maskRpcUrl, rpcUrlMasked } from "../../lib/rpcDisplay.js";
import "./network.css";

/** The field's one line (UI rule R5, docs/ARCHITECTURE.md); the rest is in its "How it works" fold. */
export const SECOND_OPINION_HINT =
  "Another operator's service test-runs every transaction too; if the two disagree, spDEX won't let you sign.";

/** What the second service sees, and what happens when it doesn't answer: the fold's first line. */
export const SECOND_OPINION_DETAIL =
  "It sees what you're about to sign, as your main service does. If it doesn't answer, one-time swaps say " +
  '"Checked on one service", auto-buys you confirm are skipped, and vault transactions that send ether wait until it does.';

export const SECOND_OPINION_LIMIT =
  "It catches a service lying about what a transaction does. It doesn't check anything else your main service tells " +
  "spDEX: prices and the price check, balances, allowances, which contract sits at an address (such as Permit2's), " +
  "vault state, or fees. And no test-run, on one service or two, catches a contract built to behave differently a " +
  "few seconds later.";

type TestState = { kind: "idle" } | { kind: "testing"; url: string } | { kind: "done"; url: string; result: SecondOpinionTest };

export function SecondOpinionSetting({
  config,
  onChange,
  test = testSecondOpinion,
}: {
  config: SpdexConfig;
  /** Saves the whole config; the Expert panel marks it customised. */
  onChange: (next: SpdexConfig) => void;
  /** For tests; the real test otherwise, which asks both services. */
  test?: typeof testSecondOpinion;
}) {
  const saved = config.guard.secondOpinion?.url ?? null;
  // Empty, not the saved address: the field is for a new one.
  const [draft, setDraft] = useState<string>("");
  const [showUrl, setShowUrl] = useState(false);
  const [state, setState] = useState<TestState>({ kind: "idle" });
  const typed = draft.trim();
  const edited = typed !== "" && typed !== (saved ?? "");
  const passed = state.kind === "done" && state.result.ok && state.url === typed;

  const save = (url: string | null) =>
    onChange({ ...config, guard: { ...config.guard, secondOpinion: { url } } });

  const runTest = async () => {
    const url = typed;
    setState({ kind: "testing", url });
    let result: SecondOpinionTest;
    try {
      result = await test({ mainUrl: config.rpc.url, url, chainId: config.chainId });
    } catch (error) {
      result = { ok: false, error: `The test couldn't run (${error instanceof Error ? error.message : String(error)}).` };
    }
    setState((current) => (current.kind === "testing" && current.url === url ? { kind: "done", url, result } : current));
  };

  // Said while typing, before any test: the same service is never a second opinion.
  const sameAsMain = typed !== "" && sameService(typed, config.rpc.url);
  const operator = saved !== null && config.rpc.url !== null ? sharedOperator(saved, config.rpc.url) : null;

  return (
    <div className="spdex-second" data-testid="second-opinion">
      <Field label="Second opinion (optional)" hint={SECOND_OPINION_HINT}>
        <input
          className="spdex-input"
          type="url"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          data-testid="second-opinion-url"
          placeholder="https://…"
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
            setState({ kind: "idle" });
          }}
        />
      </Field>

      {saved !== null ? (
        <p className="spdex-network-line" data-testid="second-opinion-current">
          In use: <code className="spdex-second__url">{showUrl ? saved : maskRpcUrl(saved)}</code>
          {rpcUrlMasked(saved) ? (
            <>
              {" "}
              <button
                type="button"
                className="spdex-inline-action"
                data-testid="second-opinion-show"
                aria-pressed={showUrl}
                onClick={() => setShowUrl((shown) => !shown)}
              >
                {showUrl ? "Hide" : "Show"}
              </button>
            </>
          ) : null}
        </p>
      ) : null}
      {saved !== null && sameService(saved, config.rpc.url) ? (
        <p className="spdex-network-warn" data-testid="second-opinion-same">
          This is your main service, so it doesn&apos;t count as a second opinion: every transaction is test-run on one
          service only. Remove it, or use another.
        </p>
      ) : operator !== null && !edited ? (
        <p className="spdex-network-warn" data-testid="second-opinion-operator">
          {sameOperatorWarning(operator)}
        </p>
      ) : null}

      {edited && typed !== "" && normalizeServiceUrl(typed) === null ? (
        // Test stays off for it; without this line nothing said why.
        <p className="spdex-field__hint" data-testid="second-opinion-invalid">
          Enter a whole web address, starting with https:// or http://.
        </p>
      ) : null}
      {sameAsMain && edited ? (
        <p className="spdex-network-warn" data-testid="second-opinion-error">
          That&apos;s your main service. A second opinion has to come from somewhere else.
        </p>
      ) : null}
      {state.kind === "done" && state.url === typed && !state.result.ok ? (
        <p className="spdex-network-warn" data-testid="second-opinion-error" role="alert">
          {state.result.error}
        </p>
      ) : null}
      {passed && state.result.ok ? (
        <>
          <p className="spdex-network-line" data-testid="second-opinion-passed">
            Works: its test-run matches your main service&apos;s.
          </p>
          {state.result.warning !== null ? (
            <p className="spdex-network-warn" data-testid="second-opinion-operator">
              {state.result.warning}
            </p>
          ) : null}
        </>
      ) : null}
      {state.kind === "testing" ? (
        <p className="spdex-field__hint" data-testid="second-opinion-testing">
          Test-running one transfer on both services…
        </p>
      ) : null}

      <div className="spdex-actions">
        {edited && typed !== "" ? (
          <Button
            variant={passed ? "ghost" : "solid"}
            testId="second-opinion-test"
            disabled={state.kind === "testing" || sameAsMain || normalizeServiceUrl(typed) === null}
            onClick={() => void runTest()}
          >
            Test
          </Button>
        ) : null}
        {edited && passed ? (
          <Button
            testId="second-opinion-save"
            onClick={() => {
              save(normalizeServiceUrl(typed) === null ? null : typed);
              // Off the screen once saved: "In use" shows it, masked.
              setDraft("");
              setShowUrl(false);
              setState({ kind: "idle" });
            }}
          >
            Use this service
          </Button>
        ) : null}
        {saved !== null ? (
          <Button
            variant="ghost"
            testId="second-opinion-remove"
            onClick={() => {
              save(null);
              setDraft("");
              setShowUrl(false);
              setState({ kind: "idle" });
            }}
          >
            Remove
          </Button>
        ) : null}
      </div>
      {edited && typed !== "" && !passed && normalizeServiceUrl(typed) !== null && !sameAsMain ? (
        <p className="spdex-field__hint">A service has to pass the test before it can be used.</p>
      ) : null}

      <Disclosure summary="How it works, and what it doesn't check" testId="second-opinion-limits">
        <p className="spdex-network-line">{SECOND_OPINION_DETAIL}</p>
        <p className="spdex-network-line">{SECOND_OPINION_LIMIT}</p>
        <p className="spdex-network-line spdex-network-line--quiet">
          The 10-minute price check still reads your main service only. Typed money amounts are the exception: when your
          second service answers, they are sized only from prices both services agree on to within 1%; when it
          doesn&apos;t, from your main service alone.
        </p>
      </Disclosure>
    </div>
  );
}
