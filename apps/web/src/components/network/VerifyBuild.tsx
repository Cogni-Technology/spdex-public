/**
 * Verify this build: where this page came from, and how to check a release
 * without trusting whoever served it.
 *
 * It never says "verified". A changed copy of this page could print anything
 * here, so the page only says where it was loaded from and hands over the
 * commands that rebuild a release from its source and print its CID. The
 * source's address comes from the build setting (`sourceUrl()`), and when
 * that isn't set the panel says so rather than showing a stand-in.
 */

import { sourceUrl } from "../../lib/links.js";
import {
  MATCH_PROVES,
  NO_SOURCE_TEXT,
  buildOrigin,
  originSentence,
  sharedGatewayNote,
  verifyCommands,
} from "../../lib/network/walkaway.js";
import { Disclosure } from "@spdex/ui";
import { CopyButton } from "../dca/common.js";
import "./network.css";

export function VerifyBuild({
  where = globalThis.location,
  source = sourceUrl(),
}: {
  /** Where the page was loaded from; the address bar's, by default. */
  where?: { origin?: string; host?: string; pathname?: string } | null;
  /** Where the source is published; the build setting, by default. */
  source?: string | null;
}) {
  const origin = buildOrigin(where);
  const shared = sharedGatewayNote(origin);
  const commands = source === null ? null : verifyCommands(source);
  return (
    <div className="spdex-network-verify" data-testid="verify-build">
      <p className="spdex-network-line" data-testid="verify-build-origin">
        {originSentence(origin, commands !== null)}
      </p>
      {commands !== null ? (
        <>
          <pre className="spdex-network-commands" data-testid="verify-build-commands">
            {commands.join("\n")}
          </pre>
          <div className="spdex-network-copyrow">
            <CopyButton text={commands.join("\n")} label="Copy commands" testId="verify-build-copy" />
          </div>
          <Disclosure summary="What a match proves" testId="verify-build-proves">
            <p className="spdex-field__hint">{MATCH_PROVES}</p>
          </Disclosure>
        </>
      ) : (
        <p className="spdex-network-line spdex-network-line--quiet" data-testid="verify-build-no-source">
          {NO_SOURCE_TEXT}
        </p>
      )}
      {shared !== null ? (
        <p className="spdex-network-warn" data-testid="verify-build-shared-gateway">
          {shared}
        </p>
      ) : null}
    </div>
  );
}
