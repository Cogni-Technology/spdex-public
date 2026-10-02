# Releasing to IPFS

## Why reproducibility comes first

Pinning a build to IPFS gives it a content address. That address is only
*meaningful* if someone else can rebuild the same source and arrive at the same
address — otherwise "this CID is spDEX" rests entirely on trusting whoever did
the pinning, which is the arrangement this project exists to avoid.

So reproducibility is checked on every `pnpm verify` run, not at release time:

```bash
pnpm verify:reproducible
```

It builds twice, into two different output directories, and requires an
identical CID. Different directories on purpose — the commonest cause of an
irreproducible build is one that embeds its own absolute path somewhere.

Three things are pinned to make that hold:

- **No source maps.** They embed absolute build paths, so two machines with
  byte-identical application code would still produce different files.
- **`LC_ALL=C`, `TZ=UTC`.** Locale and timezone can both reach output through
  date and string formatting.
- **Explicit UnixFS parameters** — CIDv1, raw leaves, 262144-byte fixed chunks.
  Each of these changes the address, so a library default drifting between major
  versions would look exactly like a tampered build.

## Cutting a release

`docs/RELEASE.md` is the whole checklist, contracts and keeper included; this
section is its build step.

```bash
pnpm verify --strict          # everything must be green, nothing skipped
pnpm build:release            # deterministic build into apps/web/dist
pnpm ipfs:cid                 # the address, plus a per-file listing
```

Before building:

- **Set the three addresses the app may print,** in `.env.local` or the
  environment. Each is optional, and the app never fills one in itself:
  not from the address bar, which may be a dev server, a shared gateway or a
  stranger's copy, and not from a built-in domain, since nobody can promise
  who holds one later. Each must be an `https://` address on a public name.

  ```bash
  VITE_SPDEX_APP_URL=https://<where this release is published>    # the link on cards and in calendar files
  VITE_SPDEX_SOURCE_URL=https://<where its source is published>   # Verify this build's git clone
  VITE_SPDEX_FEEDBACK_URL=https://<where people leave feedback>   # the footer's Feedback link, e.g. …/issues/new/choose
  ```

  Unset, a card says "open #receipt=… in any spDEX", a calendar file has no
  link, and Verify this build says "This build doesn't say where its source
  is published." instead of the commands below.
- **Publish every `VITE_SPDEX_*` value the release was built with.** Vite
  writes them into the bundle, so they are part of the CID: someone rebuilding
  to check it needs the same values, the committed `.env.defaults` ones
  included (the public fallback service's address is one). The built-in
  network service's key and canonical origins are among them, and the key is
  in the bundle for anyone to read anyway (see `docs/RPC-RUNBOOK.md`).
- **Read the currency feeds again.** `FX_REFERENCE` in
  `packages/chain/src/fx.ts` is each Chainlink feed's answer at
  `FX_REFERENCE_BLOCK`, and an answer outside 0.2× to 5× of it counts as
  unknown. A currency that has drifted out of its band since the last release
  reads as unavailable until the references are read again at a newer block.
  Ether's dollar reference, `ETH_USD_REFERENCE` in
  `apps/web/src/lib/money/convert.ts`, is `FX_REFERENCE.ETH` (the ETH/USD
  feed's answer), so it is read again with them.

Publish the root CID with the release notes so anyone can check it:

```bash
ipfs add -rn --cid-version=1 apps/web/dist    # -n computes without adding
```

`-n` computes the address without pinning, which is exactly what a third party
wants: verify first, trust after. kubo 0.43.1 prints the same root as
`pnpm ipfs:cid` (checked 2026-10-02).

### Pinning

Pin a CAR file, not the folder:

```bash
pnpm ipfs:cid --car spdex.car    # the address, and every block behind it
```

A service given the folder chunks the files its own way and may pin another
address than the one you publish. A CAR carries the blocks themselves, so
the address pinned is this one. Either way, check the CID the service reports
against `pnpm ipfs:cid` before anything points at it.

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
a subdomain, such as `www.<domain>`, and it keeps that record itself: change
the DNSLink in the gateway (or its API), not in DNS. Redirect the bare domain
to it. Add `frame-ancestors 'none'` there as a response header
(`docs/RELEASE.md`, part 6) and check it arrives:
`curl -sI https://<host>/ | grep -i content-security-policy`.

DNSLink is the mutable pointer; the CID is the immutable artifact. Users who
want to pin a specific audited version can ignore the DNS name entirely and
address the CID directly, which is the point.

## What changes on an IPFS copy

The built-in service's key is allowlisted to the canonical origins
(`VITE_SPDEX_CANONICAL_ORIGIN`), and the app uses it without asking only
there. On a gateway it will not work, so first-run asks the user for a
network service instead. That is deliberate — see `docs/RPC-RUNBOOK.md`. A
stable name that serves the release, such as `https://<name>.eth.limo`, can be
a canonical origin too: list it in `VITE_SPDEX_CANONICAL_ORIGIN` (commas
between origins, each with its `https://`; the build refuses a bare host) and
in the key's Alchemy Domains allowlist, both or neither.
Never a gateway's shared origin (`ipfs.io`, `*.ipfs.dweb.link`). The build is
otherwise identical: same code, same modules, same Guard.

The app uses relative asset paths (`base: "./"`), so it works from a gateway
subpath such as `https://<gateway>/ipfs/<CID>/` as well as from a domain root.

A path gateway has one catch, which Trust and exits tells anyone who opens a
copy that way:

> This copy is served under a path on a shared gateway, so it shares this
> browser's storage (settings, records, notification permission) with every
> other site on that gateway. A subdomain gateway (`<CID>.ipfs.<gateway>`)
> keeps them apart. Releases opened on the same gateway share settings: an
> older release can't read newer settings and starts from the preset, so
> don't change settings there.

Nothing on a gateway can vouch for itself, and the app doesn't try. Trust
and exits ("Verify this build") says where the page was loaded from and gives
the commands below; it never says "verified". `docs/WALKAWAY.md` has the rest
of that panel.

## Verifying a published build yourself

```bash
git clone <where the source is published> spdex && cd spdex
git checkout <release tag>
pnpm install --frozen-lockfile
pnpm build:release            # with the release's published VITE_SPDEX_* values
pnpm ipfs:cid
```

If the printed CID matches the published one, the bundle being served is built
from exactly that source. If it does not, something between the source and the
pin changed, and the difference is worth understanding before using it.

A match proves what the CID holds, not that the source is safe, and not that
a tab is running those files: only opening the CID yourself, through your own
IPFS node or a gateway you trust, does that.
