/**
 * Native entry point. See `modules/tiplist-spx-community/index.mjs`: the
 * same file runs unchanged in both runtimes, so it assigns a global rather
 * than exporting, and the global is deleted once captured.
 */

import "./module.js";

const spdexModule = globalThis.spdexModule;
delete globalThis.spdexModule;

export default spdexModule;
