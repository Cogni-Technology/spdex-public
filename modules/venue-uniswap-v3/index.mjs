/**
 * Native entry point.
 *
 * `module.js` is a plain script that assigns `globalThis.spdexModule`, because
 * that is the only shape QuickJS can evaluate — it has no module loader. This
 * wrapper imports those exact bytes, captures the object, and removes the
 * global again so nothing leaks into the host's scope.
 *
 * The alternative would be maintaining an ESM copy alongside the sandbox copy,
 * and two copies of a module is precisely the drift the parity gate exists to
 * catch. One file, two entry points, identical bytes.
 */

import "./module.js";

const spdexModule = globalThis.spdexModule;
delete globalThis.spdexModule;

export default spdexModule;
