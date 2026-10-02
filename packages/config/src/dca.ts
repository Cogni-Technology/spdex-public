/**
 * Editing auto-buy plans.
 *
 * The functions the UI calls to add, change and remove a plan. They live here,
 * pure and beside the migrations, rather than in a component, because each one
 * edits a standing instruction to spend money and the rules for such an edit
 * should be written — and tested — once:
 *
 * - **Refuse, never clamp.** An edit the schema would reject is refused with a
 *   reason, and the config is left as it was. Clamping would make the UI
 *   disagree with what it wrote. Writing it anyway is worse: the app reads its
 *   saved config back through the schema on every load and replaces one that
 *   fails with the preset, endpoint and all, so one bad plan would silently
 *   throw away everything else the user had set.
 * - **What is written is what the schema returns.** Addresses come back
 *   lowercased and unknown fields dropped, so the config saved is exactly the
 *   config the next load reads, and a reload never shows a change nobody made.
 * - **Every edit marks the config custom**, as every other edit path does, so
 *   "difference from recommended" never under-reports.
 *
 * Nothing here makes an id, reads a clock or knows what a plan has bought. Ids
 * and start times come from the host, and each plan's progress is a fact about
 * this browser, kept outside the config (`DcaProgress` in @spdex/core).
 *
 * The error strings are a backstop, not the UI's copy. A form should say what
 * is wrong with a field in its own words before it ever gets here; what comes
 * back from a refusal is accurate, and plain where it can be.
 */

import {
  DcaPolicySchema,
  MAX_DCA_PLANS,
  type DcaPlan,
  type DcaPolicy,
  type SpdexConfig,
} from "@spdex/core";
import { DCA_FEATURE_ID, SCHEDULER_MODULE_ID, setFeature } from "./features.js";

export type DcaEdit = { ok: true; config: SpdexConfig } | { ok: false; error: string };

/**
 * A change to one plan.
 *
 * A field set to `undefined` is removed, which is how a label is cleared;
 * removing a field the schema requires is refused like any other invalid edit.
 * The id is not in the type because it cannot change — see `updateDcaPlan`.
 */
export type DcaPlanPatch = { [K in Exclude<keyof DcaPlan, "id">]?: DcaPlan[K] | undefined };

type Checked = { ok: true; dca: DcaPolicy } | { ok: false; error: string };

interface Issue {
  readonly path: readonly PropertyKey[];
  readonly message: string;
}

/**
 * Name the field a schema issue is about, relative to its plan.
 *
 * The policy's paths run `plans.<index>.<field>`. The index means nothing to
 * the person who pressed Save; the field name at least says where to look.
 */
function explain(issues: readonly Issue[]): string {
  const reasons = issues.map((issue) => {
    const field = issue.path.slice(2).map(String).join(".");
    return field ? `${field}: ${issue.message}` : issue.message;
  });
  return `This plan is not valid (${reasons.join("; ")}).`;
}

function check(dca: unknown): Checked {
  const parsed = DcaPolicySchema.safeParse(dca);
  return parsed.success
    ? { ok: true, dca: parsed.data }
    : { ok: false, error: explain(parsed.error.issues) };
}

/**
 * Drop keys whose value is `undefined`.
 *
 * The schema keeps an optional key that is present but undefined, and a config
 * holding `label: undefined` is not quite the config a reload reads back —
 * JSON and TOML both drop the key. Removing it is what "clear the label" means.
 */
function withoutUndefined(fields: object): Record<string, unknown> {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
}

/**
 * Whether plans in this config would actually be acted on: the master switch
 * on *and* the scheduler module enabled. A hand-edited config can have one
 * without the other, and then nothing runs.
 */
function autoBuyRunning(config: SpdexConfig): boolean {
  return (
    config.dca.enabled &&
    config.modules.some((module) => module.id === SCHEDULER_MODULE_ID && module.enabled)
  );
}

/**
 * Add a plan, switching auto-buy on if it is off.
 *
 * Adding a plan is asking for it to run, and a plan added while the feature is
 * off would sit there doing nothing with no hint why. So the feature is turned
 * on through `setFeature`, exactly as the toggle would.
 *
 * Turning it on as a side effect must not start anything else, though. The
 * master switch is how a user stops every plan at once, and the plans it
 * stopped are kept; if adding one plan switched it back on, every plan it had
 * stopped would quietly start spending again. So when this call is what turns
 * auto-buy on, every other plan is paused first, and each has to be resumed by
 * hand. When auto-buy is already running, nothing but the new plan changes.
 *
 * A vault plan is added the same way, switch and all, though neither the
 * switch nor its own `paused` (always true) governs it: its vault runs on
 * chain. It usually arrives without a `vault`, which is recorded with
 * `updateDcaPlan` once the vault exists; since that can be done only once,
 * record the address the creation actually made, not one hoped for.
 */
export function addDcaPlan(config: SpdexConfig, plan: DcaPlan): DcaEdit {
  if (config.dca.plans.some((existing) => existing.id === plan.id)) {
    return { ok: false, error: `There is already a plan with the id "${plan.id}".` };
  }
  if (config.dca.plans.length >= MAX_DCA_PLANS) {
    return { ok: false, error: `At most ${MAX_DCA_PLANS} auto-buy plans can be set up at once.` };
  }

  const switchingOn = !autoBuyRunning(config);
  const others = switchingOn
    ? config.dca.plans.map((existing) => ({ ...existing, paused: true }))
    : config.dca.plans;

  const checked = check({ ...config.dca, plans: [...others, withoutUndefined(plan)] });
  if (!checked.ok) return checked;

  const next: SpdexConfig = { ...config, dca: checked.dca };
  return {
    ok: true,
    config: switchingOn ? setFeature(next, DCA_FEATURE_ID, true) : { ...next, preset: "custom" },
  };
}

/**
 * Change one plan: pause or resume it, rename it, or alter its terms.
 *
 * Resuming does not switch auto-buy on. That is the master switch, and
 * flipping it as a side effect would restart every other plan it had stopped;
 * a plan resumed while auto-buy is off waits for it.
 *
 * The id cannot change, and a patch that tries is refused rather than
 * ignored: it keys this browser's record of what the plan has bought, and
 * changing it would turn one plan into a new one with its whole budget unspent.
 *
 * That record is kept in the plan's own terms, and nothing here can see it.
 * The Guard judges every buy against the plan as it now reads, so no edit can
 * make a plan spend past its budget — but some edits leave the record
 * describing a different plan. A new `sell` token would count what was already
 * committed in the old token's units; a new `chainId` or `signer` would no
 * longer match the record, and every buy would be refused; a new `startAt` or
 * `intervalSeconds` renumbers the windows the record's last buy was counted
 * in. The UI should offer those as "replace this plan", under a new id, not as
 * an edit.
 *
 * A vault plan is stricter still, and refused rather than left to the UI,
 * because its terms live in a contract nothing can edit: see
 * `vaultEditRefusal`. Once its vault exists, only its label can change.
 */
export function updateDcaPlan(config: SpdexConfig, id: string, patch: DcaPlanPatch): DcaEdit {
  const current = config.dca.plans.find((plan) => plan.id === id);
  if (!current) return { ok: false, error: `There is no plan with the id "${id}".` };
  if (Object.hasOwn(patch, "id") && (patch as { id?: unknown }).id !== id) {
    return { ok: false, error: "A plan's id cannot be changed." };
  }
  const refusal = vaultEditRefusal(current, patch);
  if (refusal !== null) return { ok: false, error: refusal };

  const updated = withoutUndefined({ ...current, ...patch });
  const checked = check({
    ...config.dca,
    plans: config.dca.plans.map((plan) => (plan.id === id ? updated : plan)),
  });
  if (!checked.ok) return checked;
  return { ok: true, config: { ...config, dca: checked.dca, preset: "custom" } };
}

/** The fields a vault holds on chain: once it exists, the plan's copy of them is fixed. */
const VAULT_TERMS = ["chainId", "sell", "buy", "amountPerBuy", "intervalSeconds", "maxBuys", "startAt"] as const;

/** Equal as a plan compares them: addresses whatever their case, everything else exactly. */
function sameValue(a: unknown, b: unknown): boolean {
  return typeof a === "string" && typeof b === "string" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/**
 * Why an edit that involves a vault plan is refused, or null if the rules
 * below have nothing against it (the schema still judges it after).
 *
 * A vault plan's config entry is a pointer to a contract, and the rules follow
 * from what the contract can and cannot do:
 *
 * - **No pause, no resume.** The plan is always paused here (see `paused` in
 *   @spdex/core) because this tab never runs it; resuming it would claim a
 *   runner there is none of, and pausing it would not stop its vault. Setting
 *   it paused again is a no-op and is allowed, so "pause everything" paths do
 *   not trip over it.
 * - **Its vault is written once.** Absent until the vault is created, then
 *   fixed: the address is where the plan's money is and how this browser finds
 *   it again, so replacing it would point the plan at a different contract
 *   and clearing it would lose the way back.
 * - **Its terms are fixed once the vault exists**, because the vault's are.
 *   An edit would only make the config disagree with the chain. Until then
 *   they are ordinary settings.
 * - **It cannot become another kind of plan, or another plan one.** A wallet
 *   plan keeps its record under its id; a vault plan keeps a contract. Neither
 *   carries over to the other, so the change is a new plan, not an edit.
 */
function vaultEditRefusal(current: DcaPlan, patch: DcaPlanPatch): string | null {
  const signerChanges = Object.hasOwn(patch, "signer") && patch.signer !== current.signer;
  if (signerChanges && (current.signer === "vault" || patch.signer === "vault")) {
    return "A plan cannot be switched to or from a vault plan. Set up a new plan instead.";
  }
  if (current.signer !== "vault") return null;

  if (Object.hasOwn(patch, "paused") && patch.paused !== true) {
    return (
      "A vault plan cannot be paused or resumed. Its vault makes each buy whenever anyone triggers a " +
      "due one, whether or not spDEX is open; the only way to stop it is to close the vault and withdraw."
    );
  }
  if (current.vault !== undefined) {
    if (Object.hasOwn(patch, "vault") && !sameValue(patch.vault, current.vault)) {
      return "A plan's vault cannot be changed or removed once it has been created: it is where the plan's money is.";
    }
    const changed = VAULT_TERMS.filter((field) => Object.hasOwn(patch, field) && !sameValue(patch[field], current[field]));
    if (changed.length > 0) {
      return (
        `This plan's terms are fixed in its vault on chain (${changed.join(", ")}). ` +
        "Close the vault and set up a new plan to change them."
      );
    }
  }
  return null;
}

/**
 * Remove one plan. Auto-buy stays as it was, as it does when the tip list
 * empties.
 *
 * This edits the config and nothing else. Whatever this browser keeps for the
 * plan — its record of what was bought — is the host's to deal with.
 *
 * A vault plan is allowed to go too, and removing it touches the vault not at
 * all: the vault keeps its funds and goes on buying whenever triggered. The
 * host should close the owner's vault first, or at least say that it has not;
 * a vault that belongs to someone else — a plan from their link — is theirs,
 * and removing it only forgets it. After that the way back to a vault is the
 * factory's `VaultCreated` logs, which name each vault's owner: the app
 * searches them for the connected wallet's vaults, but only as far back as its
 * network service allows. So it keeps vault plans through a wholesale
 * replacement of the config, and warns before one is deleted.
 */
export function removeDcaPlan(config: SpdexConfig, id: string): DcaEdit {
  if (!config.dca.plans.some((plan) => plan.id === id)) {
    return { ok: false, error: `There is no plan with the id "${id}".` };
  }
  const checked = check({
    ...config.dca,
    plans: config.dca.plans.filter((plan) => plan.id !== id),
  });
  if (!checked.ok) return checked;
  return { ok: true, config: { ...config, dca: checked.dca, preset: "custom" } };
}
