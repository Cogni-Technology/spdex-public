/**
 * Import, export, and the diff between them.
 *
 * "Your configuration is a file you own" only means something if you can get
 * the file out, read it, and put it back. The diff is what makes an imported
 * config from a stranger reviewable rather than a leap of faith — you see
 * exactly which lines depart from the shipped preset before anything is
 * applied.
 */

import { useState } from "react";
import { Banner, Brand, Button, Disclosure, Panel, SettingsSection } from "@spdex/ui";
import {
  diffConfig,
  diffFromPreset,
  exportToml,
  importConfig,
  recommendedConfig,
  shareFragment,
} from "@spdex/config";
import type { SpdexConfig } from "@spdex/core";
import { stagedSummary } from "../lib/summary.js";
import { OLDER_SAVE_TEXT, forSharing, olderSaveOnLoad, settleOlderSave } from "../lib/store.js";
import { rpcUrlMasked } from "../lib/rpcDisplay.js";
import { useArmed } from "../lib/tiles.js";
import { StagedTipRecipients } from "./tips/StagedTipRecipients.js";

export function ConfigDiff({ config, testId = "config-diff" }: { config: SpdexConfig; testId?: string }) {
  const changes = diffFromPreset(recommendedConfig(), config);

  if (changes.length === 0) {
    return (
      <p className="spdex-field__hint" data-testid={`${testId}-none`}>
        Identical to the recommended preset.
      </p>
    );
  }

  return (
    <div className="spdex-diff" data-testid={testId}>
      {changes.map((change) => (
        <div key={change.path} data-testid={`diff-${change.path}`}>
          <span className="spdex-diff__path">{change.path}</span>{" "}
          <span className="spdex-diff__from">{JSON.stringify(change.from) ?? "unset"}</span>{" "}
          <span className="spdex-diff__to">→ {JSON.stringify(change.to) ?? "unset"}</span>
        </div>
      ))}
    </div>
  );
}

/**
 * The settings file as a section of the Settings tile (Expert view): export,
 * edit, share, import, and the difference from the recommended preset.
 */
export function ConfigSection(props: ConfigPanelProps) {
  return (
    <SettingsSection testId="config-panel" summary="Settings file">
      <ConfigBody {...props} />
    </SettingsSection>
  );
}

export interface ConfigPanelProps {
  config: SpdexConfig;
  /**
   * Applies an imported config. Resolves false when it was not applied — the
   * person declined to remove their auto-buys — so the panel doesn't claim
   * "Imported." for something that didn't happen.
   */
  onImport: (next: SpdexConfig) => Promise<boolean> | boolean;
  onReset: () => void;
}

function ConfigBody({ config, onImport, onReset }: ConfigPanelProps) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // What leaves this browser: the built-in service goes without its address
  // (its key is this copy's publisher's), and the recipient's own copy
  // supplies its own (lib/store.ts `forSharing`).
  const outgoing = forSharing(config);

  const doExport = () => {
    setText(exportToml(outgoing));
    setError(null);
    setNotice("Exported. Copy this, or save it as spdex.toml.");
  };

  const doImport = async () => {
    let next: SpdexConfig;
    try {
      next = importConfig(text);
    } catch (importError) {
      setNotice(null);
      setError(importError instanceof Error ? importError.message : String(importError));
      return;
    }
    setError(null);
    const applied = await onImport(next);
    setNotice(applied ? "Imported." : "Not imported. Your settings are unchanged.");
  };

  const doShareLink = async () => {
    const link = `${window.location.origin}${window.location.pathname}#config=${shareFragment(outgoing)}`;
    setText(link);
    setError(null);
    // Fragments are never sent to the server, so sharing a config this way does
    // not hand it to whoever is hosting the page.
    const privacy = "The settings travel in the URL fragment, which is never sent to a server.";
    // The button says "Copy", so it copies; the link also stays in the box
    // below, which is where it is when the browser won't allow copying.
    let copied = false;
    try {
      await globalThis.navigator?.clipboard?.writeText(link);
      copied = globalThis.navigator?.clipboard !== undefined;
    } catch {
      copied = false;
    }
    setNotice(copied ? `Share link copied. ${privacy}` : `Share link ready below — copy it from the box. ${privacy}`);
  };

  // The file and the share link carry the network service's address exactly
  // as typed, and a hosted service's address usually has its API key in it:
  // the one thing masked everywhere else on screen.
  const carriesKey = outgoing.rpc.url !== null && rpcUrlMasked(outgoing.rpc.url);
  return (
    <>
      <p className="spdex-field__hint" data-testid="config-contents">
        Your whole setup, auto-buys included — never a wallet key, or what was bought.
        {carriesKey ? (
          <>
            {" "}
            <strong>It includes your network service&apos;s full address, and any API key in it:</strong> share it
            only with people you&apos;d give that key to.
          </>
        ) : null}
      </p>
      {/* The shared button row, so on a phone the four fill their lines
          instead of wrapping ragged, and on a tablet too (`--fill`), where
          they no longer fit one line. */}
      <div className="spdex-actions spdex-actions--fill" style={{ marginTop: 8, marginBottom: 12 }}>
        <Button variant="ghost" onClick={doExport} testId="export-toml">
          Export TOML
        </Button>
        <Button variant="ghost" onClick={() => void doShareLink()} testId="export-link">
          Copy share link
        </Button>
        <Button variant="ghost" onClick={() => void doImport()} testId="import-config">
          Import
        </Button>
        <Button variant="ghost" onClick={onReset} testId="reset-config">
          Reset to recommended
        </Button>
      </div>

      {error ? (
        <Banner tone="danger" title="Could not import" testId="config-error">
          {error}
        </Banner>
      ) : null}
      {notice && !error ? (
        <p className="spdex-field__hint" data-testid="config-notice">
          {notice}
        </p>
      ) : null}

      <textarea
        className="spdex-code"
        data-testid="config-text"
        rows={12}
        spellCheck={false}
        value={text}
        onChange={(event) => setText(event.target.value)}
        placeholder="Paste a config here to import it, or export yours above."
      />

      <h3 className="spdex-panel__title" style={{ marginTop: 18 }}>
        Difference from recommended
      </h3>
      <ConfigDiff config={config} />
    </>
  );
}

/**
 * A config offered by a URL, shown for review before anything is applied.
 *
 * A link that silently reconfigured someone's DEX would be an attack. Seeing
 * the diff first is the difference between a shared preset and a hostile one.
 */
export function StagedConfigPrompt({
  staged,
  current,
  onAccept,
  onDismiss,
  interactive = true,
}: {
  staged: SpdexConfig;
  current: SpdexConfig;
  onAccept: () => void;
  onDismiss: () => void;
  /**
   * False while the page is inert (behind the disclaimer). Apply counts only
   * once the page has taken input for a moment, so the second half of a
   * double click that dismissed the disclaimer can't press it (UI rule R2,
   * docs/ARCHITECTURE.md).
   */
  interactive?: boolean;
}) {
  const armed = useArmed(interactive);
  // Against the *current* config, not the preset: the question is "what would
  // accepting this change for me", and the endpoint is included precisely
  // because it is what a hostile config would rewrite.
  const changes = diffConfig(current, staged);
  const summary = stagedSummary(current, staged);
  return (
    <Panel title="Settings shared with you" testId="staged-config">
      <Banner tone="warn" title="Review before applying">
        This link carries settings. Nothing has changed yet. Check what it would change before
        applying it, especially the network service, markets, tips and auto-buys.
      </Banner>
      {/* The money-moving changes in plain words, first; the exact diff under
          them stays open by default, because this is a security surface and
          the summary is a translation of it, not a replacement. */}
      {summary.length > 0 ? (
        <ul className="spdex-staged-summary" data-testid="staged-summary">
          {summary.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      ) : null}
      {/* Who the link would tip, each address in full with its lookalike
          check, before anything is applied: a settings link is exactly how a
          poisoned address would arrive. */}
      <StagedTipRecipients staged={staged.tips.recipients} current={current.tips.recipients} />
      <Disclosure summary={`Every change (${changes.length})`} open>
        {changes.length === 0 ? (
          <p className="spdex-field__hint" data-testid="staged-diff-none">
            These settings are identical to the ones you are already using.
          </p>
        ) : (
          <div className="spdex-diff" data-testid="staged-diff">
            {changes.map((change) => (
              <div key={change.path} data-testid={`staged-diff-${change.path}`}>
                <span className="spdex-diff__path">{change.path}</span>{" "}
                <span className="spdex-diff__from">{JSON.stringify(change.from) ?? "unset"}</span>{" "}
                <span className="spdex-diff__to">→ {JSON.stringify(change.to) ?? "unset"}</span>
              </div>
            ))}
          </div>
        )}
      </Disclosure>
      {/* The shared button row: it wraps, and on a phone each button takes a
          line rather than both breaking their labels in two side by side. */}
      <div className="spdex-actions">
        <Button onClick={onAccept} testId="accept-staged" ariaDisabled={!armed}>
          Apply these settings
        </Button>
        <Button variant="ghost" onClick={onDismiss} testId="dismiss-staged">
          Keep mine
        </Button>
      </div>
    </Panel>
  );
}

/**
 * An older spDEX saved settings here since this version last did, with no
 * newer tab open to put them back (`olderSaveOnLoad`): offered, never decided
 * for the person, since the older one may hold edits they meant. Restoring
 * applies the copy this version kept; keeping saves what loaded.
 */
export function OlderSavePrompt({
  onRestore,
  onKeep,
  interactive = true,
}: {
  onRestore(kept: SpdexConfig): void;
  onKeep(): void;
  /** As on `StagedConfigPrompt`: Restore counts once the page has taken input for a moment. */
  interactive?: boolean;
}) {
  const [older, setOlder] = useState(() => olderSaveOnLoad());
  const armed = useArmed(interactive);
  if (older === null) return null;
  const answer = (restore: boolean) => {
    settleOlderSave();
    setOlder(null);
    if (restore) onRestore(older.kept);
    else onKeep();
  };
  return (
    <Banner tone="warn" title={<>An older <Brand /> saved settings here</>} testId="older-save">
      {OLDER_SAVE_TEXT}
      <div className="spdex-actions">
        <Button testId="older-save-restore" onClick={() => answer(true)} ariaDisabled={!armed}>
          Restore my settings
        </Button>
        <Button variant="ghost" testId="older-save-keep" onClick={() => answer(false)}>
          Keep these
        </Button>
      </div>
    </Banner>
  );
}
