import { isConfigured, workspaceRoute, type Configuration, type Connection } from "../shared/settings.js";
import { getSandbox, profiles } from "./controller.js";

export async function checkRoutingChange(
  before: Configuration,
  after: Configuration,
  api = { status: getSandbox, profiles },
) {
  const ids = new Set([...before.workspaces, ...after.workspaces].map(({ id }) => id));
  await Promise.all([...ids].map(async (id) => {
    const oldRoute = workspaceRoute(before, id);
    const newRoute = workspaceRoute(after, id);
    if (oldRoute && newRoute &&
        oldRoute.workspace.connectionId === newRoute.workspace.connectionId &&
        oldRoute.workspace.profile === newRoute.workspace.profile &&
        oldRoute.workspace.privileged === newRoute.workspace.privileged &&
        sameConnection(oldRoute.connection, newRoute.connection)) return;

    if (oldRoute && isConfigured(oldRoute.connection) && await api.status(oldRoute.connection, id)) {
      throw new Error("Stop the existing sandbox and wait for its status to show No sandbox before changing its route.");
    }
    if (!newRoute) return;
    if (!isConfigured(newRoute.connection)) {
      if (oldRoute && !isConfigured(oldRoute.connection) && !newRoute.workspace.profile) return;
      throw new Error("Configure the selected controller connection before saving the workspace route.");
    }
    const profile = newRoute.workspace.profile;
    if (!profile) return;
    const allowed = (await api.profiles(newRoute.connection)).find(({ id }) => id === profile);
    if (!allowed) throw new Error("The selected profile is unavailable on this controller connection.");
    if (allowed.privileged !== newRoute.workspace.privileged) {
      const sameLegacyRoute = newRoute.workspace.privileged === undefined && oldRoute &&
        oldRoute.workspace.connectionId === newRoute.workspace.connectionId &&
        oldRoute.workspace.profile === profile &&
        (!allowed.privileged || sameConnection(oldRoute.connection, newRoute.connection));
      if (!sameLegacyRoute) throw new Error("Select the workspace profile again to confirm its current privilege level.");
    }
  }));
}

function sameConnection(a: Connection, b: Connection) {
  return a.controllerUrl === b.controllerUrl && a.tokenFile === b.tokenFile && a.caFile === b.caFile;
}
