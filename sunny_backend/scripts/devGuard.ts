import { parse } from "dotenv";

export type EnvSource = Record<string, string | undefined>;

export function readEnvFile(text: string): EnvSource {
  return parse(text);
}

function effective(sources: EnvSource[], name: string): string | undefined {
  for (const source of sources) {
    const value = source[name];
    if (value !== undefined && value !== "") return value;
  }
  return undefined;
}

export function deploymentProblem(sources: EnvSource[]): string | null {
  for (const keyName of ["CONVEX_DEPLOY_KEY", "CONVEX_DEPLOYMENT_TOKEN"]) {
    const deployKey = effective(sources, keyName);
    if (deployKey === undefined) continue;
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
