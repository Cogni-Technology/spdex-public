# Vendored: Optimism's Merkle-Patricia trie verifier

`SpxHolderRegistry.prove` follows two `eth_getProof` proofs: from a block's
state root to SPX's account, then from SPX's storage root to a holder's
balance. Following such a proof is the one complex piece of spDEX v2, so it is
not written fresh. These files are Optimism's, whose portal proves every
withdrawal from its chain with the same library. They are MIT-licensed
(`LICENSE`, below). Everything else in this package is AGPL-3.0-or-later.

**Review starts here.** A bug in these files could accept a false proof. That
would let an address that never held SPX be paid fees inside a v2 vault's
community window, the way anyone earns every fee in v1. It cannot move a
vault's funds (`docs/V2_UPGRADE.md`, "Risks and failure modes").

## Source

| | |
|---|---|
| Repository | https://github.com/ethereum-optimism/optimism |
| Tag | `op-contracts/v8.0.0` (annotated; it points to the tag `op-contracts/v8.0.0-rc.3`, which points to the commit below) |
| Commit | `f45a5ccfebcdf6da3f5b09cbc512667c063730b7` |
| Fetched | 2 October 2026. Each source file's hash was checked the same day against the raw file at that commit. |

| Here | Upstream, at that commit | sha256 as fetched (= upstream) | sha256 here |
|---|---|---|---|
| `trie/MerkleTrie.sol` | `packages/contracts-bedrock/src/libraries/trie/MerkleTrie.sol` | `9ce13ec201485c87989df0ec89407dde9da8d95d54baf3c4d68fbfeb9d421b0a` | `5608d2f2397e87d93cee67dab6d9fc80b6354eeee806a94e7da17c21e29b5249` |
| `trie/SecureMerkleTrie.sol` | `packages/contracts-bedrock/src/libraries/trie/SecureMerkleTrie.sol` | `755f79cb43e84d30dec6f1f535809bd4d18594c5d9bedf7407fdc6d374489980` | `ee061807d9916a531bf54e81a77258ee0fe360764bb356d06a69ba5fd1cecf07` |
| `rlp/RLPReader.sol` | `packages/contracts-bedrock/src/libraries/rlp/RLPReader.sol` | `78b6bab28e975e14923202a9ac63a376a63e4f012c101a8f066891fc53074ca6` | `9844563f51326944ea57e2115da0de83524719f8438ec3b81155d897bc5ca3eb` |
| `rlp/RLPErrors.sol` | `packages/contracts-bedrock/src/libraries/rlp/RLPErrors.sol` | `c775036bad8a0e00beeeae9fd20c733dcfdc2ddc57464d70299cb5c148aeec60` | unchanged |
| `Bytes.sol` | `packages/contracts-bedrock/src/libraries/Bytes.sol` | `235a1dcaf00fb7eeb2033033fdca135790c7415054aeb8303e5e070baca6e879` | unchanged |
| `LICENSE` | `LICENSE` (the repository's root, MIT, "Copyright 2020-2025 Optimism") | `1c7806fae35858a40b2f69dfe2a08e5fabdabf658d8337759078767b96fa3b8c` | unchanged |

## What was changed

Only import paths. Upstream they are resolved from `packages/contracts-bedrock`
(`src/libraries/...`). Here they are relative, so the files compile where they
sit with no remappings. Every other byte, licence headers and pragmas
included, is as fetched.

| File | Upstream | Here |
|---|---|---|
| `trie/MerkleTrie.sol`, line 5 | `import { Bytes } from "src/libraries/Bytes.sol";` | `import { Bytes } from "../Bytes.sol";` |
| `trie/MerkleTrie.sol`, line 6 | `import { RLPReader } from "src/libraries/rlp/RLPReader.sol";` | `import { RLPReader } from "../rlp/RLPReader.sol";` |
| `trie/SecureMerkleTrie.sol`, line 5 | `import { MerkleTrie } from "src/libraries/trie/MerkleTrie.sol";` | `import { MerkleTrie } from "./MerkleTrie.sol";` |
| `rlp/RLPReader.sol`, line 12 | `} from "src/libraries/rlp/RLPErrors.sol";` | `} from "./RLPErrors.sol";` |

Their pragmas (`^0.8.0`, `^0.8.8`) admit the repository's pinned compiler
(0.8.33, `foundry.toml`), which builds them with the same settings as
everything else. `forge lint` skips this directory (`foundry.toml`, `[lint]`).
These files are linted where they are maintained, and are not edited here.

To check it again (any machine, no Foundry needed):

```bash
C=f45a5ccfebcdf6da3f5b09cbc512667c063730b7
U=https://raw.githubusercontent.com/ethereum-optimism/optimism/$C/packages/contracts-bedrock/src/libraries
for f in trie/MerkleTrie.sol trie/SecureMerkleTrie.sol rlp/RLPReader.sol rlp/RLPErrors.sol Bytes.sol; do
  curl -sL "$U/$f" | diff - "packages/vault/contracts/vendor/optimism/$f"
done   # prints only the four import lines above
```

## What the registry uses, and what to know about it

The registry calls `SecureMerkleTrie.get` (twice) and `RLPReader.readList` /
`readBytes` (on the header, the account and the balance). Reachable from
those: `MerkleTrie.get`, `_parseProof`, `_getNodeID`, `_getNodePath`,
`_getSharedNibbleLength`, `RLPReader.toRLPItem`, `readRawBytes`,
`_decodeLength`, `_copy`, and `Bytes.toNibbles`, `slice` and `equal`. The
`verifyInclusionProof` functions are not used.

Properties the registry relies on, each pinned by `test/forge/Registry.t.sol`
against real mainnet proofs:

- `get` returns a value only for a key that is in the trie. A proof of absence
  reverts, so an address with no SPX cannot prove.
- Every node of a proof is checked against the hash its parent names, from the
  given root down. A node changed anywhere, a node too few, or a node too many
  after the value reverts.
- An empty value is refused, as geth treats it: "this key does not exist".
- `RLPReader` accepts at most 32 items in a list (`MAX_LIST_LENGTH`). A list
  with more panics. Branch nodes have 17 and today's block header 21, so a
  header can grow by eleven more fields before proving would need a new
  registry.
- Bad proofs revert with this library's own messages (`"MerkleTrie: ..."`
  strings, and `RLPErrors`' custom errors), not with the registry's.
- A node under 32 bytes is embedded in its parent rather than hashed, and
  this library expects it as an element of the proof of its own (compared
  byte for byte with what the parent embeds). geth's `eth_getProof` leaves
  embedded nodes out. So a proof whose path ends in an embedded node is
  refused ("MerkleTrie: ran out of proof elements"), never accepted: the
  parent's hash covers the embedded bytes. For the registry's two proofs it
  cannot arise. An account leaf holds at least 70 bytes. A balance leaf
  (a value of at most 10 bytes) is under 32 bytes only 27 or more nibbles
  deep, which takes two hashed keys sharing their first 26 nibbles, about one
  chance in 2^104 a pair; the recorded proofs end 5 to 7 nodes deep. A tool
  that ever met one would append the embedded node to the proof it sends.

Cost: decoding a 17-item branch node takes about 25,000 gas, so a whole
`prove` (about 15 nodes) is about 520,000 to 550,000 gas as a call. That is
the price of using this library unchanged.
