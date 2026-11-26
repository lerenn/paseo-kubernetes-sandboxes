import type { PaseoApi } from "@getpaseo/client";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { execFile } from "node:child_process";
import { clusterCheck, podsDelete, podsList, podsLogs, workspacesList } from "./shared/contracts.js";
import { sandboxSettings, settingsSchema, type Configuration } from "./shared/settings.js";
import { podName } from "./shared/sandbox.js";
import { connection, kubectlBinary } from "./server/kubectl.js";
import { checkCluster } from "./server/cluster.js";
import { deletePod, listPodsWithUsage, podLogs, sweep } from "./server/pods.js";
import { wrapFor, type HookDeps } from "./server/hooks.js";

const SWEEP_MS = 60_000;

const clientVersion = () =>
  new Promise<string>((resolve, reject) =>
    execFile(kubectlBinary(), ["version", "--client", "-o", "json"], { timeout: 10_000 }, (error, stdout) => {
      if (error) return reject(error);
      try {
        resolve(String(JSON.parse(stdout).clientVersion?.gitVersion ?? "kubectl"));
      } catch {
        resolve("kubectl");
      }
    }),
  );

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(sandboxSettings);
  async function configuration(): Promise<Configuration> {
    const state = await settings.read();
    if (state.status !== "ready") throw new Error("Kubernetes Sandbox settings are invalid. Open Kubernetes Sandbox to fix them.");
    return settingsSchema.parse(state.values);
  }
  const deps: HookDeps = { configuration, kubectl: (c) => connection(c) };

  // The daemon API is only handed to hooks and RPC handlers: remember it for the background sweep.
  let active: PaseoApi | undefined;
  let swept = false;
  const attach = (paseo: PaseoApi) => {
    active = paseo;
  };
  async function knownWorkspaces(paseo: PaseoApi) {
    const list = await paseo.workspaces.list();
    return new Set(list.entries.map((w) => w.id));
  }
  async function runSweep() {
    if (!active) return;
    const c = await configuration();
    // First sweep after the plugin starts also removes pods of workspaces that no longer exist.
    const known = swept ? undefined : await knownWorkspaces(active);
    await sweep(connection(c), c, known ? { knownWorkspaces: known } : {});
    swept = true;
  }
  let sweeping = false;
  const timer = setInterval(() => {
    if (sweeping) return;
    sweeping = true;
    runSweep()
      .catch(() => console.error("Kubernetes Sandbox sweep failed; check kubectl access. Retrying."))
      .finally(() => (sweeping = false));
  }, SWEEP_MS);
  timer.unref();

  server.handle(clusterCheck, async (_, { paseo }) => {
    attach(paseo);
    const c = await configuration();
    return checkCluster(c, connection(c), clientVersion);
  });
  server.handle(podsList, async (_, { paseo }) => {
    attach(paseo);
    const c = await configuration();
    return { pods: await listPodsWithUsage(connection(c)) };
  });
  server.handle(podsDelete, async ({ name }, { paseo }) => {
    attach(paseo);
    const c = await configuration();
    const run = connection(c);
    await deletePod(run, name);
    return { pods: await listPodsWithUsage(run) };
  });
  server.handle(podsLogs, async ({ name }) => {
    const c = await configuration();
    return { text: await podLogs(connection(c), name) };
  });
  server.handle(workspacesList, async (_, { paseo }) => {
    attach(paseo);
    const c = await configuration();
    const list = await paseo.workspaces.list();
    return {
      workspaces: list.entries.map((w) => ({
        id: w.id,
        name: w.name,
        directory: w.workspaceDirectory ?? w.projectRootPath,
        optedIn: c.workspaces.includes(w.id),
        pod: podName(w.id),
      })),
    };
  });

  const removers = [
    server.addHook("agent.open.before", async ({ request }, { paseo }) => {
      attach(paseo);
      const wrap = await wrapFor(deps, { workspaceId: request.workspaceId, cwd: request.cwd, env: request.env, wrap: request.wrap });
      return wrap ? { ...request, wrap } : undefined;
    }),
    server.addHook("terminal.create.before", async ({ request }, { paseo }) => {
      attach(paseo);
      const wrap = await wrapFor(deps, { workspaceId: request.workspaceId, cwd: request.cwd, env: request.env, wrap: request.wrap });
      return wrap ? { ...request, wrap } : undefined;
    }),
    server.addHook("command.run.before", async ({ request }, { paseo }) => {
      attach(paseo);
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
      if (!c.workspaces.includes(workspace.id)) return;
      await connection(c)(["delete", "pod", podName(workspace.id), "--wait=false", "--ignore-not-found"]).catch(() => {
        console.error("Kubernetes Sandbox could not delete the pod of an archived workspace; it will be swept later.");
      });
    }),
  ];

  return () => {
    clearInterval(timer);
    for (const remove of removers) remove();
  };
}
