# Releasing to IPFS

## Why reproducibility comes first

A CID means "this is spDEX" only if someone else can rebuild the source and
get the same CID. Otherwise it rests on trusting whoever pinned it, which is
the arrangement this project exists to avoid. So every `pnpm verify` checks
it, not only a release:

```bash
pnpm verify:reproducible
```

It builds twice, into two different output directories, and requires an
identical CID. Different directories on purpose: the commonest cause of an
irreproducible build is one that embeds its own absolute path.

Three things are pinned to make that hold:

- **No source maps.** They embed absolute build paths.
- **`LC_ALL=C`, `TZ=UTC`.** Locale and timezone can reach output through date
  and string formatting.
- **Explicit UnixFS parameters**: CIDv1, raw leaves, 262144-byte fixed chunks.
  Each changes the address, so a library default drifting between versions
  would look exactly like a tampered build.

## Cutting a release

`docs/RELEASE.md` is the whole checklist, contracts and keeper included; this
is its build step.

```bash
pnpm verify --strict          # everything green, nothing skipped
pnpm build:release            # deterministic build into apps/web/dist
pnpm ipfs:cid                 # the address, plus a per-file listing
```

Before building:

- **Set the build settings** (`docs/RELEASE.md`, part 5).
- **Publish every `VITE_SPDEX_*` value the release was built with.** Vite
  writes them into the bundle, so they are part of the CID: someone rebuilding
  to check it needs the same values, the committed `.env.defaults` ones
  included (the public fallback service's address is one). The built-in
  network service's key and canonical origins are among them; the key is in
  the bundle for anyone to read anyway (`docs/RPC-RUNBOOK.md`).
- **Read the currency feeds.** `FX_REFERENCE` (`packages/chain/src/fx.ts`)
  holds each Chainlink feed's answer at the fork's pinned block
  (`FX_REFERENCE_BLOCK`); an answer outside 0.2× to 5× of it counts as
  unknown. The integration stage requires exactly those answers, so never
  re-read them at a recent block on their own: the strict gate would fail.
  Check only that every currency is well inside its band: `pnpm fx:bands`
  reads every feed now and fails on any past 3×, and
  `.github/workflows/fx-bands.yml` runs it every Monday, so a drifting
  currency (the Argentine peso is the likeliest) is flagged long before 5×.
  When one is, move the pinned block, and the references with it.
  `ETH_USD_REFERENCE` (`apps/web/src/lib/money/convert.ts`) is
  `FX_REFERENCE.ETH`, so it moves with them.

Publish the root CID with the release notes so anyone can check it.

### Pinning

```bash
pnpm ipfs:cid --car spdex.car    # the address, and every block behind it
```

A CAR carries the blocks themselves, so the address pinned is this one. A
service given the folder chunks the files its own way and may pin another
address. On Pinata's free plan, which takes no CAR, uploading the build folder
(`apps/web/dist`) gave the same CID as `pnpm ipfs:cid` (2026-10-07). Either
way, check the CID the service reports against `pnpm ipfs:cid` before DNSLink
moves.

```bash
# Pinata (CAR uploads need a paid plan; its default network is private)
curl -X POST https://uploads.pinata.cloud/v3/files -H "Authorization: Bearer $PINATA_JWT" \
  -F network=public -F car=true -F name=spdex-<release tag> -F file=@spdex.car

# or your own node, then any pinning service
ipfs dag import spdex.car
ipfs pin remote add --service=<svc> <CID>
```

Then point DNSLink at it:

```
_dnslink.<host>  TXT  "dnslink=/ipfs/<CID>"
```

A Cloudflare IPFS gateway (Web3 → Create Gateway → IPFS DNSLink) can only be
a subdomain, such as `www.<domain>`, and keeps that record itself: change the
DNSLink in the gateway (or its API), not in DNS. Redirect the bare domain to
it, and add the `frame-ancestors 'none'` response header there
(`docs/RELEASE.md`, part 6).

DNSLink is the mutable pointer; the CID is the immutable build. Anyone can
ignore the name and open a CID directly, which is the point.

## What changes on an IPFS copy

The built-in service's key is allowlisted to the canonical origins
(`VITE_SPDEX_CANONICAL_ORIGIN`), and the app offers it, last on the first
screen, only there; it never uses it without asking. On a gateway the key
won't work, so the first screen leaves it out and offers a key of the user's
own or the public service (`docs/RPC-RUNBOOK.md`). A stable name that serves
the release, such as `https://<name>.eth.limo`, can be a canonical origin too:
list it in `VITE_SPDEX_CANONICAL_ORIGIN` (comma-separated, each with its
`https://`; the build refuses a bare host) and in the key's Alchemy Domains
allowlist, both or neither. Never a gateway's shared origin (`ipfs.io`,
`*.ipfs.dweb.link`). Otherwise the build is identical: same code, same
modules, same Guard.

The app uses relative asset paths (`base: "./"`), so it works from a gateway
subpath such as `https://<gateway>/ipfs/<CID>/` as well as from a domain root.
A path gateway has one catch, which Trust and exits tells anyone who opens a
copy that way (`sharedGatewayNote` in `apps/web/src/lib/network/walkaway.ts`):
the copy shares the browser's storage (settings, records, notification
permission) with every other site on that gateway, any of which can change
its settings. A subdomain gateway (`<CID>.ipfs.<gateway>`) keeps them apart.
Releases opened on one gateway share settings: an older release can't read
newer ones and starts from the preset.

Nothing on a gateway can vouch for itself, and the app doesn't try. Trust and
exits ("Verify this build") says where the page was loaded from and gives the
commands below; it never says "verified". `docs/WALKAWAY.md` has the rest of
that panel.

## Verifying a published build yourself

```bash
git clone <where the source is published> spdex && cd spdex
git checkout <release tag>
pnpm install --frozen-lockfile
pnpm build:release            # with the release's published VITE_SPDEX_* values
pnpm ipfs:cid
```

Or, without pnpm's CID step, `ipfs add -rn --cid-version=1 apps/web/dist`:
`-n` computes the address without pinning. kubo 0.43.1 prints the same root
as `pnpm ipfs:cid` (checked 2026-10-02).

If the CID matches the published one, the bundle served is built from
exactly that source. If not, something between the source and the pin
changed, and the difference is worth understanding before using it.

A match proves what the CID holds, not that the source is safe, and not that
a tab is running those files: only opening the CID yourself, through your own
IPFS node or a gateway you trust, does that.
