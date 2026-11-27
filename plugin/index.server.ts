import type { PluginServerContext } from "@getpaseo/plugin/server";
import { controllerCheck, prepareSettingsSave, sandboxStop, workspacesList, type SandboxState } from "./shared/contracts.js";
import { isConfigured, workspaceRoute, sandboxSettings, type Configuration } from "./shared/settings.js";
import { getSandbox, health, profiles, stopSandbox, type SandboxStatus } from "./server/controller.js";
import { checkController } from "./server/check.js";
import { wrapFor, type LaunchInput } from "./server/hooks.js";

import { checkRoutingChange } from "./server/routing.js";

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
    return result.values;
  }
  // Hold launches until the settings write changes the revision or the client disappears.
  let save: { revision: string; expires: number } | undefined;
  let routingOperations = 0;
  async function launch(input: LaunchInput) {
    if (!input.workspaceId) return undefined;
    routingOperations++;
    try {
      if (save && save.expires > Date.now() && (await settings.read()).revision === save.revision) {
        throw new Error("Kubernetes Sandbox routing is being saved. Retry the launch.");
      }
      return await wrapFor({ configuration }, input);
    } finally {
      routingOperations--;
    }
  }

  server.handle(prepareSettingsSave, async ({ revision, values }) => {
    const current = await settings.read();
    if (current.revision !== revision) throw new Error("Settings changed. Try again.");
    if (routingOperations || (save?.revision === revision && save.expires > Date.now())) {
      throw new Error("Kubernetes Sandbox has another operation in progress. Try again.");
    }
    const pending = { revision, expires: Infinity };
    save = pending;
    try {
      if (current.status === "ready") await checkRoutingChange(current.values, values);
      pending.expires = Date.now() + 10_000;
      return {};
    } catch (error) {
      if (save === pending) save = undefined;
      throw error;
    }
  });

  server.handle(controllerCheck, async (connection) => checkController(connection, { health, profiles }));
  server.handle(workspacesList, async (_, { paseo }) => {
    const c = await configuration();
    const list = await paseo.workspaces.list();
    const rows = await Promise.all(
      list.entries.map(async (w) => {
        const route = workspaceRoute(c, w.id);
        const sandbox = route && isConfigured(route.connection)
          ? await getSandbox(route.connection, w.id).then(state, () => "unknown" as const)
          : "absent" as const;
        return { id: w.id, name: w.name, directory: w.workspaceDirectory ?? w.projectRootPath, sandbox };
      }),
    );
    return { workspaces: rows };
  });
  server.handle(sandboxStop, async ({ workspaceId, revision }) => {
    routingOperations++;
    try {
      const current = await settings.read();
      if (current.status !== "ready" || current.revision !== revision ||
          (save?.revision === revision && save.expires > Date.now())) {
        throw new Error("Workspace routing changed or is being saved. Refresh and confirm the stop again.");
      }
      const route = workspaceRoute(current.values, workspaceId);
      if (!route || !isConfigured(route.connection)) throw new Error("This workspace has no configured controller connection.");
      await stopSandbox(route.connection, workspaceId);
      return {};
    } finally {
      routingOperations--;
    }
  });

  const removers = [
    server.addHook("agent.open.before", async ({ request }) => {
      const wrap = await launch({
        workspaceId: request.workspaceId,
        cwd: request.cwd,
        env: request.env,
        wrap: request.wrap,
        allowUnassigned: request.purpose === "history",
      });
      return wrap ? { ...request, wrap } : undefined;
    }),
    server.addHook("terminal.create.before", async ({ request }) => {
      const wrap = await launch({ workspaceId: request.workspaceId, cwd: request.cwd, env: request.env, wrap: request.wrap });
      return wrap ? { ...request, wrap } : undefined;
    }),
    server.addHook("command.run.before", async ({ request }) => {
      const wrap = await launch({
        workspaceId: request.workspaceId,
        cwd: request.cwd,
        env: request.env,
        wrap: request.wrap,
        reuseOnly: request.purpose === "teardown",
      });
      return wrap ? { ...request, wrap } : undefined;
    }),
    server.addHook("workspace.archive.after", async ({ workspace }) => {
      const route = workspaceRoute(await configuration(), workspace.id);
      if (!route || !isConfigured(route.connection)) return;
      await stopSandbox(route.connection, workspace.id).catch(() => {
        console.error("Kubernetes Sandbox could not delete the sandbox of an archived workspace; the idle timeout will remove it.");
      });
    }),
  ];
  return () => {
    for (const remove of removers) remove();
  };
}
