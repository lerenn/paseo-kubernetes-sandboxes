import { test } from "node:test";
import assert from "node:assert/strict";
import { settingsSchema, type Configuration } from "../shared/settings.js";
import { podName } from "../shared/sandbox.js";
import { KubernetesError, type Kubectl } from "./kubectl.js";
import { wrapFor, type HookDeps } from "./hooks.js";
import { buildWrap } from "./launch.js";

const config = (over: Partial<Configuration> = {}): Configuration =>
  settingsSchema.parse({ image: "img", worktree: { claimName: "wt", mountPath: "/wt" }, workspaces: ["w1"], namespace: "sbx", ...over });

function deps(run: Kubectl, c = config()): HookDeps {
  return { configuration: async () => c, kubectl: () => run, launcher: "/plugin/launcher/kube-exec.sh", startTimeoutMs: 100 };
}
const ready: Kubectl = async (args) =>
  args[0] === "get"
    ? JSON.stringify({ items: [{ metadata: { name: podName("w1") }, status: { phase: "Running", containerStatuses: [{ name: "main", ready: true }] } }], metadata: { name: podName("w1") }, status: { phase: "Running", containerStatuses: [{ name: "main", ready: true }] } })
    : "";

test("buildWrap is an absolute launcher invocation ending with --", () => {
  const w = buildWrap({ context: "kind-x", namespace: "sbx" }, "pod1", { cwd: "/wt/a", envNames: ["A", "B"], launcher: "/l/kube-exec.sh" });
  assert.equal(w[0], "/l/kube-exec.sh");
  assert.equal(w.at(-1), "--");
  assert.deepEqual(w.slice(1, 5), ["--context", "kind-x", "--namespace", "sbx"]);
  assert.ok(w.join(" ").includes("--env A --env B"));
  assert.ok(!w.join(" ").includes("--context --"), "no empty context");
});

test("workspaces that did not opt in run locally", async () => {
  assert.equal(await wrapFor(deps(ready), { workspaceId: "other", cwd: "/wt", env: {} }), undefined);
  assert.equal(await wrapFor(deps(ready), { workspaceId: null, cwd: "/wt", env: {} }), undefined);
});

test("an opted-in workspace gets a wrap with its pod, cwd and env names", async () => {
  const w = await wrapFor(deps(ready), { workspaceId: "w1", cwd: "/wt/a", env: { FOO: "secret-value" } });
  assert.ok(w);
  assert.ok(w.includes(podName("w1")));
  assert.ok(w.join(" ").includes("--cwd /wt/a"));
  assert.ok(w.join(" ").includes("--env FOO"));
  assert.ok(!w.join(" ").includes("secret-value"), "values never enter the wrap");
});

test("another plugin's wrap is left alone", async () => {
  assert.equal(await wrapFor(deps(ready), { workspaceId: "w1", cwd: "/wt", env: {}, wrap: ["/other"] }), undefined);
});

test("a pod that fails to start fails the launch, a slow one asks to retry", async () => {
  const broken: Kubectl = async () => {
    throw new KubernetesError("unavailable");
  };
  await assert.rejects(wrapFor(deps(broken), { workspaceId: "w1", cwd: "/wt", env: {} }), /could not start the pod/);
  const slow: Kubectl = (args) => (args[0] === "wait" ? new Promise(() => {}) : args[0] === "get" ? Promise.reject(new KubernetesError("missing")) : Promise.resolve(""));
  await assert.rejects(wrapFor(deps(slow), { workspaceId: "w1", cwd: "/wt", env: {} }), /still starting/);
});

test("teardown reuses a ready pod and never creates one", async () => {
  const calls: string[] = [];
  const none: Kubectl = async (args) => {
    calls.push(args[0]);
    return JSON.stringify({ items: [] });
  };
  assert.equal(await wrapFor(deps(none), { workspaceId: "w1", cwd: "/wt", env: {}, reuseOnly: true }), undefined);
  assert.deepEqual(calls, ["get"]);
  assert.ok(await wrapFor(deps(ready), { workspaceId: "w1", cwd: "/wt", env: {}, reuseOnly: true }));
});
