import { isConfigured, type Configuration } from "../shared/settings.js";
import { ensureSandbox, getSandbox } from "./controller.js";
import { resolveRepo, type RepoInfo } from "./repo.js";
import { buildWrap, forwardableEnv, type Wrap } from "./launch.js";

export type HookDeps = {
  configuration(): Promise<Configuration>;
  repo?(cwd: string): Promise<RepoInfo>;
  ensure?: typeof ensureSandbox;
  status?: typeof getSandbox;
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
  const c = await deps.configuration();
  const workspace = c.workspaces.find(({ id }) => id === input.workspaceId);
  if (!workspace) return undefined;
  // A wrap from another plugin wins: Paseo rejects two different wraps.
  if (input.wrap) return undefined;
  if (!isConfigured(c)) throw new Error("Set the controller URL and token file in Kubernetes Sandbox.");
  if (!workspace.profile) throw new Error("Choose a profile for this workspace in Kubernetes Sandbox.");
  let repo: RepoInfo;
  try {
    repo = await (deps.repo ?? resolveRepo)(input.cwd);
  } catch (e) {
    throw new Error(`Kubernetes Sandbox could not read the workspace repository: ${e instanceof Error ? e.message : "unknown error"}`);
  }
  try {
    if (input.reuseOnly) {
      const sandbox = await (deps.status ?? getSandbox)(c, input.workspaceId);
      if (!sandbox?.ready || sandbox.deleting || sandbox.profile !== workspace.profile) return undefined;
    } else {
      await (deps.ensure ?? ensureSandbox)({ ...c, profile: workspace.profile }, input.workspaceId, { root: repo.root, gitDir: repo.gitDir }, { timeoutMs: deps.startTimeoutMs ?? 25_000 });
    }
  } catch (e) {
    // Fail the launch: running unwrapped would silently leave the sandbox.
    throw new Error(`Kubernetes Sandbox could not start the sandbox: ${e instanceof Error ? e.message : "unknown error"}`);
  }
  return buildWrap(c, input.workspaceId, {
    cwd: input.cwd,
    envNames: forwardableEnv(input.env),
  });
}
