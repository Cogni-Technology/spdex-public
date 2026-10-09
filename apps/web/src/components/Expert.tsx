/**
 * Settings sections: the Expert view's (markets used, router, sending,
 * safety) and Tips, which both views show.
 *
 * Not a separate application, and not a set of hidden levers — the same
 * `SpdexConfig` the Simple view writes into, exposed directly. That
 * equivalence is the point: there is no simplified path that behaves
 * differently from the real one, so a beginner and a cypherpunk are running
 * identical code with different values.
 *
 * Pool pinning is the headline. Switching to allowlist mode makes "route
 * through this pool and nothing else" literally true, and the router cannot
 * reach outside the candidate set it is given.
 *
 * Each section is a `SettingsSection` of the Settings tile
 * (components/shell/SettingsTile.tsx), one open at a time, and keeps the test
 * id its panel had.
 */

import { useState, type ReactNode } from "react";
import { Banner, Button, Field, Row, SettingsSection, Term, Toggle } from "@spdex/ui";
import {
  cleanTipText,
  isPlaceholderChain,
  isPublicDevAccount,
  MAX_TIP_RECIPIENTS,
  MAX_TOTAL_TIP_BPS,
  TipPolicySchema,
  type SpdexConfig,
  type TipRecipient,
} from "@spdex/core";
import { GLOSSARY } from "../lib/names.js";
import { KNOWN_RELAYS } from "../lib/submit.js";
import type { DiscoveredPool, DiscoveredRecipient } from "../lib/engine.js";
import { formatFee, formatPoolMoney, type PricedPool } from "../lib/stats.js";
import type { MoneyView } from "../lib/money/convert.js";
import type { Pricing } from "../lib/money/pricing.js";
import { moneyView } from "../lib/money/rates.js";
import { formatCount, formatNumber } from "../lib/money/format.js";
import { bpsText, listsPlaceholders, NO_LISTED_YET, NO_VERIFIED_LIST, offeredCandidates, pillName, recipientsTotal } from "../lib/tipRow.js";
import { describeRecipient, MY_TIP_LIST_LABEL, MY_TIP_LIST_SOURCE, NOT_CONFIRMED, payablePolicy } from "../lib/tiplist/checks.js";
import { knownContract } from "../lib/tiplist/contracts.js";
import { checksumAddress } from "../lib/culture/contract.js";
import { GroupedHex } from "./culture/ContractBadge.js";
import { useTips } from "./tips/context.js";
import { MyTipList } from "./tips/MyTipList.js";
import { TipTagChip } from "./tips/TipTagChip.js";
import { Permit2Permissions, type Permit2PermissionsProps } from "./Permit2Permissions.js";
import { SecondOpinionSetting } from "./network/SecondOpinionSetting.js";

/**
 * TVL and fee next to a pool in the picker, when they are known.
 *
 * Silent when the tracker is off rather than showing a placeholder: the
 * statistics panel already explains where these come from, and a row of
 * dashes in the picker would just be noise for a user who turned the feature
 * off deliberately.
 */
function PoolFigures({
  stats,
  poolId,
  fee,
  money,
}: {
  stats: readonly PricedPool[];
  poolId: string;
  fee: number;
  /** The page's rates and currency, as the markets panel shows these figures; dollars without them. */
  money: MoneyView | undefined;
}) {
  const stat = stats.find((s) => s.poolId.toLowerCase() === poolId.toLowerCase());
  if (!stat) return null;
  return (
    <span className="spdex-pool__meta" style={{ marginLeft: 8 }} data-testid={`picker-tvl-${poolId}`}>
      {formatPoolMoney(stat.tvlUsd, money)} · {formatFee(fee)}
      {stat.shareBps !== null ? ` · ${formatNumber(stat.shareBps / 100, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}% of pair` : ""}
    </span>
  );
}

/**
 * A number the config bounds, typed freely and saved only when it is valid.
 *
 * Refused rather than clamped, as tips are: a value silently pulled into range
 * would leave the field disagreeing with what the person typed. The draft
 * lives here so typing "900" over "600" can pass through "9" without the
 * field snapping back; only a whole value inside the bounds reaches the
 * config, and anything else says what would be accepted.
 */
function BoundedNumber({
  label,
  value,
  min,
  max,
  step,
  toConfig,
  fromConfig,
  hint,
  testId,
  onCommit,
}: {
  label: string;
  /** The config's value. */
  value: number;
  /** Bounds in the unit shown. */
  min: number;
  max: number;
  step?: number;
  /** Shown unit → config unit, or null when it isn't a value the config can hold. */
  toConfig: (shown: number) => number | null;
  fromConfig: (stored: number) => string;
  hint: (stored: number) => ReactNode;
  testId: string;
  onCommit: (stored: number) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? fromConfig(value);
  const parsed = draft === null || draft.trim() === "" ? null : Number(draft);
  const invalid = draft !== null && (parsed === null || !Number.isFinite(parsed) || parsed < min || parsed > max || toConfig(parsed) === null);

  return (
    <Field
      label={label}
      hint={invalid ? `Between ${formatCount(min)} and ${formatCount(max)}. Not saved.` : hint(value)}
    >
      <input
        className="spdex-input spdex-num"
        type="number"
        min={min}
        max={max}
        {...(step === undefined ? {} : { step })}
        data-testid={testId}
        value={shown}
        onChange={(event) => {
          const text = event.target.value;
          setDraft(text);
          const next = text.trim() === "" ? Number.NaN : Number(text);
          if (!Number.isFinite(next) || next < min || next > max) return;
          const stored = toConfig(next);
          if (stored !== null) onCommit(stored);
        }}
        // Leaving the field shows what was actually saved.
        onBlur={() => setDraft(null)}
      />
    </Field>
  );
}

/** Basis points as a percentage, to two places at most: 50 → "0.5". */
function bpsPercent(bps: number): string {
  return formatNumber(bps / 100, { maximumFractionDigits: 2 });
}

export interface ExpertSectionsProps {
  config: SpdexConfig;
  pools: DiscoveredPool[];
  /**
   * Real figures from the tracker, when it is enabled.
   *
   * Replaces `depth` in the picker. `depth` is a venue-defined proxy that is
   * only comparable within a venue — so a v2 pair and a v3 pool showed two
   * numbers that looked like they could be ranked against each other and could
   * not be. A dollar figure is comparable, and its absence is visible.
   */
  stats: readonly PricedPool[];
  /** The page's rates and currency, for the picker's money figures. Only read: the markets panel asks for them. */
  pricing: Pricing | null;
  onChange: (next: SpdexConfig) => void;
}

/** The Expert view's sections: markets used, router, sending and safety. */
export function ExpertSections({ config, pools, stats, pricing, onChange }: ExpertSectionsProps) {
  const money = moneyView(pricing, performance.now());
  const allowed = new Set(config.pools.allow.map((p) => p.poolId.toLowerCase()));
  const denied = new Set(config.pools.deny.map((p) => p.poolId.toLowerCase()));

  // Any deliberate edit marks the config as no longer the shipped preset, so
  // the diff view has something truthful to compare against.
  const update = (patch: Partial<SpdexConfig>) =>
    onChange({ ...config, ...patch, preset: "custom" });

  const togglePool = (pool: DiscoveredPool) => {
    const id = pool.poolId.toLowerCase();
    if (config.pools.mode === "allowlist") {
      const next = allowed.has(id)
        ? config.pools.allow.filter((p) => p.poolId.toLowerCase() !== id)
        : [
            ...config.pools.allow,
            { venueId: pool.venueId, poolId: pool.poolId, ...(pool.label ? { label: pool.label } : {}) },
          ];
      update({ pools: { ...config.pools, allow: next } });
      return;
    }
    // In recommended mode the same control denies, since everything discovered
    // is otherwise in play. Denials apply in both modes and are never overridden.
    const next = denied.has(id)
      ? config.pools.deny.filter((p) => p.poolId.toLowerCase() !== id)
      : [...config.pools.deny, { venueId: pool.venueId, poolId: pool.poolId }];
    update({ pools: { ...config.pools, deny: next } });
  };

  const pinOnly = (pool: DiscoveredPool) =>
    update({
      pools: {
        mode: "allowlist",
        allow: [
          { venueId: pool.venueId, poolId: pool.poolId, ...(pool.label ? { label: pool.label } : {}) },
        ],
        deny: [],
      },
    });

  const enabledFor = (pool: DiscoveredPool) => {
    const id = pool.poolId.toLowerCase();
    if (denied.has(id)) return false;
    return config.pools.mode === "allowlist" ? allowed.has(id) : true;
  };

  return (
    <>
      <SettingsSection testId="expert-pools" summary="Markets used">
        <p className="spdex-field__hint">Switched-off markets are never used. Allowlist only uses nothing else.</p>
        {/* Never the string "depth " anywhere in this panel, tips included:
            tracker.spec asserts its absence, because the old opaque depth
            proxy was what the dollar figures replaced. */}
        <Field label="Policy">
          <Toggle
            testId="pool-mode"
            value={config.pools.mode}
            onChange={(mode) => update({ pools: { ...config.pools, mode } })}
            options={[
              { value: "recommended", label: "All found" },
              { value: "allowlist", label: "Allowlist only" },
            ]}
          />
        </Field>

        <div data-testid="pool-list">
          {pools.length === 0 ? (
            <p className="spdex-field__hint">No markets found for this pair yet.</p>
          ) : null}
          {pools.map((pool) => (
            <div className="spdex-pool" key={pool.poolId} data-testid={`pool-${pool.poolId}`}>
              {/* A label round the box, so a phone gets a 44px target for it
                  (theme.css) and the box has a name to be read by. */}
              <label className="spdex-pool__check">
                <input
                  type="checkbox"
                  data-testid={`pool-toggle-${pool.poolId}`}
                  aria-label={`Use ${pool.label ?? pool.poolId}`}
                  checked={enabledFor(pool)}
                  onChange={() => togglePool(pool)}
                />
              </label>
              <div style={{ flex: 1 }}>
                <div>
                  {pool.label ?? pool.poolId}
                  <PoolFigures stats={stats} poolId={pool.poolId} fee={pool.fee} money={money} />
                </div>
                <div className="spdex-pool__meta">
                  {pool.venueId} · {pool.poolId}
                </div>
              </div>
              <Button variant="ghost" testId={`pin-pool-${pool.poolId}`} onClick={() => pinOnly(pool)}>
                Pin only this
              </Button>
            </div>
          ))}
        </div>
      </SettingsSection>

      <SettingsSection testId="expert-router" summary="Router">
        <p className="spdex-field__hint">How a swap is split, and when a split must pay for itself.</p>
        {/* Each is checked against the config schema's bounds before it is
            saved: a value the schema refuses would make the saved config
            unreadable, and an unreadable config opens as the preset — in this
            tab on reload, and in every other open tab at once. */}
        <BoundedNumber
          label="Split precision (chunks)"
          value={config.router.chunkCount}
          min={1}
          max={100}
          toConfig={(shown) => (Number.isInteger(shown) ? shown : null)}
          fromConfig={String}
          hint={() => "Granularity of the split. More chunks means finer routes and more quoting."}
          testId="router-chunks"
          onCommit={(chunkCount) => update({ router: { ...config.router, chunkCount } })}
        />
        <BoundedNumber
          label="Maximum parts"
          value={config.router.maxSplits}
          min={1}
          max={8}
          toConfig={(shown) => (Number.isInteger(shown) ? shown : null)}
          fromConfig={String}
          hint={() => "Ceiling on markets in one swap, so network fees are not spent chasing dust."}
          testId="router-max-splits"
          onCommit={(maxSplits) => update({ router: { ...config.router, maxSplits } })}
        />
        <BoundedNumber
          label="Minimum gain to split (bps)"
          value={config.router.minSplitGainBps}
          min={0}
          max={10_000}
          toConfig={(shown) => (Number.isInteger(shown) ? shown : null)}
          fromConfig={String}
          hint={(stored) =>
            `= ${bpsPercent(stored)}%. A split must beat the best single market by at least this much, after network fees.`
          }
          testId="router-min-gain"
          onCommit={(minSplitGainBps) => update({ router: { ...config.router, minSplitGainBps } })}
        />
        <BoundedNumber
          label="Price tolerance (bps)"
          value={config.slippageBps}
          min={1}
          max={5_000}
          toConfig={(shown) => (Number.isInteger(shown) ? shown : null)}
          fromConfig={String}
          hint={(stored) => `= ${bpsPercent(stored)}% — at 50 bps you get at least 99.5% of the estimate`}
          testId="slippage-bps"
          onCommit={(slippageBps) => update({ slippageBps })}
        />
        {/* A scheduled buy is quoted with one market, so its costs and its
            number of wallet prompts can be stated in advance. */}
        <p className="spdex-field__hint">Auto-buys always use one market per buy, whatever Maximum parts says.</p>
      </SettingsSection>

      <SettingsSection testId="expert-submitter" summary="Sending">
        <p className="spdex-field__hint">Where a signed transaction goes. Public means the mempool, where bots can get ahead of it.</p>
        <Field label="How">
          <Toggle
            testId="submitter-mode"
            value={config.submitter.mode}
            onChange={(mode) =>
              update({
                submitter: {
                  ...config.submitter,
                  mode,
                  url:
                    mode === "private"
                      ? (config.submitter.url ?? KNOWN_RELAYS[0].url)
                      : config.submitter.url,
                },
              })
            }
            options={[
              { value: "wallet", label: "Public (your wallet)" },
              { value: "private", label: "Private sending" },
            ]}
          />
        </Field>

        {config.submitter.mode === "private" ? (
          <Field
            label="Relay address"
            hint="Your wallet signs without broadcasting, and spDEX posts the signed transaction here, so it never enters the public mempool. If your wallet can't, spDEX asks before sending publicly."
          >
            <input
              className="spdex-input"
              data-testid="submitter-url"
              value={config.submitter.url ?? ""}
              placeholder={KNOWN_RELAYS[0].url}
              onChange={(event) =>
                update({ submitter: { ...config.submitter, url: event.target.value || null } })
              }
            />
          </Field>
        ) : null}

        {config.submitter.mode === "private" ? (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {KNOWN_RELAYS.map((relay) => (
              <Button
                key={relay.url}
                variant="ghost"
                testId={`relay-${relay.label.split(" ")[0]!.toLowerCase()}`}
                onClick={() => update({ submitter: { ...config.submitter, url: relay.url } })}
              >
                {relay.label}
              </Button>
            ))}
          </div>
        ) : null}
      </SettingsSection>

      <SettingsSection testId="expert-safety" summary="Safety">
        <p className="spdex-field__hint">What spDEX requires before you sign.</p>
        <label className="spdex-pool" style={{ border: 0 }}>
          <input
            type="checkbox"
            data-testid="require-simulation"
            checked={config.guard.requireSimulation}
            onChange={(event) =>
              update({ guard: { ...config.guard, requireSimulation: event.target.checked } })
            }
          />
          <div>
            <div>Refuse to sign anything unsimulated</div>
            {/* Prose, so the hint class: the pool rows' address class breaks anywhere, mid-word on a phone. */}
            <div className="spdex-field__hint">Off: unchecked swaps show UNVERIFIED. On: they&apos;re blocked.</div>
          </div>
        </label>

        <SecondOpinionSetting config={config} onChange={(next) => update({ guard: next.guard })} />

        <label className="spdex-pool" style={{ border: 0 }}>
          <input
            type="checkbox"
            data-testid="strict-sandbox"
            checked={config.strictSandbox}
            onChange={(event) => update({ strictSandbox: event.target.checked })}
          />
          <div>
            <div>Run every module in the sandbox</div>
            <div className="spdex-field__hint">
              First-party modules run natively for speed. On: they run in QuickJS too, so you can see the fast path
              changes nothing.
            </div>
          </div>
        </label>

        <Row label="Venue runtime" value={config.strictSandbox ? "quickjs (sandboxed)" : "native"} testId="runtime-kind" />

        {/* Settable only in the settings file until now. Both only ever make
            a check stricter or looser within the bounds the schema allows;
            neither can switch a check off. */}
        <BoundedNumber
          label="Transaction deadline (seconds)"
          value={config.deadlineSeconds}
          min={30}
          max={86_400}
          toConfig={(shown) => (Number.isInteger(shown) ? shown : null)}
          fromConfig={String}
          hint={(stored) =>
            `= ${formatNumber(stored / 60, { maximumFractionDigits: 1 })} minutes. A swap not mined by then cancels itself, and only the network fee is spent.`
          }
          testId="deadline-seconds"
          onCommit={(deadlineSeconds) => update({ deadlineSeconds })}
        />
        <BoundedNumber
          label="Price warning threshold (%)"
          value={config.guard.oracleDivergenceBps}
          min={0}
          max={100}
          step={0.01}
          // Stored in basis points: a percentage with more than two decimals
          // has no exact value there, so it is refused rather than rounded.
          toConfig={(shown) => {
            const bps = Math.round(shown * 100);
            return Math.abs(bps - shown * 100) < 1e-6 ? bps : null;
          }}
          fromConfig={(stored) => String(stored / 100)}
          hint={() => (
            <>
              Warn when a swap&apos;s price is this far from the{" "}
              <Term tip={GLOSSARY.tenMinuteAverage}>10-minute average price</Term>. A warning never blocks a swap;
              an auto-buy that draws one waits for you.
            </>
          )}
          testId="oracle-divergence"
          onCommit={(oracleDivergenceBps) => update({ guard: { ...config.guard, oracleDivergenceBps } })}
        />
      </SettingsSection>
    </>
  );
}

/**
 * The Tips section of Settings, in both views: "My tip list" (the person's
 * own addresses, kept in this browser), the Permit2 permission batched tips
 * rest on, with Revoke; and, in the Expert view, exact shares person by
 * person (`expert-tips`).
 */
export function TipsSettings({
  config,
  expert,
  tipCandidates,
  permit2,
  onChange,
}: {
  config: SpdexConfig;
  expert: boolean;
  /** Who the tip registry names; null while it is asked. */
  tipCandidates: readonly DiscoveredRecipient[] | null;
  /** The Permit2 permissions batched tips rest on, with a way to revoke each. */
  permit2: Permit2PermissionsProps;
  onChange: (next: SpdexConfig) => void;
}) {
  return (
    <>
      <MyTipList config={config} onChange={onChange} />
      {expert ? (
        <div className="spdex-settings-block" data-testid="expert-tips">
          <p className="spdex-field__hint">
            Exact shares per person, up to {bpsText(MAX_TOTAL_TIP_BPS)} in all. The Tip row in Buy SPX splits one total
            evenly.
          </p>
          {config.tips.enabled ? (
            <TipEditor config={config} candidates={tipCandidates} onChange={onChange} />
          ) : (
            <p className="spdex-field__hint" data-testid="expert-tips-off">
              Tips are off. Pick a share in the Tip row in Buy SPX to turn them on
              {config.tips.recipients.length > 0
                ? ` — the ${config.tips.recipients.length === 1 ? "person" : `${config.tips.recipients.length} people`} you chose before ${config.tips.recipients.length === 1 ? "is" : "are"} kept.`
                : "."}
            </p>
          )}
        </div>
      ) : null}
      <Permit2Permissions {...permit2} />
    </>
  );
}

/** Share for someone added here: small, and under the ceiling. */
const DEFAULT_TIP_BPS = 25;

/**
 * Picking who to tip, and exactly how much each.
 *
 * Moved here from the Features dialog, where it was the only way to set a tip
 * at all; the Trade card's Tip row now does the common case (one total, split
 * evenly), and this is the precise one. It writes the same `config.tips`.
 *
 * The address is shown in full next to every name, and it is the address that
 * is written to the config. A registry maps a name to an address and is not
 * trusted to be honest about it — the same position the token list is in — so
 * the moment of choosing is the moment the user gets to look. The test ids of
 * the candidate list carry an `expert-` prefix so they never collide with the
 * Tip row's picker, which may be open on the same page.
 */
function TipEditor({
  config,
  candidates,
  onChange,
}: {
  config: SpdexConfig;
  candidates: readonly DiscoveredRecipient[] | null;
  onChange: (next: SpdexConfig) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const chosen = config.tips.recipients;

  const update = (recipients: TipRecipient[]) => {
    const next = recipients.reduce((sum, r) => sum + r.bps, 0);
    if (next > MAX_TOTAL_TIP_BPS) {
      // Refused rather than clamped. Silently reducing a number somebody typed
      // is how a UI ends up disagreeing with the config it just wrote.
      setError(`Tips cannot total more than ${bpsText(MAX_TOTAL_TIP_BPS)} of a swap.`);
      return;
    }
    // The schema a saved config is read back with, so nothing written here
    // can make the config unreadable on the next load.
    const parsed = TipPolicySchema.safeParse({ ...config.tips, recipients });
    if (!parsed.success) {
      setError(`Not applied: ${parsed.error.issues[0]?.message ?? "the tip list is not valid"}.`);
      return;
    }
    setError(null);
    onChange({ ...config, tips: parsed.data, preset: "custom" });
  };

  const isChosen = (address: string) =>
    chosen.some((r) => r.address.toLowerCase() === address.toLowerCase());

  const add = (candidate: DiscoveredRecipient) => {
    if (chosen.length >= MAX_TIP_RECIPIENTS) {
      setError(`At most ${MAX_TIP_RECIPIENTS} people.`);
      return;
    }
    update([
      ...chosen,
      {
        address: candidate.address.toLowerCase() as `0x${string}`,
        label: candidate.label,
        ...(candidate.handle === undefined ? {} : { handle: candidate.handle }),
        source: candidate.registryId,
        bps: DEFAULT_TIP_BPS,
      },
    ]);
  };

  const remove = (address: string) =>
    update(chosen.filter((r) => r.address.toLowerCase() !== address.toLowerCase()));

  const setBps = (address: string, bps: number) =>
    update(chosen.map((r) => (r.address === address ? { ...r, bps: Math.max(1, bps) } : r)));

  // A placeholder list is offered only on a local test network: its
  // addresses' keys are public (see `offeredCandidates`). A retired entry is
  // never offered, and one the person hid stays hidden here too. Their own
  // saved addresses follow, named "My tip list" in the config, less any
  // that can't be tipped here (a public test account off a test network, a
  // contract a tip is lost in, the connected account), as in the Tip row.
  const tips = useTips();
  const { offered, withheld } = offeredCandidates(candidates ?? [], config.chainId);
  const current = offered.filter(
    (candidate) => candidate.retired === undefined && (candidate.id === undefined || !tips.list.hiddenDefaults.includes(candidate.id)),
  );
  const offerable = (address: string) =>
    !(isPublicDevAccount(address) && !isPlaceholderChain(config.chainId)) &&
    knownContract(address) === null &&
    (tips.account === null || tips.account.toLowerCase() !== address.toLowerCase());
  const mine: DiscoveredRecipient[] = tips.list.mine
    .filter((entry) => offerable(entry.address))
    .filter((entry) => !current.some((candidate) => candidate.address.toLowerCase() === entry.address.toLowerCase()))
    .map((entry) => ({ address: entry.address, label: MY_TIP_LIST_LABEL, note: entry.name, registryId: MY_TIP_LIST_SOURCE }));
  const available = [...current, ...mine].filter((candidate) => !isChosen(candidate.address));
  // What is actually sent, as the Tip row says it: a skipped share isn't.
  const paying = payablePolicy(config.tips, tips.tippable).recipients;
  const skippedOf = (address: string) =>
    tips.tippable.skipped.find((skip) => skip.address.toLowerCase() === address.toLowerCase());
  const notTipped = chosen.filter((recipient) => skippedOf(recipient.address) !== undefined).length;

  return (
    <div className="spdex-tips" data-testid="tip-recipients">
      {error ? (
        <Banner tone="danger" title="Not applied" testId="tip-error">
          {error}
        </Banner>
      ) : null}

      <h4 className="spdex-tips__heading" data-testid="tip-summary">
        {chosen.length === 0
          ? "Nobody selected — nothing will be sent"
          : tips.defaults === null
            ? "Reading the tip list…"
            : paying.length === 0
              ? "Nothing is sent yet: nobody chosen can be tipped"
              : `Tipping ${bpsText(recipientsTotal(paying))} of each swap across ${paying.length === 1 ? "1 person" : `${paying.length} people`}${notTipped > 0 ? ` · ${notTipped} not tipped` : ""}`}
      </h4>

      {chosen.map((recipient) => {
        const view = describeRecipient(recipient.address, tips.list, tips.defaults, recipient);
        const skip = tips.defaults === null ? undefined : skippedOf(recipient.address);
        // As on the Tip row: a name only the loaded settings give is a quote.
        const name = view.fromSettings ? `“${view.name}”` : view.tag === "LISTED" || view.tag === "RETIRED" ? pillName({ label: view.name }) : view.name;
        return (
        <div className="spdex-tips__row" key={recipient.address} data-testid={`tip-${recipient.address}`}>
          <div className="spdex-tips__who">
            <div>
              {tips.defaults !== null ? <TipTagChip tag={view.tag} testId={`expert-tip-tag-${recipient.address}`} /> : null}{" "}
              {name}
              {view.handle ? <span className="spdex-pool__meta"> · {view.handle}</span> : null}
              {skip !== undefined ? (
                <span className="spdex-tippill__skip" data-testid={`expert-tip-skipped-${recipient.address}`}>
                  {" "}
                  <Term tip={`Not tipped: ${skip.reason}. Its share isn't sent, or given to anyone else.`}>
                    {skip.reason === NOT_CONFIRMED ? "needs a check" : "not tipped"}
                  </Term>
                </span>
              ) : null}
            </div>
            <GroupedHex value={checksumAddress(recipient.address)} />
          </div>
          <label className="spdex-tips__share">
            <input
              className="spdex-input spdex-num"
              type="number"
              min={1}
              max={MAX_TOTAL_TIP_BPS}
              data-testid={`tip-bps-${recipient.address}`}
              aria-label={`Share for ${view.name}, in basis points`}
              value={recipient.bps}
              onChange={(event) => setBps(recipient.address, Number(event.target.value) || 1)}
            />
            {/* The input stays in basis points (the unit the config holds);
                the percentage beside it is what a person reads. */}
            <span className="spdex-pool__meta">bps = {bpsText(recipient.bps)}</span>
          </label>
          <Button
            variant="ghost"
            testId={`expert-tip-remove-${recipient.address}`}
            onClick={() => remove(recipient.address)}
          >
            Remove
          </Button>
        </div>
        );
      })}

      {/* A div, not a Field: a Field is a <label>, and a label around a list
          of buttons would press the first one when any name is clicked. */}
      <div className="spdex-field">
        <span className="spdex-field__label">From the list</span>
        <div data-testid="expert-tip-candidates">
          {candidates === null ? <p className="spdex-field__hint">Loading the list…</p> : null}
          {candidates !== null && offered.length === 0 && withheld === 0 && mine.length === 0 ? (
            <p className="spdex-field__hint" data-testid="expert-tip-no-listed">
              {NO_LISTED_YET}
            </p>
          ) : null}
          {candidates !== null && offered.length === 0 && withheld > 0 ? (
            <p className="spdex-field__hint" data-testid="expert-tip-no-verified-list">
              {NO_VERIFIED_LIST}
            </p>
          ) : null}
          {available.length > 0 && listsPlaceholders(available) ? (
            <Banner tone="warn" title="Test addresses" testId="expert-tip-placeholder-notice">
              Entries named “Placeholder” are test addresses, not real people. spDEX saves the address you pick
              and checks every transfer against it.
            </Banner>
          ) : null}
          {available.map((candidate) => (
            <div
              className="spdex-tips__row"
              key={candidate.address.toLowerCase()}
              data-testid={`expert-candidate-${candidate.address.toLowerCase()}`}
            >
              <div className="spdex-tips__who">
                <div>
                  {cleanTipText(candidate.label)}
                  {candidate.handle ? <span className="spdex-pool__meta"> · {cleanTipText(candidate.handle)}</span> : null}
                </div>
                <GroupedHex value={checksumAddress(candidate.address)} />
                {candidate.note ? <div className="spdex-pool__meta">{cleanTipText(candidate.note)}</div> : null}
              </div>
              <Button
                variant="ghost"
                testId={`expert-tip-add-${candidate.address.toLowerCase()}`}
                onClick={() => add(candidate)}
              >
                Add
              </Button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
