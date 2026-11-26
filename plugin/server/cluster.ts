import { stat } from "node:fs/promises";
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

// Why a kubeconfig path cannot be used, or null. Looks at the path only; the file is never read here.
export async function kubeconfigProblem(path: string, status: (p: string) => Promise<{ isFile(): boolean }> = stat): Promise<string | null> {
  try {
    return (await status(path)).isFile() ? null : `The kubeconfig path ${path} is not a file.`;
  } catch {
    return `The kubeconfig file ${path} does not exist or is not readable on the daemon host.`;
  }
}

// Checks the setup using only the namespace Role of config/plugin-rbac.yaml (and the local kubectl).
export async function checkCluster(
  c: Configuration,
  run: Kubectl,
  version: () => Promise<string>,
  kubeconfig: (path: string) => Promise<string | null> = kubeconfigProblem,
): Promise<{ context: string; namespace: string; kubeconfigFile: string; checks: Check[] }> {
  const checks: Check[] = [];
  let context = c.context;
  try {
    const v = await version();
    checks.push({ id: "kubectl", label: "kubectl installed", status: "ok", detail: v });
  } catch {
    checks.push({ id: "kubectl", label: "kubectl installed", status: "fail", detail: "kubectl was not found on the daemon host." });
    return { context, namespace: c.namespace, kubeconfigFile: c.kubeconfigFile, checks };
  }
  if (c.kubeconfigFile) {
    const problem = await kubeconfig(c.kubeconfigFile);
    if (problem) {
      checks.push({ id: "kubeconfig", label: "kubeconfig file", status: "fail", detail: problem });
      return { context: c.context, namespace: c.namespace, kubeconfigFile: c.kubeconfigFile, checks };
    }
    checks.push({ id: "kubeconfig", label: "kubeconfig file", status: "ok", detail: `Using ${c.kubeconfigFile}` });
  }
  if (!context) {
    try {
      context = (await run(["config", "current-context"])).trim();
    } catch {
      context = "in-cluster / default";
    }
  }
  const missing: string[] = [];
  const missingSecrets: string[] = [];
  let reachable = true;
  // Secret rights are only needed with Git over SSH. `auth can-i` answers yes/no; no Secret is ever read.
  const rights: [string, string][] = sshConfigured(c)
    ? [...RBAC, ["create", "secrets"] as [string, string], ...["get", "update", "patch", "delete"].map((v): [string, string] => [v, `secrets/${SSH_SECRET_NAME}`])]
    : RBAC;
  for (const [verb, resource] of rights) {
    try {
      const answer = (await run(["auth", "can-i", verb, resource])).trim();
      if (answer !== "yes") (resource.startsWith("secrets") ? missingSecrets : missing).push(`${verb} ${resource}`);
    } catch (e) {
      // `auth can-i` prints "no" and exits non-zero when access is denied.
      if (e instanceof KubernetesError && (e.stdout.trim() === "no" || e.reason === "forbidden"))
        (resource.startsWith("secrets") ? missingSecrets : missing).push(`${verb} ${resource}`);
      else reachable = false;
    }
  }
  checks.push(
    !reachable
      ? { id: "cluster", label: "Cluster reachable", status: "fail", detail: "kubectl could not reach the cluster. Check the context and your credentials." }
      : { id: "cluster", label: "Cluster reachable", status: "ok", detail: `${context} · ${c.namespace}${c.kubeconfigFile ? ` · kubeconfig ${c.kubeconfigFile}` : ""}` },
  );
  if (reachable)
    checks.push(
      missing.length
        ? { id: "rbac", label: "RBAC", status: "fail", detail: `Missing: ${missing.join(", ")}. Apply config/plugin-rbac.yaml and bind it to your identity.` }
        : { id: "rbac", label: "RBAC", status: "ok", detail: "The Role grants everything the plugin needs." },
    );
  // Same `auth can-i` answers as above, reported on their own so the screen can tell pod rights from Secret rights.
  if (reachable && sshConfigured(c))
    checks.push(
      missingSecrets.length
        ? { id: "secrets", label: "Secret rights (Git over SSH)", status: "fail", detail: `Missing: ${missingSecrets.join(", ")}. Apply config/plugin-rbac.yaml and bind it to your identity.` }
        : { id: "secrets", label: "Secret rights (Git over SSH)", status: "ok", detail: `The Role grants the rights on the ${SSH_SECRET_NAME} Secret.` },
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
  return { context, namespace: c.namespace, kubeconfigFile: c.kubeconfigFile, checks };
}
