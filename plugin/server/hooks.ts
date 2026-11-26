import { modeOf, optedIn, type Configuration } from "../shared/settings.js";
import { podName } from "../shared/sandbox.js";
import { ensurePod, listPods, podCwd } from "./pods.js";
import { resolveRepo, type RepoInfo } from "./repo.js";
import type { Kubectl } from "./kubectl.js";
import { buildWrap, forwardableEnv, type Wrap } from "./launch.js";

export type HookDeps = {
  configuration(): Promise<Configuration>;
  kubectl(c: Configuration): Kubectl;
  launcher?: string;
  repo?(cwd: string): Promise<RepoInfo>;
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
  if (!optedIn(c, input.workspaceId)) return undefined;
  // A wrap from another plugin wins: Paseo rejects two different wraps.
  if (input.wrap) return undefined;
  let pod: string;
  const mode = modeOf(c, input.workspaceId);
  let repo: RepoInfo;
  try {
    repo = await (deps.repo ?? resolveRepo)(input.cwd);
  } catch (e) {
    throw new Error(`Kubernetes Sandbox could not read the workspace repository: ${e instanceof Error ? e.message : "unknown error"}`);
  }
  try {
    if (input.reuseOnly) {
      const name = podName(input.workspaceId);
      if (!(await listPods(deps.kubectl(c))).some((p) => p.name === name && p.ready)) return undefined;
      pod = name;
    } else {
      pod = await withTimeout(
        ensurePod(deps.kubectl(c), c, input.workspaceId, repo),
        deps.startTimeoutMs ?? 25_000,
        "The sandbox pod is still starting. Try again in a moment.",
      );
    }
  } catch (e) {
    // Fail the launch: running unwrapped would silently leave the sandbox.
    throw new Error(`Kubernetes Sandbox could not start the pod: ${e instanceof Error ? e.message : "unknown error"}`);
  }
  return buildWrap(c, pod, {
    cwd: podCwd(c, mode, repo, input.cwd),
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
