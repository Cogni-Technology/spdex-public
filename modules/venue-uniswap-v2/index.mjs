/**
 * Native entry point. See `modules/venue-uniswap-v3/index.mjs` for why the
 * module assigns a global rather than exporting: QuickJS has no module loader,
 * and one file running unchanged in both runtimes is what makes the parity gate
 * mean anything.
 */

import "./module.js";

const spdexModule = globalThis.spdexModule;
delete globalThis.spdexModule;

export default spdexModule;
