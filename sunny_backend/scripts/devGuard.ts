// scripts/devGuard.ts
// Purpose: Decide whether `npx convex run` (as scripts/caregiver.ts calls it) would act on a
// dev deployment, so the script, which impersonates users with --identity, refuses anything
// else. It mirrors how the Convex CLI (convex 1.x, cli/lib/deploymentSelection.js) picks the
// deployment when no --deployment, --url or --env-file flag is given:
// - it loads .env.local and then .env with dotenv, which never overrides a variable already in
//   the environment, so a variable exported in the shell wins over both files, and .env.local
//   wins over .env; an empty value counts as unset;
// - a deploy key (CONVEX_DEPLOY_KEY, else its alias CONVEX_DEPLOYMENT_TOKEN) takes precedence
//   over everything; its prefix names the deployment type ("dev:", "prod:", "preview:",
//   "project:");
// - otherwise CONVEX_SELF_HOSTED_URL with CONVEX_SELF_HOSTED_ADMIN_KEY, or CONVEX_DEPLOYMENT
//   ("dev:<name>" or "prod:<name>").
// deploymentProblem returns why the target is not a dev deployment, or null when it is.
//
// Last modified: 2026-11-09

/** Variables a source may define, by name. */
export type EnvSource = Record<string, string | undefined>;

/**
 * purpose: Parse a dotenv file's NAME=value lines (optional "export ", optional quotes, "#"
 *          comments). Enough for the deployment variables; not a full dotenv parser.
 * @param text: (string) File contents.
 * @return: (EnvSource) The variables.
 */
export function parseEnvFile(text: string): EnvSource {
  const vars: EnvSource = {};
  for (const line of text.split("\n")) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2]!.trim();
    const quoted = /^(["'])(.*)\1$/.exec(value);
    value = quoted ? quoted[2]! : value.replace(/\s+#.*$/, "");
    vars[match[1]!] = value;
  }
  return vars;
}

/**
 * purpose: The value the CLI would use for a variable: the first source with a non-empty value.
 * @param sources: (EnvSource[]) In precedence order: the process environment, .env.local, .env.
 * @param name: (string) Variable name.
 * @return: (string | undefined) The value, or undefined when no source sets it.
 */
function effective(sources: EnvSource[], name: string): string | undefined {
  for (const source of sources) {
    const value = source[name];
    if (value !== undefined && value !== "") return value;
  }
  return undefined;
}

/**
 * purpose: Why `npx convex run` would not act on a dev deployment, if it would not.
 * @param sources: (EnvSource[]) In precedence order: the process environment, .env.local, .env.
 * @return: (string | null) The problem, or null when the target is a dev deployment.
 */
export function deploymentProblem(sources: EnvSource[]): string | null {
  const keyName = effective(sources, "CONVEX_DEPLOY_KEY")
    ? "CONVEX_DEPLOY_KEY"
    : "CONVEX_DEPLOYMENT_TOKEN";
  const deployKey = effective(sources, keyName);
  if (deployKey !== undefined) {
    return deployKey.startsWith("dev:")
      ? null
      : `${keyName} is set to a key that is not for a dev deployment`;
  }
  if (effective(sources, "CONVEX_SELF_HOSTED_URL") !== undefined) {
    return "CONVEX_SELF_HOSTED_URL is set, so the target cannot be confirmed to be a dev deployment";
  }
  const deployment = effective(sources, "CONVEX_DEPLOYMENT");
  if (deployment === undefined) return "CONVEX_DEPLOYMENT is not set";
  return deployment.startsWith("dev:")
    ? null
    : `CONVEX_DEPLOYMENT is "${deployment.split(":")[0]}:...", not a dev deployment`;
}
