import { execFile } from "node:child_process";
import type { Configuration } from "../shared/settings.js";

export class KubernetesError extends Error {
  constructor(
    public readonly reason: "missing" | "forbidden" | "unavailable",
    public readonly stdout = "",
  ) {
    super(
      reason === "missing"
        ? "Kubernetes resource not found."
        : reason === "forbidden"
          ? "Kubernetes access denied. Apply config/plugin-rbac.yaml and bind it to the identity kubectl uses."
          : "Kubernetes request failed. Check kubectl, context, namespace and cluster connectivity.",
    );
  }
}

export type Kubectl = (args: string[], input?: unknown) => Promise<string>;
export const kubectlBinary = () => process.env.PASEO_SANDBOX_KUBECTL || "kubectl";

// `--kubeconfig` (not the KUBECONFIG variable): it is explicit, takes precedence over any KUBECONFIG in the daemon's
// environment, and cannot be turned into a colon-separated list by a path containing ":". No shell is involved.
export const kubeconfigArgs = (c: { kubeconfigFile?: string }) => (c.kubeconfigFile ? ["--kubeconfig", c.kubeconfigFile] : []);

export function connection(c: Pick<Configuration, "context" | "namespace"> & { kubeconfigFile?: string }, bin = kubectlBinary()): Kubectl {
  return (args, input) =>
    new Promise((resolve, reject) => {
      const child = execFile(
        bin,
        [...kubeconfigArgs(c), ...(c.context ? ["--context", c.context] : []), "--namespace", c.namespace, "--request-timeout=20s", ...args],
        { timeout: 150_000, maxBuffer: 4 * 1024 * 1024 },
        (error, stdout, stderr) => {
          // Never return kubectl stderr: it can echo manifests and Secret payloads.
          if (error)
            reject(
              new KubernetesError(
                /\bNotFound\b|\bnot found\b|doesn.t have a resource type/i.test(stderr)
                  ? "missing"
                  : /Forbidden|Unauthorized/i.test(stderr)
                    ? "forbidden"
                    : "unavailable",
                stdout,
              ),
            );
          else resolve(stdout);
        },
      );
      child.stdin?.on("error", () => {});
      child.stdin?.end(input === undefined ? undefined : JSON.stringify(input));
    });
}

// Contexts of the configured kubeconfig (names only, read-only). Empty when kubectl cannot read it.
export function listContexts(c: { kubeconfigFile?: string }, bin = kubectlBinary()): Promise<string[]> {
  return new Promise((resolve) =>
    execFile(bin, [...kubeconfigArgs(c), "config", "get-contexts", "-o", "name"], { timeout: 10_000, maxBuffer: 1024 * 1024 }, (error, stdout) =>
      resolve(error ? [] : stdout.split("\n").map((l) => l.trim()).filter(Boolean)),
    ),
  );
}
