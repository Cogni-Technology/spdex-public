/** Types for the release CID script, which is plain JS so `node scripts/ipfs-cid.mjs` runs it directly. */
export interface BuildCid {
  /** The build's root CID: a directory holding everything in it, as `ipfs add -r` makes. */
  cid: string;
  /** Every file and folder under the root, by path, with its own CID and size. */
  files: { path: string; cid: string; size: number }[];
}

export declare function computeCid(distDir: string): Promise<BuildCid>;
