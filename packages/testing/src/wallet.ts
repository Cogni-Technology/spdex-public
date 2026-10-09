/**
 * A headless EIP-1193 wallet for end-to-end tests.
 *
 * Deliberately not MetaMask-via-Synpress. A browser extension brings its own
 * update cycle, its own onboarding screens and its own flakiness, and every one
 * of those becomes a reason your test suite fails for something that is not
 * your bug. This is about a hundred lines, has no UI to click through, and can
 * be made to *refuse* a request — which is how you test that the Guard's
 * rejection path actually reaches the user, rather than blindly approving
 * everything the way a scripted extension does.
 *
 * Signing is delegated to the node: anvil unlocks its default accounts, so
 * `eth_sendTransaction` can be relayed as-is, and so can
 * `eth_signTypedData_v4`, which anvil signs for the same accounts. That keeps
 * private keys out of the test harness entirely.
 */

export interface HeadlessWalletOptions {
  /** Node the wallet relays to — normally the pinned fork. */
  rpcUrl: string;
  /** Account to report from `eth_accounts`. */
  address: string;
  chainId?: number;
  /**
   * Reject transactions instead of sending them, modelling a user who declines.
   * Lets a test assert the app handles refusal rather than hanging.
   */
  rejectTransactions?: boolean;
  /**
   * Refuse `eth_signTransaction`, modelling the many wallets that will not sign
   * without broadcasting. Exists so the private-submission path can be tested
   * against a wallet that cannot do it — the case where silently falling back
   * would quietly void a privacy guarantee.
   */
  refuseSignTransaction?: boolean;
  /**
   * Refuse `eth_signTypedData_v4` as unsupported (4200), modelling a wallet
   * that cannot sign typed data at all, so the fallback to separate tip
   * transfers can be tested.
   */
  refuseSignTypedData?: boolean;
  /**
   * Decline (4001) any `approve` whose spender is this address, and nothing
   * else: a person who says no to one permission and yes to the rest, such as
   * the standing Permit2 permission a batched tip asks for.
   */
  rejectApprovalsTo?: string;
}

/**
 * Build the script to inject before page load.
 *
 * Returned as source rather than a function because Playwright's
 * `addInitScript` runs it in the page, where nothing from this module exists.
 */
export function headlessWalletScript(options: HeadlessWalletOptions): string {
  const config = {
    rpcUrl: options.rpcUrl,
    address: options.address.toLowerCase(),
    chainId: options.chainId ?? 1,
    rejectTransactions: options.rejectTransactions ?? false,
    refuseSignTransaction: options.refuseSignTransaction ?? false,
    refuseSignTypedData: options.refuseSignTypedData ?? false,
    rejectApprovalsTo: (options.rejectApprovalsTo ?? "").toLowerCase().replace(/^0x/, ""),
  };

  return `
(() => {
  const CONFIG = ${JSON.stringify(config)};
  const chainIdHex = "0x" + CONFIG.chainId.toString(16);
  let nextId = 0;

  /** Everything the wallet does not handle itself is relayed to the node. */
  async function relay(method, params) {
    const response = await fetch(CONFIG.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++nextId, method, params: params || [] }),
    });
    const json = await response.json();
    if (json.error) {
      const error = new Error(json.error.message);
      error.code = json.error.code;
      throw error;
    }
    return json.result;
  }

  const listeners = new Map();

  const provider = {
    isSpdexTestWallet: true,
    // Records every transaction the app asked for, so a test can assert on what
    // was actually proposed rather than only on what came back.
    _sent: [],
    // Transactions the app asked to be signed but not broadcast.
    _signed: [],
    // Typed data the app asked to be signed (eth_signTypedData_v4), as the
    // parsed object, so a test can count signatures and read what each said.
    _typed: [],
    // Every request the three lists above record, in the order the app made
    // them: those say what was asked, and only this one says in what order
    // across them. Each entry is the method, and for a transaction its
    // target and calldata.
    _prompts: [],

    async request({ method, params }) {
      switch (method) {
        case "eth_requestAccounts":
        case "eth_accounts":
          return [CONFIG.address];
        case "eth_chainId":
          return chainIdHex;
        case "net_version":
          return String(CONFIG.chainId);
        case "wallet_switchEthereumChain":
        case "wallet_addEthereumChain":
          return null;
        case "eth_signTransaction": {
          if (CONFIG.refuseSignTransaction) {
            const error = new Error("eth_signTransaction is not supported by this wallet");
            error.code = 4200;
            throw error;
          }
          const tx = (params && params[0]) || {};
          provider._prompts.push({ method, to: tx.to, data: tx.data });
          provider._signed.push(tx);
          return relay("eth_signTransaction", [{ ...tx, from: tx.from || CONFIG.address }]);
        }
        case "eth_signTypedData_v4": {
          const signer = (params && params[0]) || CONFIG.address;
          const raw = params && params[1];
          provider._prompts.push({ method });
          provider._typed.push(typeof raw === "string" ? JSON.parse(raw) : raw);
          if (CONFIG.refuseSignTypedData) {
            const error = new Error("eth_signTypedData_v4 is not supported by this wallet");
            error.code = 4200;
            throw error;
          }
          return relay("eth_signTypedData_v4", [signer, raw]);
        }
        case "eth_sendRawTransaction":
          return relay("eth_sendRawTransaction", params);
        case "eth_sendTransaction": {
          const tx = (params && params[0]) || {};
          provider._prompts.push({ method, to: tx.to, data: tx.data });
          provider._sent.push(tx);
          const data = String(tx.data || "").toLowerCase();
          const declined =
            CONFIG.rejectTransactions ||
            (CONFIG.rejectApprovalsTo !== "" &&
              data.startsWith("0x095ea7b3") &&
              data.slice(10, 74).endsWith(CONFIG.rejectApprovalsTo));
          if (declined) {
            // 4001 is the EIP-1193 code for "user rejected"; apps are expected
            // to handle it gracefully rather than treat it as a failure.
            const error = new Error("user rejected the request");
            error.code = 4001;
            throw error;
          }
          const from = tx.from || CONFIG.address;
          if (tx.gas || tx.gasLimit) return relay("eth_sendTransaction", [{ ...tx, from }]);
          // A gas limit with headroom, as a real wallet sets one (MetaMask pads
          // its estimate by half). Relayed without one, anvil sizes the limit
          // itself, exactly, against the latest block's timestamp; when the
          // transaction then lands in a later second, a Uniswap v2 pair last
          // touched in that latest block writes its price accumulators too,
          // costing ~25k gas more than was estimated, and the swap reverts out
          // of gas. That was native.spec's "flaky" first ETH -> SPX swap: it
          // ran straight after another test's swap on the same pair.
          const estimate = BigInt(await relay("eth_estimateGas", [{ ...tx, from }]));
          return relay("eth_sendTransaction", [{ ...tx, from, gas: "0x" + ((estimate * 3n) / 2n).toString(16) }]);
        }
        default:
          return relay(method, params);
      }
    },

    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(handler);
      return provider;
    },
    removeListener(event, handler) {
      listeners.get(event)?.delete(handler);
      return provider;
    },

    /*
     * Fire a provider event, as a real wallet does when the user switches.
     *
     * A test hook, hence the underscore, and the counterpart to the listener
     * registry above -- which nothing could otherwise ring. Without it there
     * is no way to cover the case where the wallet moves to another chain
     * AFTER the app has connected, which is the common one: MetaMask returns
     * to Ethereum Mainnet on reload, and an app that only checked at connect
     * time never notices.
     *
     * No backticks anywhere in this string: the whole wallet body is a
     * template literal, so one would end it and take the rest of the file
     * with it.
     */
    _emit(event, ...args) {
      for (const handler of listeners.get(event) ?? []) handler(...args);
    },
  };

  Object.defineProperty(window, "ethereum", { value: provider, writable: false, configurable: true });

  // EIP-6963, so an app that discovers wallets by announcement rather than by
  // reading window.ethereum finds this one too.
  const detail = Object.freeze({
    info: {
      uuid: "00000000-0000-4000-8000-00000000d3c5",
      name: "spDEX Test Wallet",
      icon: "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4=",
      rdns: "io.spdex.testwallet",
    },
    provider,
  });
  const announce = () => window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail }));
  window.addEventListener("eip6963:requestProvider", announce);
  announce();
})();
`;
}
