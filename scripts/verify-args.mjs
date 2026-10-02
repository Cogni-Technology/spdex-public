/**
 * Command-line parsing for `pnpm verify`, kept apart from the runner so it can
 * be tested without running a stage.
 *
 * Every argument is either understood or refused. `--only` used to be matched
 * against the stage ids as one exact string, so `--only=typecheck,unit` or a
 * typo such as `--only=unti` matched nothing, ran nothing and printed
 * VERIFY OK with exit 0, `--strict` included, because nothing was skipped or
 * empty. The same went for a misspelt flag: `--stirct` was ignored and the run
 * went green on skips. A gate that answers green to a command it didn't
 * understand is worse than no gate, so anything unrecognised is an error.
 */

/**
 * @param {readonly string[]} argv the arguments after the script name
 * @param {readonly string[]} stageIds every stage id, in run order
 * @returns {{ ok: true, strict: boolean, json: boolean, only: string[] | null }
 *   | { ok: false, strict: boolean, json: boolean, error: string }}
 */
export function parseVerifyArgs(argv, stageIds) {
  let strict = false;
  let json = false;
  /** @type {string[] | null} */
  let only = null;
  const problems = [];
  const valid = `Valid stages: ${stageIds.join(", ")}.`;

  for (const arg of argv) {
    if (arg === "--strict") strict = true;
    else if (arg === "--json") json = true;
    // `pnpm verify -- --strict` hands the script a bare `--`; it means nothing here.
    else if (arg === "--") continue;
    else if (arg.startsWith("--only=")) {
      const ids = arg
        .slice("--only=".length)
        .split(",")
        .map((id) => id.trim())
        .filter((id) => id !== "");
      if (ids.length === 0) {
        problems.push(`--only names no stage. ${valid}`);
        continue;
      }
      const unknown = ids.filter((id) => !stageIds.includes(id));
      if (unknown.length > 0) {
        problems.push(`Unknown stage${unknown.length === 1 ? "" : "s"} in --only: ${unknown.join(", ")}. ${valid}`);
        continue;
      }
      // Several --only flags add up rather than the first one winning silently.
      only = [...(only ?? []), ...ids];
    } else if (arg === "--only") {
      problems.push(`Write --only=<stage>[,<stage>…] with an equals sign. ${valid}`);
    } else {
      problems.push(`Unknown argument: ${arg}. Accepted: --strict, --json, --only=<stage>[,<stage>…].`);
    }
  }

  if (problems.length > 0) return { ok: false, strict, json, error: problems.join("\n") };
  return { ok: true, strict, json, only };
}
