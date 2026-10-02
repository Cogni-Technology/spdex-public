/**
 * Where the stickers go: the two rails beside the column, on wide screens
 * only (theme.css, "Art"). Each rail's stickers are listed in the order they
 * stack down it; the stylesheet places each and hides any the rail is too
 * short to hold whole.
 */

import { KeysTag } from "./KeysTag.js";
import { NoChartSticker } from "./NoChartSticker.js";
import { PersistReceipt } from "./PersistReceipt.js";
import { SloganStamp } from "./SloganStamp.js";
import { ZeroServersTape } from "./ZeroServersTape.js";

export function Stickers({ side }: { side: "left" | "right" }) {
  return (
    <div className={`spdex-stickers spdex-stickers--${side}`} aria-hidden="true">
      {side === "left" ? (
        <>
          <NoChartSticker />
          <ZeroServersTape />
          <KeysTag />
        </>
      ) : (
        <>
          <SloganStamp />
          <PersistReceipt />
        </>
      )}
    </div>
  );
}
