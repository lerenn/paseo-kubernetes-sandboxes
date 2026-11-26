import type { Configuration } from "../shared/settings.js";
import { podName } from "../shared/sandbox.js";
import { ensurePod, listPods } from "./pods.js";
import type { Kubectl } from "./kubectl.js";
import { buildWrap, forwardableEnv, type Wrap } from "./launch.js";

export type HookDeps = {
  configuration(): Promise<Configuration>;
  kubectl(c: Configuration): Kubectl;
  launcher?: string;
  // Paseo gives hooks 30 seconds; stop waiting for a starting pod before that.
  startTimeoutMs?: number;
};

export type LaunchInput = {
  workspaceId: string | null;
  cwd: string;
  env: Record<string, string>;
  wrap?: readonly string[];
  // Never create a pod for this launch (worktree teardown after the workspace was archived).
  reuseOnly?: boolean;
};

// Returns the wrap for an opted-in workspace, creating its pod if needed. `undefined` means run locally.
export async function wrapFor(deps: HookDeps, input: LaunchInput): Promise<Wrap | undefined> {
  if (!input.workspaceId) return undefined;
  const c = await deps.configuration();
  if (!c.workspaces.includes(input.workspaceId)) return undefined;
  // A wrap from another plugin wins: Paseo rejects two different wraps.
  if (input.wrap) return undefined;
  let pod: string;
  try {
    if (input.reuseOnly) {
      const name = podName(input.workspaceId);
      if (!(await listPods(deps.kubectl(c))).some((p) => p.name === name && p.ready)) return undefined;
      pod = name;
    } else {
      pod = await withTimeout(
        ensurePod(deps.kubectl(c), c, input.workspaceId),
        deps.startTimeoutMs ?? 25_000,
        "The sandbox pod is still starting. Try again in a moment.",
      );
    }
  } catch (e) {
    // Fail the launch: running unwrapped would silently leave the sandbox.
    throw new Error(`Kubernetes Sandbox could not start the pod: ${e instanceof Error ? e.message : "unknown error"}`);
  }
  return buildWrap(c, pod, {
    cwd: input.cwd,
    envNames: forwardableEnv(input.env),
    ...(deps.launcher ? { launcher: deps.launcher } : {}),
  });
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
