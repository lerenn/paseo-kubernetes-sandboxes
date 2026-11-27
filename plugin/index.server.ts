import type { PluginServerContext } from "@getpaseo/plugin/server";
import { controllerCheck, sandboxStop, workspacesList, type SandboxState } from "./shared/contracts.js";
import { isConfigured, optedIn, sandboxSettings, settingsSchema, type Configuration } from "./shared/settings.js";
import { getSandbox, health, profiles, stopSandbox, type SandboxStatus } from "./server/controller.js";
import { checkController } from "./server/check.js";
import { wrapFor, type HookDeps } from "./server/hooks.js";

function state(sandbox: SandboxStatus): SandboxState {
  if (!sandbox) return "absent";
  if (sandbox.deleting) return "stopping";
  if (sandbox.phase === "Failed" || sandbox.phase === "Succeeded") return "failed";
  return sandbox.ready ? "running" : "starting";
}

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(sandboxSettings);
  async function configuration(): Promise<Configuration> {
    const result = await settings.read();
    if (result.status !== "ready") throw new Error("Kubernetes Sandbox settings are invalid. Open Kubernetes Sandbox to fix them.");
    return settingsSchema.parse(result.values);
  }
  const deps: HookDeps = { configuration };

  server.handle(controllerCheck, async (connection) => checkController(connection, { health, profiles }));
  server.handle(workspacesList, async (_, { paseo }) => {
    const c = await configuration();
    const list = await paseo.workspaces.list();
    const rows = await Promise.all(
      list.entries.map(async (w) => {
        const on = optedIn(c, w.id);
        const sandbox = on && isConfigured(c) ? await getSandbox(c, w.id).then(state, () => "unknown" as const) : "absent" as const;
        return { id: w.id, name: w.name, directory: w.workspaceDirectory ?? w.projectRootPath, optedIn: on, sandbox };
      }),
    );
    return { workspaces: rows };
  });
  server.handle(sandboxStop, async ({ workspaceId }) => {
    const c = await configuration();
    await stopSandbox(c, workspaceId);
    return {};
  });

  const removers = [
    server.addHook("agent.open.before", async ({ request }) => {
      const wrap = await wrapFor(deps, { workspaceId: request.workspaceId, cwd: request.cwd, env: request.env, wrap: request.wrap });
      return wrap ? { ...request, wrap } : undefined;
    }),
    server.addHook("terminal.create.before", async ({ request }) => {
      const wrap = await wrapFor(deps, { workspaceId: request.workspaceId, cwd: request.cwd, env: request.env, wrap: request.wrap });
      return wrap ? { ...request, wrap } : undefined;
    }),
    server.addHook("command.run.before", async ({ request }) => {
      const wrap = await wrapFor(deps, {
        workspaceId: request.workspaceId,
        cwd: request.cwd,
        env: request.env,
        wrap: request.wrap,
        reuseOnly: request.purpose === "teardown",
      });
      return wrap ? { ...request, wrap } : undefined;
    }),
    server.addHook("workspace.archive.after", async ({ workspace }) => {
      const c = await configuration();
      if (!optedIn(c, workspace.id) || !isConfigured(c)) return;
      await stopSandbox(c, workspace.id).catch(() => {
        console.error("Kubernetes Sandbox could not delete the sandbox of an archived workspace; the idle timeout will remove it.");
      });
    }),
  ];
  return () => {
    for (const remove of removers) remove();
  };
}
