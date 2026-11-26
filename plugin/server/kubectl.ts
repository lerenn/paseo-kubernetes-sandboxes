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

export function connection(c: Pick<Configuration, "context" | "namespace">, bin = kubectlBinary()): Kubectl {
  return (args, input) =>
    new Promise((resolve, reject) => {
      const child = execFile(
        bin,
        [...(c.context ? ["--context", c.context] : []), "--namespace", c.namespace, "--request-timeout=20s", ...args],
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
