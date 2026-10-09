/**
 * The features modal.
 *
 * ## Why a modal, and why it is the *recommended* surface
 *
 * Expert mode exposes the config directly and always will. But "which modules
 * am I running" is a question a new user genuinely has an opinion about once it
 * is phrased as capabilities with costs, and burying it under a mode switch
 * they have no reason to flip means the answer is always whatever we shipped.
 *
 * The modal is therefore the recommended-mode surface for the same state the
 * expert editor shows, and every toggle writes the identical config object. A
 * feature that could not be expressed as config would be a second source of
 * truth, and there is deliberately no such feature.
 *
 * ## Each entry states its cost
 *
 * A toggle list where everything sounds good is a toggle list people turn all
 * the way on. Every feature here says what it costs — gas, latency, wallet
 * compatibility — and the two that are host settings rather than modules say
 * so, because the claim "every feature is a module" is not yet true and a UI
 * implying otherwise would be the same overstatement this repo keeps finding
 * in its own documentation.
 */

import { useRef } from "react";
import { useModal } from "./useModal.js";
import { Button, Disclosure, Term } from "@spdex/ui";
import { DCA_FEATURE_ID, FEATURE_CATALOG, TIP_FEATURE_ID, setFeature, type Feature } from "@spdex/config";
import type { SpdexConfig } from "@spdex/core";
import { GLOSSARY } from "../lib/names.js";
import { PLACES } from "../lib/places.js";

export function FeaturesModal({
  config,
  onChange,
  onClose,
  onGoToRecurring,
  onGoToTip,
  mode = "recommended",
}: {
  config: SpdexConfig;
  onChange: (next: SpdexConfig) => void;
  onClose: () => void;
  /** Closes the dialog and opens the Trade card's Recurring tab. */
  onGoToRecurring?: () => void;
  /** Closes the dialog and brings the One-time tab's Tip row into view. */
  onGoToTip?: () => void;
  /** Expert adds a line on what a feature is made of. */
  mode?: "recommended" | "expert";
}) {
  const dialogRef = useRef<HTMLDivElement>(null);

  // Escape closes, focus moves into the dialog and stays there, and returns
  // to what opened it (`useModal`): no focus-trap library, in a bundle meant
  // to be read by hand.
  useModal(dialogRef, onClose);

  const toggle = (feature: Feature, enabled: boolean) =>
    onChange(setFeature(config, feature.id, enabled));

  return (
    <div
      className="spdex-modal__backdrop"
      data-testid="features-modal"
      // Clicking the backdrop closes; clicking the dialog must not bubble to it.
      onClick={onClose}
    >
      <div
        className="spdex-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Features"
        tabIndex={-1}
        ref={dialogRef}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="spdex-modal__head">
          <h2 className="spdex-modal__title">Features</h2>
          <button
            type="button"
            className="spdex-modal__close"
            data-testid="close-features"
            aria-label="Close"
            onClick={onClose}
          >
            ×
          </button>
        </div>

        <div className="spdex-modal__body">
          <p className="spdex-modal__lede">
            Recommended ones are on. Change them any time in Settings.
            {mode === "expert" ? (
              <>
                {" "}
                Most are a <Term tip={GLOSSARY.plugIn}>plug-in</Term> spDEX loads, named on the right; the
                rest are settings of spDEX itself.
              </>
            ) : null}
          </p>

          {/* Grouped by the catalogue's own flag rather than by position, so
              the heading stays true whatever a user has switched since. */}
          {[
            { heading: "Recommended", features: FEATURE_CATALOG.filter((f) => f.recommended) },
            { heading: "Optional", features: FEATURE_CATALOG.filter((f) => !f.recommended) },
          ].map((group) => (
            <section key={group.heading} className="spdex-feature-group">
              <h3 className="spdex-feature-group__title">{group.heading}</h3>
              {group.features.map((feature) => (
                <FeatureCard
                  key={feature.id}
                  feature={feature}
                  config={config}
                  mode={mode}
                  onToggle={(enabled) => toggle(feature, enabled)}
                  {...(onGoToRecurring === undefined ? {} : { onGoToRecurring })}
                  {...(onGoToTip === undefined ? {} : { onGoToTip })}
                />
              ))}
            </section>
          ))}
        </div>

        <footer className="spdex-modal__foot">
          <Button testId="features-done" onClick={onClose}>
            Done
          </Button>
        </footer>
      </div>
    </div>
  );
}

/**
 * One feature: its switch, name, tagline and badge in view, the detail and the
 * cost one click away.
 *
 * The detail moved into a disclosure because seven paragraphs of it made the
 * dialog a wall nobody read. It stays in the DOM while closed (the Disclosure
 * always renders its body), so the badge and the text the tests read are
 * where they were.
 *
 * Tip splits used to open an editor here. It moved to where tips happen — a
 * Tip row by the swap, and exact shares in Settings → Tips — because a standing
 * instruction to send money to someone should be in view on every swap, not
 * in a dialog people close and forget. What is left is the switch and a
 * pointer to it.
 */
function FeatureCard({
  feature,
  config,
  mode,
  onToggle,
  onGoToRecurring,
  onGoToTip,
}: {
  feature: Feature;
  config: SpdexConfig;
  mode: "recommended" | "expert";
  onToggle: (enabled: boolean) => void;
  onGoToRecurring?: () => void;
  onGoToTip?: () => void;
}) {
  const enabled = feature.isEnabled(config);
  return (
    <div
      className={`spdex-feature${enabled ? " spdex-feature--on" : ""}`}
      data-testid={`feature-${feature.id}`}
    >
      <label className="spdex-feature__head">
        <input
          type="checkbox"
          checked={enabled}
          data-testid={`feature-toggle-${feature.id}`}
          onChange={(event) => onToggle(event.target.checked)}
        />
        <span className="spdex-feature__name">{feature.name}</span>
        {/* Which module each is, or that it is a host setting: Expert's
            vocabulary, where the config names them the same way. */}
        {mode === "expert" ? (
          <span className="spdex-feature__badge" data-testid={`feature-badge-${feature.id}`}>
            {feature.modules.length > 0 ? feature.modules.join(", ") : "host setting"}
          </span>
        ) : null}
      </label>
      <p className="spdex-feature__tagline">{feature.tagline}</p>

      <Disclosure testId={`feature-details-${feature.id}`} summary="Details" group="features-details">
        <p className="spdex-feature__detail">{feature.detail}</p>
        {feature.cost ? (
          <p className="spdex-feature__cost">
            <strong>Cost:</strong> {feature.cost}
          </p>
        ) : null}
      </Disclosure>

      {feature.id === DCA_FEATURE_ID && enabled && onGoToRecurring ? (
        <div className="spdex-feature__goto">
          <span className="spdex-field__hint">Set up plans in Buy SPX → Recurring.</span>
          <Button variant="ghost" testId="feature-dca-goto" onClick={onGoToRecurring}>
            Go to Recurring
          </Button>
        </div>
      ) : null}

      {feature.id === TIP_FEATURE_ID ? (
        <div className="spdex-feature__goto" data-testid="feature-tip-pointer">
          <span className="spdex-field__hint">
            Pick who and how much on the Tip row when you swap
            {mode === "expert" ? `; exact shares are in ${PLACES.tips.label}` : ""}.
          </span>
          {onGoToTip ? (
            <Button variant="ghost" testId="feature-tip-goto" onClick={onGoToTip}>
              Go to Tip
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
