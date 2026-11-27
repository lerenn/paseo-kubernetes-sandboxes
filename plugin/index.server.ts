import type { PluginServerContext } from "@getpaseo/plugin/server";
import { controllerCheck, executionOptions, prepareSettingsSave, sandboxStop, workspacesList, type SandboxState } from "./shared/contracts.js";
import { isConfigured, workspaceRoute, sandboxSettings, type Configuration } from "./shared/settings.js";
import { getSandbox, health, profiles, stopSandbox, type SandboxStatus } from "./server/controller.js";
import { checkController } from "./server/check.js";
import { wrapFor, type LaunchInput } from "./server/hooks.js";

import { executionChoice, executionKey, withWorkspaceExecution } from "./shared/execution.js";
import type { PaseoApi } from "@getpaseo/client";
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
  async function launch(input: LaunchInput, paseo: PaseoApi) {
    if (!input.workspaceId) return undefined;
    routingOperations++;
    try {
      if (save && save.expires > Date.now() && (await settings.read()).revision === save.revision) {
        throw new Error("Kubernetes Sandbox routing is being saved. Retry the launch.");
      }
      const config = await configuration();
      const id = input.workspaceId;
      if (config.workspaces.some((workspace) => workspace.id === id) || config.localWorkspaces.includes(id)) {
        return await wrapFor({ configuration: async () => config }, input);
      }
      const workspace = await paseo.workspaces.ref(id).refresh();
      if (!workspace) throw new Error("Kubernetes Sandbox could not read the workspace execution route.");
      const effective = withWorkspaceExecution(config, [workspace]);
      return await wrapFor({ configuration: async () => effective }, input);
    } finally {
      routingOperations--;
    }
  }

  server.handle(prepareSettingsSave, async ({ revision, values }, { paseo }) => {
    const current = await settings.read();
    if (current.revision !== revision) throw new Error("Settings changed. Try again.");
    if (routingOperations || (save?.revision === revision && save.expires > Date.now())) {
      throw new Error("Kubernetes Sandbox has another operation in progress. Try again.");
    }
    const pending = { revision, expires: Infinity };
    save = pending;
    try {
      if (current.status === "ready") {
        const { entries } = await paseo.workspaces.list({ includeBackground: true });
        await checkRoutingChange(
          withWorkspaceExecution(current.values, entries),
          withWorkspaceExecution(values, entries),
        );
      }
      pending.expires = Date.now() + 10_000;
      return {};
    } catch (error) {
      if (save === pending) save = undefined;
      throw error;
    }
  });

  server.handle(executionOptions, async () => {
    const config = await configuration();
    const localAllowed = !config.requireSandboxProfile;
    const gateway = config.connections.find(isConfigured);
    if (!gateway) return { localAllowed, profiles: [], error: "Configure the Gateway on this host." };
    try {
      const allowed = await profiles(gateway, 5_000);
      return {
        localAllowed, connectionId: gateway.id, profiles: allowed,
        ...(!allowed.length && { error: "This host’s Gateway credential has no authorized profiles." }),
      };
    } catch {
      return { localAllowed, profiles: [], error: "This host’s Gateway profiles are unavailable." };
    }
  });
  server.handle(controllerCheck, async (connection) => checkController(connection, { health, profiles }));
  server.handle(workspacesList, async (_, { paseo }) => {
    const c = await configuration();
    const list = await paseo.workspaces.list();
    const effective = withWorkspaceExecution(c, list.entries);
    const rows = await Promise.all(
      list.entries.map(async (w) => {
        const route = workspaceRoute(effective, w.id);
        const sandbox = route
          ? isConfigured(route.connection)
            ? await getSandbox(route.connection, w.id).then(state, () => "unknown" as const)
            : "unknown" as const
          : "absent" as const;
        const choice = executionChoice.safeParse(w.metadata?.[executionKey]);
        return {
          id: w.id, name: w.name, directory: w.workspaceDirectory ?? w.projectRootPath, sandbox,
          assignedProfile: route?.workspace.profile, assignedPrivilege: route?.workspace.privileged,
          assignedConnection: route?.connection.id, createdWithProfile: choice.success && choice.data !== "local",
        };
      }),
    );
    return { workspaces: rows };
  });
  server.handle(sandboxStop, async ({ workspaceId, revision }, { paseo }) => {
    routingOperations++;
    try {
      const current = await settings.read();
      if (current.status !== "ready" || current.revision !== revision ||
          (save?.revision === revision && save.expires > Date.now())) {
        throw new Error("Workspace routing changed or is being saved. Refresh and confirm the stop again.");
      }
      const workspace = await paseo.workspaces.ref(workspaceId).refresh();
      if (!workspace) throw new Error("Workspace is unavailable.");
      const route = workspaceRoute(withWorkspaceExecution(current.values, [workspace]), workspaceId);
      if (!route || !isConfigured(route.connection)) throw new Error("This workspace has no configured Gateway connection.");
      await stopSandbox(route.connection, workspaceId);
      return {};
    } finally {
      routingOperations--;
    }
  });

  const removers = [
    server.addHook("workspace.create.before", async ({ request }) => {
      const raw = request.metadata?.[executionKey];
      if (raw === undefined) return;
      const choice = executionChoice.safeParse(raw);
      if (!choice.success) throw new Error("Select a valid Execution option for this host.");
      const config = await configuration();
      if (choice.data === "local") {
        if (config.requireSandboxProfile) throw new Error("This host requires a sandbox profile. Select one in Execution.");
        return;
      }
      const { connectionId, profile, privileged } = choice.data;
      const gateway = config.connections.find((connection) => connection.id === connectionId && isConfigured(connection));
      if (!gateway) throw new Error("The selected Execution Gateway is unavailable on this host.");
      const allowed = await profiles(gateway, 5_000);
      if (!allowed.some((option) => option.id === profile && option.privileged === privileged)) {
        throw new Error("The selected Execution profile is unavailable or its privilege changed. Select it again.");
      }
    }),
    server.addHook("agent.open.before", async ({ request }, { paseo }) => {
      const wrap = await launch({
        workspaceId: request.workspaceId,
        cwd: request.cwd,
        env: request.env,
        wrap: request.wrap,
        allowUnassigned: request.purpose === "history",
      }, paseo);
      return wrap ? { ...request, wrap } : undefined;
    }),
    server.addHook("terminal.create.before", async ({ request }, { paseo }) => {
      const wrap = await launch({ workspaceId: request.workspaceId, cwd: request.cwd, env: request.env, wrap: request.wrap }, paseo);
      return wrap ? { ...request, wrap } : undefined;
    }),
    server.addHook("command.run.before", async ({ request }, { paseo }) => {
      const wrap = await launch({
        workspaceId: request.workspaceId,
        cwd: request.cwd,
        env: request.env,
        wrap: request.wrap,
        reuseOnly: request.purpose === "teardown",
      }, paseo);
      return wrap ? { ...request, wrap } : undefined;
    }),
    server.addHook("workspace.archive.after", async ({ workspace }) => {
      const route = workspaceRoute(withWorkspaceExecution(await configuration(), [workspace]), workspace.id);
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
