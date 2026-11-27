import { isConfigured, profileRequiredMessage, workspaceRoute, type Configuration } from "../shared/settings.js";
import { ensureSandbox, getSandbox, profiles } from "./controller.js";
import { resolveRepo, type RepoInfo } from "./repo.js";
import { buildWrap, forwardableEnv, type Wrap } from "./launch.js";

export type HookDeps = {
  configuration(): Promise<Configuration>;
  repo?(cwd: string): Promise<RepoInfo>;
  ensure?: typeof ensureSandbox;
  status?: typeof getSandbox;
  profiles?: typeof profiles;
  // Paseo gives hooks 30 seconds; stop waiting for a starting sandbox before that.
  startTimeoutMs?: number;
};

export type LaunchInput = {
  workspaceId: string | null;
  cwd: string;
  env: Record<string, string>;
  wrap?: readonly string[];
  allowUnassigned?: boolean;
  // Never create a sandbox for this launch (worktree teardown after the workspace was archived).
  reuseOnly?: boolean;
};

// Returns the wrap for an opted-in workspace, creating its sandbox if needed. `undefined` means run locally.
export async function wrapFor(deps: HookDeps, input: LaunchInput): Promise<Wrap | undefined> {
  if (!input.workspaceId) return undefined;
  const config = await deps.configuration();
  const route = workspaceRoute(config, input.workspaceId);
  if (!route) {
    if (config.requireSandboxProfile && !input.allowUnassigned && !input.reuseOnly) {
      throw new Error(profileRequiredMessage);
    }
    return undefined;
  }
  if (input.wrap) {
    throw new Error("Another plugin selected a launch wrapper. Remove the conflicting wrapper and retry.");
  }
  const { workspace, connection } = route;
  if (!isConfigured(connection)) throw new Error("Verify and save the Gateway connection in Kubernetes Sandbox before launching this assigned workspace.");
  if (!workspace.profile) throw new Error("Choose a profile for this workspace in Kubernetes Sandbox.");
  const privileged = workspace.privileged ?? (config.requireSandboxProfile ? false : undefined);
  const deadline = Date.now() + (deps.startTimeoutMs ?? 25_000);
  let repo: RepoInfo;
  try {
    repo = await (deps.repo ?? resolveRepo)(input.cwd);
  } catch (e) {
    throw new Error(`Kubernetes Sandbox could not read the workspace repository: ${e instanceof Error ? e.message : "unknown error"}`);
  }
  try {
    if (workspace.privileged !== undefined || config.requireSandboxProfile) {
      const allowed = (await (deps.profiles ?? profiles)(connection, Math.min(5_000, Math.max(1, deadline - Date.now())))).find(({ id }) => id === workspace.profile);
      if (!allowed || allowed.privileged !== (workspace.privileged ?? false)) {
        throw new Error("The saved profile is unavailable or its privilege level changed. Select an authorized profile in Kubernetes Sandbox → Workspaces.");
      }
    }
    if (input.reuseOnly) {
      const sandbox = await (deps.status ?? getSandbox)(connection, input.workspaceId);
      if (!sandbox?.ready || sandbox.deleting || sandbox.profile !== workspace.profile) return undefined;
    } else {
      const target = { ...connection, profile: workspace.profile };
      await (deps.ensure ?? ensureSandbox)(
        privileged === undefined ? target : { ...target, privileged },
        input.workspaceId, { root: repo.root, gitDir: repo.gitDir }, { timeoutMs: deadline - Date.now() },
      );
    }
  } catch (e) {
    // Fail the launch: running unwrapped would silently leave the sandbox.
    throw new Error(`Kubernetes Sandbox could not start the sandbox: ${e instanceof Error ? e.message : "unknown error"}`);
  }
  return buildWrap(connection, input.workspaceId, {
    profile: workspace.profile,
    privileged,
    cwd: input.cwd,
    envNames: forwardableEnv(input.env),
  });
}
