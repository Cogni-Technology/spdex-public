/**
 * Community keeping: whether the connected wallet may be paid for buys inside
 * their community window, and the one transaction that makes it so.
 *
 * One closed fold at the foot of Help run the network. Nothing is read until
 * it is opened; then the wallet's standing is read at one block
 * (`readHolderStatus`), through the person's own network service. It needs no
 * private sending, so it shows whether or not Help run's batches can be sent.
 *
 * **Prove my SPX** builds the proof in the browser against the `finalized`
 * block, refuses it unless the rebuilt header hashes to the block's hash, has
 * the Engine's vault Guard check it as a `prove` (which reads that hash
 * itself), and sends that one call. Before a wallet's first proof — or one
 * whose proof couldn't be read, which may be its first — it says what proving
 * makes public, and asks to continue. A wallet that can't send it privately
 * when private sending is on is asked before it goes out publicly; nothing
 * is broadcast publicly unasked. **Prove another address**
 * (closed) does the same for an address typed in, with this wallet paying the
 * network fee. When the service refuses `eth_getProof`, it says so and opens
 * **Paste a proof** (closed otherwise): the exact requests to run elsewhere,
 * by hand, and a box for their answers, checked against the person's own
 * service before anything is sent, and sent only for an address Prove my SPX
 * would prove: an ordinary account holding 690 SPX now. This page fetches
 * from nowhere else.
 *
 * From five days before the proof lapses it shows a banner; the reminder's
 * tick, which notifies while spDEX is open, is mounted with Help run itself
 * (lib/reminders/lapse.ts), since this fold may never be opened.
 *
 * Testable without a browser: `KeepingView` draws each state from props.
 */

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Button, Disclosure } from "@spdex/ui";
import type { JsonRpc } from "@spdex/chain";
import type { Address, GuardVerdict, Hex, SubmitterConfig } from "@spdex/core";
import type { VaultProveIntent, VaultProveTxPlan } from "@spdex/guard";
import {
  ProofUnavailableError,
  buildHolderProof,
  checkPastedProof,
  checksumAddress,
  parsePastedProof,
  proveGasLimit,
  readHolderStatus,
  type HolderProof,
  type HolderStatus,
  LATEST_RELEASE,
} from "@spdex/vault";
import { RegistryAdvisory } from "./RegistryAdvisory.js";
import { uniqueByCode } from "../../lib/errors.js";
import type { OwnerWalletLock } from "../../lib/execute.js";
import {
  KEEPER_DOCS_LINK_TEXT,
  KEEPING_INTRO,
  KEEPING_TITLE,
  MAX_PASTE_CHARS,
  PASTE_INTRO_TEXT,
  PROOF_COST_TEXT,
  PROOF_DOCS_TEXT,
  PROOF_NOT_PUBLIC_TEXT,
  PROOF_ONE_SERVICE_TEXT,
  PROOF_REFUSED_TEXT,
  PROOF_UNSEEN_TEXT,
  PROVE_OTHER_TEXT,
  PROVING_PUBLISHES_TEXT,
  alreadyProvenText,
  keeperDocsUrl,
  lapseBannerShown,
  lapseBannerText,
  mayBeFirstProof,
  mayProve,
  offersProof,
  onThisDevice,
  otherAddressText,
  parseTypedAddress,
  pasteCommands,
  pasteRefusalText,
  proofDocsUrl,
  proofErrorText,
  proofRefusalText,
  proofPublicText,
  proofResultText,
  proveIntent,
  standingLines,
  waitForProof,
  type ProofResult,
} from "../../lib/network/keeping.js";
import { networkName } from "../../lib/networks.js";
import { quantity } from "../../lib/receipts.js";
import { NOTIFY_BLOCKED, type BuyDueNotifications } from "../../lib/reminders/notify.js";
import { PROOF_NOTIFY_LABEL, rememberProof } from "../../lib/reminders/lapse.js";
import { walletSender } from "../../lib/senders.js";
import { PrivateSubmissionUnavailable } from "../../lib/submit.js";
import { isUserRejection, PRIVATE_CONFIRM_TIMEOUT_MS, type Eip1193Provider } from "../../lib/wallet.js";
import { CopyButton, TxRef } from "../dca/common.js";
import "./network.css";

/** What proving needs from the Engine: its network service, its vault Guard's registry, and the proof check. */
export interface KeepingEngine {
  readonly rpc: JsonRpc;
  readonly vaultRegistry: Address;
  checkVaultProof(intent: VaultProveIntent): Promise<{ plan: VaultProveTxPlan; verdict: GuardVerdict }>;
}

export interface CommunityKeepingProps {
  engine: KeepingEngine;
  chainId: number;
  account: Address;
  submitter: SubmitterConfig;
  /** The wallet is asked for one thing at a time. */
  ownerLock?: OwnerWalletLock;
  /** The proof-lapse reminder, mounted with Help run; its tick shows here once the wallet has a proof. */
  reminder?: BuyDueNotifications;
  /** For tests; the page's wallet otherwise. */
  provider?: Eip1193Provider;
}

/** The connected wallet's standing, as last read, and when by this device's clock (ms), for its dates. */
export type StandingState =
  | { kind: "reading" }
  | { kind: "read"; status: HolderStatus; readAtMs?: number }
  | { kind: "failed"; text: string };

/** Where a proof stands, from the press to its receipt. */
export type ProvePhase =
  | { kind: "idle" }
  /** Before an address's first proof: what proving makes public, and Continue. */
  | { kind: "publish"; holder: Address }
  | { kind: "working"; holder: Address; text: string }
  /** The service refused `eth_getProof`: the paste path is open. */
  | { kind: "unavailable"; holder: Address }
  | { kind: "refused"; holder: Address; verdict: GuardVerdict }
  | { kind: "failed"; holder: Address; text: string }
  | { kind: "sending"; holder: Address; text: string; oneService: boolean }
  /** Private sending is on and the wallet can't sign for it: asked before it goes out publicly. */
  | { kind: "public"; holder: Address; reason: string; oneService: boolean }
  | { kind: "sent"; holder: Address; hash: Hex; result: ProofResult | null }
  /** Sent, and its receipt not seen before the wait ran out: it may still land, or have been dropped. */
  | { kind: "unseen"; holder: Address; hash: Hex };

/** Paste a proof: open or not, for whom, and the block the requests name (the service's `finalized`). */
export interface PasteState {
  open: boolean;
  holder: Address;
  block: { kind: "unread" } | { kind: "reading" } | { kind: "read"; number: bigint } | { kind: "failed"; text: string };
  text: string;
  error: string | null;
}

const lower = (value: string) => value.toLowerCase() as Address;
const busy = (phase: ProvePhase) =>
  phase.kind === "working" || phase.kind === "sending" || phase.kind === "public" || (phase.kind === "sent" && phase.result === null);

/** "Community keeping", closed, mounting its insides the first time it is opened. */
export function CommunityKeeping(props: CommunityKeepingProps) {
  const [opened, setOpened] = useState(false);
  return (
    <Disclosure
      summary={KEEPING_TITLE}
      testId="keeper-panel"
      onToggle={(open) => {
        if (open) setOpened(true);
      }}
    >
      {opened ? <KeepingBody {...props} /> : null}
    </Disclosure>
  );
}

function KeepingBody({ engine, chainId, account, submitter, ownerLock, reminder, provider }: CommunityKeepingProps) {
  const [standing, setStanding] = useState<StandingState>({ kind: "reading" });
  const [prove, setProve] = useState<ProvePhase>({ kind: "idle" });
  const [other, setOther] = useState<{ text: string; error: string | null }>({ text: "", error: null });
  const [paste, setPaste] = useState<PasteState>({ open: false, holder: lower(account), block: { kind: "unread" }, text: "", error: null });
  // Which account, chain and service an answer is for: one that arrives after any changed is dropped.
  const asked = useRef(0);
  // The answer to "send it publicly?", while it is asked: a no unless the person says yes.
  const publicAnswer = useRef<((yes: boolean) => void) | null>(null);
  const answerPublic = (yes: boolean) => {
    const resolve = publicAnswer.current;
    publicAnswer.current = null;
    if (yes) setProve((p) => (p.kind === "public" ? { kind: "sending", holder: p.holder, text: "Confirm in your wallet…", oneService: p.oneService } : p));
    resolve?.(yes);
  };
  // A question left unanswered when the panel goes is a no: nothing goes out publicly unasked.
  useEffect(() => () => publicAnswer.current?.(false), []);

  const readStanding = useCallback(async () => {
    const ticket = asked.current;
    setStanding({ kind: "reading" });
    try {
      const status = await readHolderStatus(engine.rpc, account, { registry: engine.vaultRegistry });
      if (ticket !== asked.current) return;
      setStanding({ kind: "read", status, readAtMs: Date.now() });
      if (status.state === "read" && status.validUntil !== null && status.chainTime !== null) {
        rememberProof({ chainId, holder: account, validUntil: status.validUntil, chainTime: status.chainTime });
      }
    } catch (error) {
      if (ticket !== asked.current) return;
      setStanding({ kind: "failed", text: `Couldn't read your wallet's standing (${error instanceof Error ? error.message : String(error)}).` });
    }
  }, [engine, account, chainId]);

  useEffect(() => {
    asked.current += 1;
    // A wallet that changed is not the one that was asked about sending publicly.
    publicAnswer.current?.(false);
    publicAnswer.current = null;
    setProve((current) => (current.kind === "sending" || current.kind === "sent" ? current : { kind: "idle" }));
    setPaste({ open: false, holder: lower(account), block: { kind: "unread" }, text: "", error: null });
    void readStanding();
  }, [readStanding, account]);

  // Paste a proof, opened: the block its requests name is the person's own
  // service's `finalized`, read now unless a refusal already named it.
  const openPaste = (open: boolean) => {
    setPaste((p) => ({ ...p, open }));
    if (!open || paste.block.kind === "reading" || paste.block.kind === "read") return;
    const ticket = asked.current;
    setPaste((p) => ({ ...p, block: { kind: "reading" } }));
    engine
      .rpc("eth_getBlockByNumber", ["finalized", false])
      .then((block) => {
        const number = quantity((block as { number?: unknown } | null)?.number);
        if (number === null) throw new Error("the network service named no finalized block");
        if (ticket === asked.current) setPaste((p) => ({ ...p, block: { kind: "read", number } }));
      })
      .catch((error: unknown) => {
        if (ticket !== asked.current) return;
        setPaste((p) => ({ ...p, block: { kind: "failed", text: `Couldn't read the finalized block (${error instanceof Error ? error.message : String(error)}).` } }));
      });
  };

  /** Check a built or pasted proof with the Guard, then send its one call. */
  const checkAndSend = async (proof: HolderProof) => {
    const holder = lower(proof.holder);
    setProve({ kind: "working", holder, text: "Running the safety check…" });
    const { plan, verdict } = await engine.checkVaultProof(proveIntent(proof, account, chainId));
    if (!verdict.signable) {
      setProve({ kind: "refused", holder, verdict });
      return;
    }
    if (ownerLock !== undefined && !ownerLock.tryAcquire()) {
      setProve({ kind: "failed", holder, text: "Your wallet is busy with another request. Try again when it finishes." });
      return;
    }
    try {
      const call = plan.calls[0]!;
      const oneService = verdict.level !== "verified";
      setProve({ kind: "sending", holder, text: "Confirm in your wallet…", oneService });
      // The gas limit the proof is signed with: its estimate and a fifth more, at most 750,000.
      const estimate = await engine
        .rpc("eth_estimateGas", [{ from: account, to: call.to, data: call.data, value: "0x0" }])
        .then((answer) => quantity(answer))
        .catch(() => null);
      const sender = walletSender({
        submitter,
        account,
        // The person chose private sending: a wallet that can't sign for it
        // is asked about, as a swap's is, never broadcast publicly unasked.
        // A proof moves no money and states a public fact, so a yes risks
        // nothing but its being seen before it is included.
        onPublicFallback: (reason) =>
          new Promise<boolean>((resolve) => {
            publicAnswer.current = resolve;
            setProve({ kind: "public", holder, reason, oneService });
          }),
        reads: engine.rpc,
        ...(provider === undefined ? {} : { provider }),
      });
      const sent = await sender.send({ to: call.to, data: call.data, value: call.value, chainId, gas: proveGasLimit(estimate) });
      setProve({ kind: "sent", holder, hash: sent.hash, result: null });
      const result = await waitForProof(engine.rpc, { hash: sent.hash, registry: engine.vaultRegistry, holder }, { timeoutMs: PRIVATE_CONFIRM_TIMEOUT_MS });
      // Not seen in time: said, and the panel free again, rather than waiting
      // for good on a proof a relay may have dropped.
      setProve(result === null ? { kind: "unseen", holder, hash: sent.hash } : { kind: "sent", holder, hash: sent.hash, result });
      if (holder === lower(account)) void readStanding();
    } catch (error) {
      setProve({
        kind: "failed",
        holder,
        text: isUserRejection(error)
          ? "Cancelled in your wallet. Nothing was sent."
          : error instanceof PrivateSubmissionUnavailable
            ? PROOF_NOT_PUBLIC_TEXT
            : `It didn't go out (${error instanceof Error ? error.message : String(error)}).`,
      });
    } finally {
      ownerLock?.release();
    }
  };

  /** Build a proof of `holder` from the person's own service, then check and send it. */
  const build = async (holder: Address) => {
    setProve({ kind: "working", holder, text: "Reading the finalized block and the proof from your network service…" });
    let proof: HolderProof;
    try {
      proof = await buildHolderProof(engine.rpc, holder);
    } catch (error) {
      if (error instanceof ProofUnavailableError) {
        setProve({ kind: "unavailable", holder });
        setPaste({ open: true, holder, block: { kind: "read", number: error.blockNumber }, text: "", error: null });
        return;
      }
      setProve({ kind: "failed", holder, text: proofErrorText(error)! });
      return;
    }
    try {
      await checkAndSend(proof);
    } catch (error) {
      setProve({ kind: "failed", holder, text: `The safety check couldn't run (${error instanceof Error ? error.message : String(error)}).` });
    }
  };

  /**
   * Prove `holder`: first, unless it is known to have proven before, say what
   * that makes public and wait for Continue. A proof that couldn't be read
   * may be its first.
   */
  const start = (holder: Address, validUntil: bigint | null) => {
    if (mayBeFirstProof(validUntil)) setProve({ kind: "publish", holder });
    else void build(holder);
  };

  const proveMine = () => {
    if (standing.kind !== "read" || standing.status.state !== "read") return;
    start(lower(account), standing.status.validUntil);
  };

  const proveOther = async () => {
    const parsed = parseTypedAddress(other.text);
    if ("error" in parsed) {
      setOther((o) => ({ ...o, error: parsed.error }));
      return;
    }
    setOther((o) => ({ ...o, error: null }));
    const holder = parsed.address;
    setProve({ kind: "working", holder, text: "Reading that address's standing…" });
    try {
      const status = await readHolderStatus(engine.rpc, holder, { registry: engine.vaultRegistry });
      if (!mayProve(status)) {
        setProve({ kind: "failed", holder, text: otherAddressText(status) });
        return;
      }
      // The connected wallet's own address, typed here, is held to Prove my
      // SPX's bar: proven for more than five more days, it needs nothing yet,
      // and a new proof would spend about 650,000 gas to move its date. Anyone
      // else's may be proven again early, on purpose (a cold wallet before a
      // trip), as the browser suite does at a newer block each run.
      if (lower(holder) === lower(account) && !offersProof(status)) {
        setProve({ kind: "failed", holder, text: alreadyProvenText(status, Date.now()) });
        return;
      }
      start(holder, status.state === "read" ? status.validUntil : null);
    } catch (error) {
      setProve({ kind: "failed", holder, text: `Couldn't read that address's standing (${error instanceof Error ? error.message : String(error)}).` });
    }
  };

  const sendPasted = async () => {
    const holder = paste.holder;
    if (paste.text.length > MAX_PASTE_CHARS) {
      setPaste((p) => ({ ...p, error: "That's far more than two answers: paste just the block and the proof." }));
      return;
    }
    // Only for an address Prove my SPX and Prove another address would prove:
    // an ordinary account holding 690 SPX now. A contract can never be paid,
    // whatever the registry records, and the Guard leaves that to this panel.
    const status =
      holder === lower(account) && standing.kind === "read"
        ? standing.status
        : await readHolderStatus(engine.rpc, holder, { registry: engine.vaultRegistry }).catch(() => null);
    const refused = pasteRefusalText(status);
    if (refused !== null) {
      setPaste((p) => ({ ...p, error: refused }));
      return;
    }
    let proof: HolderProof;
    try {
      proof = await checkPastedProof(engine.rpc, parsePastedProof(paste.text, holder));
    } catch (error) {
      setPaste((p) => ({ ...p, error: proofErrorText(error) }));
      return;
    }
    setPaste((p) => ({ ...p, error: null }));
    try {
      await checkAndSend(proof);
    } catch (error) {
      setProve({ kind: "failed", holder, text: `The safety check couldn't run (${error instanceof Error ? error.message : String(error)}).` });
    }
  };

  return (
    <KeepingView
      chainId={chainId}
      account={account}
      standing={standing}
      prove={prove}
      other={other}
      paste={paste}
      {...(reminder === undefined ? {} : { reminder })}
      onProveMine={proveMine}
      onContinue={(holder) => void build(holder)}
      onCancel={() => setProve({ kind: "idle" })}
      onPublic={answerPublic}
      onOtherText={(text) => setOther({ text, error: null })}
      onProveOther={() => void proveOther()}
      onPasteOpen={openPaste}
      onPasteText={(text) => setPaste((p) => ({ ...p, text, error: null }))}
      onPasteSend={() => void sendPasted()}
      onReadAgain={() => void readStanding()}
    />
  );
}

export interface KeepingViewProps {
  chainId: number;
  account: Address;
  standing: StandingState;
  prove: ProvePhase;
  other: { text: string; error: string | null };
  paste: PasteState;
  reminder?: BuyDueNotifications;
  /** The release's source, for the docs links; the build setting by default. */
  docs?: { keeper: string | null; proofs: string | null };
  /** Decision 31's notice; the build's (`REGISTRY_ADVISORY`, none until one is needed) by default. */
  advisory?: string | null;
  onProveMine: () => void;
  onContinue: (holder: Address) => void;
  onCancel: () => void;
  /** The answer to "send it publicly?" when the wallet can't send privately. */
  onPublic: (yes: boolean) => void;
  onOtherText: (text: string) => void;
  onProveOther: () => void;
  onPasteOpen: (open: boolean) => void;
  onPasteText: (text: string) => void;
  onPasteSend: () => void;
  onReadAgain: () => void;
}

/** The panel's insides, drawn from its state alone. */
export function KeepingView(props: KeepingViewProps) {
  const { chainId, account, standing, prove, other, paste, reminder } = props;
  const docs = props.docs ?? { keeper: keeperDocsUrl(), proofs: proofDocsUrl() };
  const status = standing.kind === "read" ? standing.status : null;
  const read = status?.state === "read" ? status : null;
  // Chain times as this device's clock reads them, by the standing's read.
  const clock = read !== null && standing.kind === "read" && standing.readAtMs !== undefined ? { chainTime: read.chainTime, readAtMs: standing.readAtMs } : null;
  const working = busy(prove);
  const mine = lower(account);
  // A paste says what proving publishes unless its address is the wallet, known to have proven before.
  return (
    <div className="spdex-helprun" data-testid="keeper">
      <p className="spdex-network-line">
        {KEEPING_INTRO}{" "}
        {docs.keeper !== null ? (
          <a href={docs.keeper} target="_blank" rel="noreferrer noopener" data-testid="keeper-docs">
            {KEEPER_DOCS_LINK_TEXT}
          </a>
        ) : null}
      </p>
      <RegistryAdvisory release={LATEST_RELEASE} testId="keeper-advisory" {...(props.advisory === undefined ? {} : { advisory: props.advisory })} />

      {standing.kind === "reading" ? (
        <p className="spdex-field__hint" data-testid="keeper-reading">
          Reading your wallet&apos;s standing…
        </p>
      ) : standing.kind === "failed" ? (
        <>
          <p className="spdex-network-warn" data-testid="keeper-read-failed">
            {standing.text} Nothing is shown rather than a guess.
          </p>
          <div className="spdex-actions">
            <Button variant="ghost" testId="keeper-read-again" onClick={props.onReadAgain}>
              Try again
            </Button>
          </div>
        </>
      ) : status?.state === "not-deployed" ? (
        <p className="spdex-network-line" data-testid="keeper-no-registry">
          The SPX holder registry isn&apos;t on {networkName(chainId)}, so there&apos;s nothing to prove here.
        </p>
      ) : read !== null ? (
        <Standing status={read} readAtMs={clock?.readAtMs} />
      ) : null}

      {read !== null && lapseBannerShown(read.validUntil, read.chainTime) ? (
        <p className="spdex-network-warn" data-testid="keeper-lapse" role="status">
          {lapseBannerText(onThisDevice(read.validUntil!, clock))}
        </p>
      ) : null}

      {read !== null && offersProof(read) && prove.kind !== "publish" ? (
        <>
          <div className="spdex-actions">
            <button type="button" className="spdex-button" data-testid="keeper-prove" data-money-control="" disabled={working} onClick={props.onProveMine}>
              Prove my SPX
            </button>
          </div>
          <p className="spdex-field__hint">{PROOF_COST_TEXT}</p>
        </>
      ) : null}

      <ProveStatus prove={prove} chainId={chainId} clock={clock} onContinue={props.onContinue} onCancel={props.onCancel} onPublic={props.onPublic} />

      {read !== null && read.validUntil !== null && read.validUntil > 0n && reminder !== undefined ? <ReminderTick reminder={reminder} /> : null}

      {status?.state === "not-deployed" ? null : (
        <>
          <Disclosure summary="Prove another address" testId="keeper-other">
            <p className="spdex-field__hint">{PROVE_OTHER_TEXT}</p>
            <label className="spdex-field">
              <span className="spdex-field__label">Address to prove</span>
              <input
                className="spdex-input"
                type="text"
                autoComplete="off"
                spellCheck={false}
                data-testid="keeper-other-address"
                placeholder="0x…"
                value={other.text}
                onChange={(event) => props.onOtherText(event.target.value)}
              />
            </label>
            {other.error !== null ? (
              <p className="spdex-network-warn" data-testid="keeper-other-error">
                {other.error}
              </p>
            ) : null}
            <div className="spdex-actions">
              <button
                type="button"
                className="spdex-button spdex-button--ghost"
                data-testid="keeper-prove-other"
                data-money-control=""
                disabled={working || other.text.trim() === ""}
                onClick={props.onProveOther}
              >
                Prove this address
              </button>
            </div>
          </Disclosure>

          <Disclosure summary="Paste a proof" testId="keeper-paste" open={paste.open} onToggle={props.onPasteOpen}>
            <PastePath
              paste={paste}
              firstProof={paste.holder !== mine || mayBeFirstProof(read?.validUntil)}
              working={working}
              docs={docs.proofs}
              onPasteText={props.onPasteText}
              onPasteSend={props.onPasteSend}
            />
          </Disclosure>
        </>
      )}
    </div>
  );
}

function Standing({ status, readAtMs }: { status: Extract<HolderStatus, { state: "read" }>; readAtMs: number | undefined }) {
  const lines = standingLines(status, readAtMs);
  return (
    <div data-testid="keeper-standing" data-eligible={String(lines.eligible)}>
      <p className="spdex-network-line spdex-network-line--strong" data-testid="keeper-eligible">
        {lines.headline}
      </p>
      <p className="spdex-network-line" data-testid="keeper-proof">
        {lines.proof}
      </p>
      <p className="spdex-network-line" data-testid="keeper-holding">
        {lines.holding}
      </p>
    </div>
  );
}

function ProveStatus({
  prove,
  chainId,
  clock,
  onContinue,
  onCancel,
  onPublic,
}: {
  prove: ProvePhase;
  chainId: number;
  clock: { chainTime: bigint | null; readAtMs: number } | null;
  onContinue: (holder: Address) => void;
  onCancel: () => void;
  onPublic: (yes: boolean) => void;
}) {
  switch (prove.kind) {
    case "idle":
      return null;
    case "publish":
      return (
        <div data-testid="keeper-publish">
          <p className="spdex-network-warn">{PROVING_PUBLISHES_TEXT}</p>
          <div className="spdex-actions">
            <button type="button" className="spdex-button" data-testid="keeper-prove-continue" data-money-control="" onClick={() => onContinue(prove.holder)}>
              Continue
            </button>
            <Button variant="ghost" testId="keeper-prove-cancel" onClick={onCancel}>
              Cancel
            </Button>
          </div>
        </div>
      );
    case "working":
      return (
        <p className="spdex-field__hint" data-testid="keeper-working" role="status">
          {prove.text}
        </p>
      );
    case "unavailable":
      return (
        <p className="spdex-network-warn" data-testid="keeper-unavailable">
          {PROOF_REFUSED_TEXT}
        </p>
      );
    case "failed":
      return (
        <p className="spdex-network-warn" data-testid="keeper-note">
          {prove.text}
        </p>
      );
    case "refused": {
      const items = uniqueByCode([...prove.verdict.violations, ...prove.verdict.warnings]);
      return (
        <div className="spdex-network-warn" data-testid="keeper-refused" role="alert">
          The safety check won&apos;t let this proof be sent:
          <ul className="spdex-helprun__reasons">
            {items.map((item) => (
              <li key={item.code} data-testid={`violation-${item.code}`}>
                {proofRefusalText(item)} <code className="spdex-code-tag">{item.code}</code>
              </li>
            ))}
          </ul>
        </div>
      );
    }
    case "sending":
      return (
        <>
          <p className="spdex-field__hint" data-testid="keeper-sending" role="status">
            {prove.text}
          </p>
          {prove.oneService ? (
            <p className="spdex-field__hint" data-testid="keeper-one-service">
              {PROOF_ONE_SERVICE_TEXT}
            </p>
          ) : null}
        </>
      );
    case "public":
      return (
        <div data-testid="keeper-public">
          <p className="spdex-network-warn">{proofPublicText(prove.reason)}</p>
          <div className="spdex-actions">
            <button type="button" className="spdex-button" data-testid="keeper-public-send" data-money-control="" onClick={() => onPublic(true)}>
              Send publicly
            </button>
            <Button variant="ghost" testId="keeper-public-cancel" onClick={() => onPublic(false)}>
              Cancel
            </Button>
          </div>
        </div>
      );
    case "sent":
    case "unseen":
      return (
        <div data-testid="keeper-result">
          <p className="spdex-network-line spdex-network-line--strong" data-testid="keeper-result-text" role="status">
            {prove.kind === "unseen"
              ? PROOF_UNSEEN_TEXT
              : prove.result === null
                ? "Sent. Waiting for it to be included…"
                : proofResultText(prove.result, clock)}
          </p>
          <p className="spdex-network-line">
            <TxRef chainId={chainId} hash={prove.hash} testId="keeper-tx" />
          </p>
        </div>
      );
  }
}

/** Remind me before my proof lapses: the buy-due notification's tick, for this reminder. */
function ReminderTick({ reminder }: { reminder: BuyDueNotifications }) {
  const [asking, setAsking] = useState<boolean | null>(null);
  const hintId = useId();
  if (!reminder.supported) return null;
  return (
    <>
      <label className="spdex-dca-check spdex-dca-notify spdex-keeping-notify">
        <input
          type="checkbox"
          data-testid="keeper-notify"
          checked={asking ?? reminder.enabled}
          disabled={asking !== null}
          aria-describedby={reminder.blocked ? hintId : undefined}
          onChange={(event) => {
            const on = event.currentTarget.checked;
            setAsking(on);
            void reminder.setEnabled(on).finally(() => setAsking(null));
          }}
        />
        {PROOF_NOTIFY_LABEL}
      </label>
      {reminder.blocked ? (
        <p className="spdex-field__hint" id={hintId} data-testid="keeper-notify-blocked">
          {NOTIFY_BLOCKED}
        </p>
      ) : null}
    </>
  );
}

function PastePath({
  paste,
  firstProof,
  working,
  docs,
  onPasteText,
  onPasteSend,
}: {
  paste: PasteState;
  firstProof: boolean;
  working: boolean;
  docs: string | null;
  onPasteText: (text: string) => void;
  onPasteSend: () => void;
}) {
  const commands = paste.block.kind === "read" ? pasteCommands(paste.holder, paste.block.number) : null;
  return (
    <div data-testid="keeper-paste-body">
      <p className="spdex-field__hint">
        {PASTE_INTRO_TEXT}{" "}
        {docs !== null ? (
          <a href={docs} target="_blank" rel="noreferrer noopener" data-testid="keeper-proof-docs">
            Services that answer it ↗
          </a>
        ) : (
          PROOF_DOCS_TEXT
        )}
      </p>
      <p className="spdex-network-line" data-testid="keeper-paste-holder">
        For <code className="spdex-code-tag">{checksumAddress(paste.holder)}</code>
        {paste.block.kind === "read" ? `, at block ${paste.block.number.toString()}` : ""}:
      </p>
      {paste.block.kind === "reading" || paste.block.kind === "unread" ? (
        <p className="spdex-field__hint">Reading the finalized block from your network service…</p>
      ) : paste.block.kind === "failed" ? (
        <p className="spdex-network-warn">{paste.block.text}</p>
      ) : null}
      {commands !== null ? (
        <>
          <pre className="spdex-network-commands" data-testid="keeper-paste-commands">
            {commands.join("\n\n")}
          </pre>
          <div className="spdex-network-copyrow">
            <CopyButton text={commands.join("\n")} label="Copy requests" testId="keeper-paste-copy" />
          </div>
          <textarea
            className="spdex-code"
            data-testid="keeper-paste-text"
            rows={6}
            spellCheck={false}
            placeholder="Paste both answers here."
            value={paste.text}
            onChange={(event) => onPasteText(event.target.value)}
          />
          {paste.error !== null ? (
            <p className="spdex-network-warn" data-testid="keeper-paste-error">
              {paste.error}
            </p>
          ) : null}
          {firstProof ? <p className="spdex-network-warn">{PROVING_PUBLISHES_TEXT}</p> : null}
          <div className="spdex-actions">
            <button
              type="button"
              className="spdex-button"
              data-testid="keeper-paste-send"
              data-money-control=""
              disabled={working || paste.text.trim() === ""}
              onClick={onPasteSend}
            >
              Check it and prove
            </button>
          </div>
        </>
      ) : null}
    </div>
  );
}
