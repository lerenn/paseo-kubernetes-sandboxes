import { isConfigured, needsGatewayMigration, workspaceRoute, type Configuration, type Connection } from "../shared/settings.js";
import { getSandbox, health, profiles } from "./controller.js";

export async function checkRoutingChange(
  before: Configuration,
  after: Configuration,
  api = { status: getSandbox, health, profiles },
) {
  const migrating = needsGatewayMigration(before);
  if (after.connections.length > 1 || needsGatewayMigration(after)) {
    throw new Error("Save one Gateway connection for this Paseo host.");
  }
  const gateway = after.connections[0];
  const previous = before.connections[0];
  const changed = gateway && (!previous || migrating || !sameConnection(previous, gateway));
  if (changed && !isConfigured(gateway)) throw new Error("Enter the Gateway URL and token file.");
  const discover = async () => {
    if (!gateway) throw new Error("Configure the Gateway connection before saving a workspace route.");
    await api.health(gateway);
    const authorized = await api.profiles(gateway);
    if (!authorized.length) throw new Error("The Gateway credential has no authorized profiles.");
    return authorized;
  };
  const authorized = changed ? await discover() : undefined;
  if (migrating) {
    if (!gateway || before.workspaces.length !== after.workspaces.length || before.requireSandboxProfile !== after.requireSandboxProfile) {
      throw new Error("Migrate the existing workspace assignments together to the verified Gateway.");
    }
    for (const saved of before.workspaces) {
      const next = after.workspaces.find(({ id }) => id === saved.id);
      if (!next || next.profile !== saved.profile || next.connectionId !== gateway.id) {
        throw new Error("Migration must preserve every saved workspace and profile alias.");
      }
      if (!saved.profile) continue;
      const profile = authorized?.find(({ id }) => id === saved.profile);
      const privilege = saved.privileged ?? (saved.profile === "docker");
      if (!profile || profile.privileged !== privilege || next.privileged !== privilege) {
        throw new Error(`Gateway migration requires the saved profile and privilege for "${saved.profile}".`);
      }
    }
    return;
  }

  let discovery: ReturnType<typeof discover> | undefined;
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
      throw new Error("Configure the Gateway connection before saving the workspace route.");
    }
    const profile = newRoute.workspace.profile;
    if (!profile) return;
    const allowed = (authorized ?? await (discovery ??= discover())).find(({ id }) => id === profile);
    if (!allowed) throw new Error("The selected profile is unavailable through this Gateway.");
    if (allowed.privileged !== newRoute.workspace.privileged) {
      throw new Error("Select the workspace profile again to confirm its current privilege level.");
    }
  }));
}

function sameConnection(a: Connection, b: Connection) {
  return a.controllerUrl === b.controllerUrl && a.tokenFile === b.tokenFile && a.caFile === b.caFile;
}
