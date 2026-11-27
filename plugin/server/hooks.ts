import { isConfigured, workspaceRoute, type Configuration } from "../shared/settings.js";
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
  // Never create a sandbox for this launch (worktree teardown after the workspace was archived).
  reuseOnly?: boolean;
};

// Returns the wrap for an opted-in workspace, creating its sandbox if needed. `undefined` means run locally.
export async function wrapFor(deps: HookDeps, input: LaunchInput): Promise<Wrap | undefined> {
  if (!input.workspaceId) return undefined;
  const route = workspaceRoute(await deps.configuration(), input.workspaceId);
  if (!route) return undefined;
  const { workspace, connection } = route;
  // A wrap from another plugin wins: Paseo rejects two different wraps.
  if (input.wrap) return undefined;
  if (!isConfigured(connection)) throw new Error("Set the controller URL and token file in Kubernetes Sandbox.");
  if (!workspace.profile) throw new Error("Choose a profile for this workspace in Kubernetes Sandbox.");
  const deadline = Date.now() + (deps.startTimeoutMs ?? 25_000);
  let repo: RepoInfo;
  try {
    repo = await (deps.repo ?? resolveRepo)(input.cwd);
  } catch (e) {
    throw new Error(`Kubernetes Sandbox could not read the workspace repository: ${e instanceof Error ? e.message : "unknown error"}`);
  }
  try {
    if (workspace.privileged !== undefined) {
      const allowed = (await (deps.profiles ?? profiles)(connection, Math.min(5_000, Math.max(1, deadline - Date.now())))).find(({ id }) => id === workspace.profile);
      if (allowed?.privileged !== workspace.privileged) {
        throw new Error("The saved profile is unavailable or its privilege level changed. Select it again.");
      }
    }
    if (input.reuseOnly) {
      const sandbox = await (deps.status ?? getSandbox)(connection, input.workspaceId);
      if (!sandbox?.ready || sandbox.deleting || sandbox.profile !== workspace.profile) return undefined;
    } else {
      const target = { ...connection, profile: workspace.profile };
      await (deps.ensure ?? ensureSandbox)(
        workspace.privileged === undefined ? target : { ...target, privileged: workspace.privileged },
        input.workspaceId, { root: repo.root, gitDir: repo.gitDir }, { timeoutMs: deadline - Date.now() },
      );
    }
  } catch (e) {
    // Fail the launch: running unwrapped would silently leave the sandbox.
    throw new Error(`Kubernetes Sandbox could not start the sandbox: ${e instanceof Error ? e.message : "unknown error"}`);
  }
  return buildWrap(connection, input.workspaceId, {
    profile: workspace.profile,
    privileged: workspace.privileged,
    cwd: input.cwd,
    envNames: forwardableEnv(input.env),
  });
}
