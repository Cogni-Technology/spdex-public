/**
 * The Settings tile: everything that changes how spDEX works, in one place.
 *
 * Two rows are always shown, the view (Simple or Expert) and the features;
 * everything else is a section, one open at a time (`SettingsSection`, the
 * `settings` group), all closed to start with. The Expert view adds its own
 * sections after the shared ones. Sections keep the test ids their panels
 * had, so a place named in the copy (lib/places.tsx) still finds them.
 *
 * The network service is shown masked here too (lib/rpcDisplay.ts), with
 * SHOW, like the status widget.
 */

import { useEffect, useId, useState, type ReactNode } from "react";
import { Button, Row, SettingsSection, Term, Toggle } from "@spdex/ui";
import { FEATURE_CATALOG } from "@spdex/config";
import type { SpdexConfig } from "@spdex/core";
import { ConfigSection, type ConfigPanelProps } from "../ConfigIo.js";
import { ExpertSections, TipsSettings, type ExpertSectionsProps } from "../Expert.js";
import type { Permit2PermissionsProps } from "../Permit2Permissions.js";
import { CurrencySelect } from "../money/CurrencySelect.js";
import { NumberStyleSelect } from "../money/NumberStyleSelect.js";
import type { DiscoveredRecipient } from "../../lib/engine.js";
import { MISSING_CURRENCIES_HINT } from "../../lib/money/currency.js";
import { GLOSSARY } from "../../lib/names.js";
import type { View } from "../../lib/prefs.js";
import { maskRpcUrl, rpcUrlMasked } from "../../lib/rpcDisplay.js";
import { safetyTestText, type SafetyTest } from "../../lib/summary.js";

/** Where the service in use came from. "built-in" is this copy's own, set up by its publisher (lib/store.ts). */
const SOURCE_LABEL: Record<SpdexConfig["rpc"]["source"], string> = {
  bundled: "built-in",
  user: "your own",
  fallback: "public",
};

/** The features that are on, for the FEATURES row and the tile's summary. */
export function featuresOn(config: SpdexConfig): string[] {
  return FEATURE_CATALOG.filter((feature) => feature.isEnabled(config)).map((feature) => feature.name);
}

export interface SettingsTileProps extends ExpertSectionsProps {
  /** Whether the Settings tile is open: closing it hides the service's full address again. */
  open: boolean;
  mode: View;
  onMode: (mode: View) => void;
  onOpenFeatures: () => void;
  safety: SafetyTest;
  /** Forgets the network service: back to the first-run screen, which stays until the person picks one (never the built-in service by itself). */
  onChangeService: () => void;
  tipCandidates: readonly DiscoveredRecipient[] | null;
  permit2: Permit2PermissionsProps;
  onImport: ConfigPanelProps["onImport"];
  onReset: () => void;
  /** Check this build, and the ways out: the walkaway panel, told whether its section is open. */
  trust: (open: boolean) => ReactNode;
  /** Brings the Welcome steps back, once hidden; absent where there are none to show. */
  onGettingStarted?: () => void;
}

export function SettingsTile(props: SettingsTileProps) {
  const { config, open, mode, onMode, onOpenFeatures, safety, onChangeService, trust, onGettingStarted } = props;
  // SHOW reveals the full address until its section or the tile closes: a
  // closed tile is still in the DOM, and find-in-page searches it.
  const [showUrl, setShowUrl] = useState(false);
  useEffect(() => {
    if (!open) setShowUrl(false);
  }, [open]);
  // Masked again in the same render that closes the tile, not an effect later.
  const unmasked = showUrl && open;
  const viewLabelId = useId();
  const [trustOpen, setTrustOpen] = useState(false);
  const on = featuresOn(config);
  const url = config.rpc.url;
  const expert = mode === "expert";

  return (
    <div className="spdex-settings" data-testid="settings">
      <div className="spdex-settings__rows">
        <div className="spdex-settings__row">
          <span className="spdex-settings__label" id={viewLabelId}>
            View
          </span>
          <Toggle
            testId="mode-toggle"
            labelledBy={viewLabelId}
            value={mode}
            onChange={onMode}
            options={[
              { value: "recommended", label: "Simple" },
              { value: "expert", label: "Expert" },
            ]}
          />
        </div>
        <div className="spdex-settings__row">
          <span className="spdex-settings__label">Features</span>
          {/* Which ones, in a tip a keyboard and a touch reach too (a
              `title` reaches neither). */}
          <span className="spdex-settings__value" data-testid="features-summary">
            {on.length === 0 ? "nothing on — spDEX can't route" : <Term tip={`On: ${on.join(", ")}.`}>{`${on.length} on`}</Term>}
          </span>
          <Button variant="ghost" testId="open-features" onClick={onOpenFeatures}>
            Choose
          </Button>
        </div>
      </div>

      <SettingsSection testId="settings-money" summary="Currency and numbers">
        <Row label={<Term tip={MISSING_CURRENCIES_HINT}>Currency</Term>} value={<CurrencySelect />} />
        <Row label="Number style" value={<NumberStyleSelect />} />
      </SettingsSection>

      <SettingsSection
        testId="settings-network"
        summary="Network service"
        onToggle={(open) => {
          if (!open) setShowUrl(false);
        }}
      >
        <div data-testid="rpc-panel">
          <Row
            label={<Term tip={GLOSSARY.networkService}>In use</Term>}
            value={
              <>
                <span data-testid="settings-rpc-label">{url === null ? "none" : unmasked ? url : maskRpcUrl(url)}</span>
                {url !== null && rpcUrlMasked(url) ? (
                  <>
                    {" "}
                    <button
                      type="button"
                      className="spdex-inline-action"
                      data-testid="settings-rpc-show"
                      aria-pressed={unmasked}
                      onClick={() => setShowUrl((shown) => !shown)}
                    >
                      {unmasked ? "Hide" : "Show"}
                    </button>
                  </>
                ) : null}
              </>
            }
          />
          <Row label="Source" value={<span data-testid="settings-rpc-source">{SOURCE_LABEL[config.rpc.source]}</span>} />
          <p className="spdex-field__hint" data-testid="settings-rpc-privacy">
            {config.rpc.source === "bundled"
              ? "Set up by whoever published this copy. Like any service, it sees your IP address and what you look up and send."
              : "Whoever runs it sees your IP address and what you look up and send."}
          </p>
          <Row label="Safety test" value={safetyTestText(safety)} />
          <p className="spdex-field__hint">
            The status panel{" "}
            <Term tip="It reads the latest block when the page loads, when you change service, when the browser comes back online, once more 5 seconds after a failed read, and when you press ↻. It reads the finalized block only when you open its Details or press ↻.">
              never polls
            </Term>
            .
          </p>
          <Button variant="ghost" testId="change-rpc" onClick={onChangeService}>
            Change service
          </Button>
        </div>
      </SettingsSection>

      <SettingsSection testId="settings-tips" summary="Tips">
        <TipsSettings
          config={config}
          expert={expert}
          tipCandidates={props.tipCandidates}
          permit2={props.permit2}
          onChange={props.onChange}
        />
      </SettingsSection>

      <SettingsSection testId="settings-trust" summary="Check this build · exits" onToggle={setTrustOpen}>
        {trust(trustOpen)}
      </SettingsSection>

      {onGettingStarted !== undefined ? (
        <SettingsSection testId="settings-start" summary="Getting started">
          <Button variant="ghost" testId="strip-getting-started" onClick={onGettingStarted}>
            Show the welcome steps
          </Button>
        </SettingsSection>
      ) : null}

      {expert ? (
        <>
          <ExpertSections
            config={config}
            pools={props.pools}
            stats={props.stats}
            pricing={props.pricing}
            onChange={props.onChange}
          />
          <ConfigSection config={config} onImport={props.onImport} onReset={props.onReset} />
        </>
      ) : null}
    </div>
  );
}
