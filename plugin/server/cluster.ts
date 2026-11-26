import type { Configuration } from "../shared/settings.js";
import { KubernetesError, type Kubectl } from "./kubectl.js";
import { configError } from "./pods.js";
import { SSH_SECRET_NAME } from "../shared/sandbox.js";
import { sshConfigured } from "./ssh.js";

export type Check = { id: string; label: string; status: "ok" | "warn" | "fail" | "unknown"; detail: string };

const RBAC: [string, string][] = [
  ["create", "pods"],
  ["get", "pods"],
  ["list", "pods"],
  ["delete", "pods"],
  ["create", "pods/exec"],
  ["get", "pods/log"],
  ["get", "persistentvolumeclaims"],
  ["create", "persistentvolumeclaims"],
  ["delete", "persistentvolumeclaims"],
  ["list", "persistentvolumeclaims"],
];

// Checks the setup using only the namespace Role of config/plugin-rbac.yaml (and the local kubectl).
export async function checkCluster(
  c: Configuration,
  run: Kubectl,
  version: () => Promise<string>,
): Promise<{ context: string; namespace: string; checks: Check[] }> {
  const checks: Check[] = [];
  let context = c.context;
  try {
    const v = await version();
    checks.push({ id: "kubectl", label: "kubectl installed", status: "ok", detail: v });
  } catch {
    checks.push({ id: "kubectl", label: "kubectl installed", status: "fail", detail: "kubectl was not found on the daemon host." });
    return { context, namespace: c.namespace, checks };
  }
  if (!context) {
    try {
      context = (await run(["config", "current-context"])).trim();
    } catch {
      context = "in-cluster / default";
    }
  }
  const missing: string[] = [];
  let reachable = true;
  // Secret rights are only needed with Git over SSH. `auth can-i` answers yes/no; no Secret is ever read.
  const rights: [string, string][] = sshConfigured(c)
    ? [...RBAC, ["create", "secrets"] as [string, string], ...["get", "update", "patch", "delete"].map((v): [string, string] => [v, `secrets/${SSH_SECRET_NAME}`])]
    : RBAC;
  for (const [verb, resource] of rights) {
    try {
      const answer = (await run(["auth", "can-i", verb, resource])).trim();
      if (answer !== "yes") missing.push(`${verb} ${resource}`);
    } catch (e) {
      // `auth can-i` prints "no" and exits non-zero when access is denied.
      if (e instanceof KubernetesError && (e.stdout.trim() === "no" || e.reason === "forbidden")) missing.push(`${verb} ${resource}`);
      else reachable = false;
    }
  }
  checks.push(
    !reachable
      ? { id: "cluster", label: "Cluster reachable", status: "fail", detail: "kubectl could not reach the cluster. Check the context and your credentials." }
      : { id: "cluster", label: "Cluster reachable", status: "ok", detail: `${context} · ${c.namespace}` },
  );
  if (reachable)
    checks.push(
      missing.length
        ? { id: "rbac", label: "RBAC", status: "fail", detail: `Missing: ${missing.join(", ")}. Apply config/plugin-rbac.yaml and bind it to your identity.` }
        : { id: "rbac", label: "RBAC", status: "ok", detail: "The Role grants everything the plugin needs." },
    );
  const problem = configError(c);
  if (c.worktree.claimName && reachable) {
    try {
      await run(["get", "persistentvolumeclaim", c.worktree.claimName, "-o", "name"]);
      checks.push({ id: "volume", label: "Worktree volume", status: "ok", detail: `PVC ${c.worktree.claimName} found.` });
    } catch (e) {
      checks.push({
        id: "volume",
        label: "Worktree volume",
        status: "fail",
        detail: e instanceof KubernetesError && e.reason === "missing" ? `PVC ${c.worktree.claimName} does not exist in ${c.namespace}.` : "The PVC could not be read.",
      });
    }
  }
  checks.push(
    problem
      ? { id: "settings", label: "Settings", status: "fail", detail: problem }
      : { id: "settings", label: "Settings", status: "ok", detail: "Image, volume claim and mount path are set." },
  );
  return { context, namespace: c.namespace, checks };
}
