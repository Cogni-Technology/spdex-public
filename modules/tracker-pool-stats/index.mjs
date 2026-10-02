/**
 * Native entry point. See `modules/tiplist-spx-community/index.mjs` — the
 * module assigns a global rather than exporting, because QuickJS has no module
 * loader and one file running unchanged in both runtimes is what makes the
 * parity gate mean anything.
 */

import "./module.js";

const spdexModule = globalThis.spdexModule;
delete globalThis.spdexModule;

export default spdexModule;
