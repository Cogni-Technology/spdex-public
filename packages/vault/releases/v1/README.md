# v1: the release on mainnet, frozen

`contracts/` here is a verbatim copy of the source spDEX's first release of
the auto-buy contracts was deployed from:

| Contract | Address | Block |
|---|---|---|
| `SpdexVaultFactory` | `0xe4a1410a9ee0833d41e7514306e65ad729b7199e` | 26,100,366 |
| `SpdexVaultBatcher` | `0xc5ce65451dd5fc99d08eb18440b06f2bcca3c5a0` | 26,100,368 |

Never edit it. Those contracts are immutable and run unchanged for good, and
every v1 vault is a clone of the implementation that factory deployed. The
copy is kept for two reasons:

- **Anyone can rebuild them.** `foundry.toml`'s `v1` profile compiles this
  directory with the pinned compiler and settings, and
  `pnpm --filter @spdex/vault check:artifacts` refuses a build whose factory or
  batcher address is not the one `deployments.json` records for v1.
- **The app and the keeper still serve v1 vaults.** `src/artifacts.ts` carries
  v1's ABIs and creation code (`V1_*`) from this build, so v1 vaults go on being
  shown, funded, closed and triggered, and the fork tests can deploy v1 beside
  the current release.

The current release's source is `../../contracts`. What changed between them
is `docs/V2_UPGRADE.md`.
