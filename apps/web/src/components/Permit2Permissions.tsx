/**
 * Settings → Tips: which tokens Permit2 may move for this wallet, and Revoke.
 *
 * Tips to two or more people go out in one transaction through Permit2, and
 * the first one asks for a standing permission on the token (`approve(PERMIT2,
 * max)`). That is the one permission spDEX asks for without a limit, so it is
 * listed where it can be seen and taken back, token by token, whether or not
 * tips are on now.
 *
 * Every figure is read from the chain when the panel opens and after each
 * revoke. A figure that can't be read says so; it is never shown as "none",
 * which would tell someone holding a live permission that there is nothing
 * to revoke.
 *
 * Revoking goes through the Guard as a plan of its own (`approve(PERMIT2, 0)`
 * and nothing else), like every other transaction spDEX asks a wallet for.
 *
 * The words say what the permission does and does not stop, because the
 * earlier ones promised more: Permit2 also moves a token on an allowance
 * held inside Permit2 (set by a transaction, with no signature), spDEX sees
 * only the signatures it asks for, and Revoke does not clear those inner
 * allowances; it makes them useless until the permission is given again.
 */

import { useCallback, useEffect, useState } from "react";
import { Button, Disclosure } from "@spdex/ui";
import { MAX_UINT256 } from "@spdex/core";
import { formatAmount, type TokenInfo } from "../lib/tokens.js";

type Reading = { state: "reading" } | { state: "read"; allowance: bigint } | { state: "unknown" };

export interface Permit2PermissionsProps {
  /** The connected wallet, or null. */
  account: `0x${string}` | null;
  /** The ERC-20s a tip can be sent in. */
  tokens: readonly TokenInfo[];
  /** Permit2's allowance from the account on a token; throws when it can't be read. */
  readAllowance: (token: TokenInfo) => Promise<bigint>;
  /**
   * Revoke through the Guard and the wallet; resolves to the sentence to show.
   * `onSent` is called once the wallet has sent it, while it waits to land.
   */
  revoke: (token: TokenInfo, onSent?: () => void) => Promise<string>;
}

/** "unlimited" for the conventional maximum (or anything near it), else the amount. */
function allowanceText(allowance: bigint, token: TokenInfo): string {
  if (allowance === 0n) return "none";
  if (allowance >= MAX_UINT256 / 2n) return "unlimited";
  return `up to ${formatAmount(allowance, token.decimals)} ${token.symbol}`;
}

export function Permit2Permissions({ account, tokens, readAllowance, revoke }: Permit2PermissionsProps) {
  const [readings, setReadings] = useState<Record<string, Reading>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const readAll = useCallback(() => {
    if (!account) return () => {};
    let cancelled = false;
    setReadings(Object.fromEntries(tokens.map((token) => [token.symbol, { state: "reading" } as Reading])));
    for (const token of tokens) {
      readAllowance(token)
        .then((allowance): Reading => ({ state: "read", allowance }))
        .catch((): Reading => ({ state: "unknown" }))
        .then((reading) => {
          if (!cancelled) setReadings((was) => ({ ...was, [token.symbol]: reading }));
        });
    }
    return () => {
      cancelled = true;
    };
  }, [account, tokens, readAllowance]);

  useEffect(() => readAll(), [readAll]);

  const onRevoke = async (token: TokenInfo) => {
    setBusy(token.symbol);
    setSent(false);
    setNote(null);
    try {
      setNote(await revoke(token, () => setSent(true)));
    } finally {
      setBusy(null);
      setSent(false);
      readAll();
    }
  };

  return (
    <div className="spdex-field spdex-permit2" data-testid="permit2-permissions">
      <span className="spdex-field__label">Permit2 permission</span>
      <p className="spdex-field__hint">
        Tips to 2+ people use Permit2, which needs a one-time token permission. It&apos;s unlimited until you revoke it
        here.
      </p>
      <Disclosure summary="Why?" testId="permit2-why">
        <p className="spdex-field__hint">
          Permit2 is Uniswap&apos;s contract for signed transfers: tips to two or more people go out through it in one
          transaction. It moves the token only on a signature or a Permit2 approval you give. spDEX checks the ones it
          asks for; one another site asks for can move that token too.
        </p>
        <p className="spdex-field__hint">
          Revoking is a transaction, with a network fee, and the next tip to two or more people asks again. It stops
          Permit2 moving that token for any app. It doesn&apos;t erase approvals other apps set up inside Permit2: those
          work again if you give the permission again.
        </p>
      </Disclosure>
      {account === null ? (
        <p className="spdex-field__hint" data-testid="permit2-connect">
          Connect a wallet to see which tokens Permit2 may move for you.
        </p>
      ) : (
        tokens.map((token) => {
          const reading = readings[token.symbol] ?? { state: "reading" };
          return (
            <div className="spdex-tips__row" key={token.symbol} data-testid={`permit2-permission-${token.symbol}`}>
              <div className="spdex-tips__who">
                <div>{token.symbol}</div>
                <div className="spdex-pool__meta" data-testid={`permit2-allowance-${token.symbol}`}>
                  {reading.state === "reading"
                    ? "Reading…"
                    : reading.state === "unknown"
                      ? "Couldn't read it"
                      : allowanceText(reading.allowance, token)}
                </div>
              </div>
              {/* Also when the figure couldn't be read: taking a permission
                  away can lose nothing, so not knowing is no reason to hide it. */}
              {(reading.state === "read" && reading.allowance > 0n) || reading.state === "unknown" ? (
                <Button
                  variant="ghost"
                  testId={`permit2-revoke-${token.symbol}`}
                  disabled={busy !== null}
                  onClick={() => void onRevoke(token)}
                >
                  {/* Named for what is happening: the wallet is asking. "Revoking…" read
                      as if spDEX were doing it, as "Approving…" did (steps.ts). */}
                  {busy === token.symbol ? (sent ? "Waiting for the network…" : "Confirm in your wallet…") : "Revoke"}
                </Button>
              ) : null}
            </div>
          );
        })
      )}
      {note ? (
        <p className="spdex-field__hint" role="status" data-testid="permit2-note">
          {note}
        </p>
      ) : null}
    </div>
  );
}
