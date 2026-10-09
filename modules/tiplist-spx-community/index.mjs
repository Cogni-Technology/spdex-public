/**
 * Native entry point.
 *
 * Same shape as the venue modules, and for the same reason: `module.js` assigns
 * a global rather than exporting, because QuickJS has no module loader, and one
 * file running unchanged in both runtimes is what makes the parity gate mean
 * anything.
 *
 * The global is deleted after capture so a module cannot leave anything behind
 * for the next one to find.
 */

import "./module.js";

const spdexModule = globalThis.spdexModule;
delete globalThis.spdexModule;

export default spdexModule;
