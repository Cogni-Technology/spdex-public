/**
 * Pricing a route's gas in the token the user receives.
 *
 * Splitting a swap across pools always yields more gross output — that is what
 * diminishing returns guarantee — so an optimiser that only maximises output
 * will always split, and will happily add a third leg to gain a few basis
 * points while spending more than that in gas. Comparing routes therefore
 * requires gas and output denominated in the same unit.
 *
 * The router does not decide what gas costs. It asks, because the honest answer
 * depends on the native-token price, which is exactly the sort of thing the
 * host should own and the user should be able to see and override.
 */

export interface GasModel {
  /** What `gasUnits` of gas is worth, expressed in tokenOut's smallest unit. */
  costInTokenOut(gasUnits: bigint): bigint;
}

/**
 * Gas priced at a fixed native-token price and a fixed tokenOut/native rate.
 *
 * `tokenOutPerNative` is how much tokenOut one whole native token buys, in
 * tokenOut's smallest unit — the same number a quote would give for 1e18 wei.
 */
export function linearGasModel(options: {
  gasPriceWei: bigint;
  tokenOutPerNative: bigint;
}): GasModel {
  const { gasPriceWei, tokenOutPerNative } = options;
  return {
    costInTokenOut(gasUnits: bigint): bigint {
      if (gasUnits <= 0n) return 0n;
      // gas * price = wei spent; scaled by tokenOut-per-1e18-wei.
      return (gasUnits * gasPriceWei * tokenOutPerNative) / 10n ** 18n;
    },
  };
}

/**
 * Treats gas as free.
 *
 * Only correct when the caller genuinely does not care — a quote preview, say.
 * Never a sensible default for execution: with gas free, one more leg is always
 * an improvement, so routes grow until they hit `maxSplits`. Named explicitly
 * so choosing it is visible in a diff.
 */
export const IGNORE_GAS: GasModel = {
  costInTokenOut: () => 0n,
};
