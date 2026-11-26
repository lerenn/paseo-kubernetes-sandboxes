import { test } from "node:test";
import assert from "node:assert/strict";
import { settingsSchema, type Configuration } from "../shared/settings.js";
import { podName } from "../shared/sandbox.js";
import { KubernetesError, type Kubectl } from "./kubectl.js";
import { wrapFor, type HookDeps } from "./hooks.js";
import { buildWrap } from "./launch.js";
import type { RepoInfo } from "./repo.js";

const repoInfo: RepoInfo = { root: "/wt/a", gitDir: null, remoteUrl: "https://example.com/o/r.git", branch: "main" };

const config = (over: Partial<Configuration> = {}): Configuration =>
  settingsSchema.parse({ image: "img", worktree: { claimName: "wt", basePath: "/wt" }, workspaces: [{ id: "w1" }], namespace: "sbx", ...over });

function deps(run: Kubectl, c = config()): HookDeps {
  return { configuration: async () => c, kubectl: () => run, launcher: "/plugin/launcher/kube-exec.sh", startTimeoutMs: 100, repo: async () => repoInfo };
}
const readyIn = (mode: string): Kubectl => async (args) =>
  args[0] === "get"
    ? JSON.stringify({ items: [{ metadata: { name: podName("w1") }, status: { phase: "Running", containerStatuses: [{ name: "main", ready: true }] } }], metadata: { name: podName("w1"), annotations: { "sandbox.paseo.sh/mode": mode } }, status: { phase: "Running", containerStatuses: [{ name: "main", ready: true }] } })
    : "";
const ready = readyIn("shared");

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

test("clone mode starts launches in the clone path", async () => {
  const c = config({ defaultMode: "clone" });
  const w = await wrapFor(deps(readyIn("clone"), c), { workspaceId: "w1", cwd: "/wt/a/sub", env: {} });
  assert.ok(w!.join(" ").includes("--cwd /workspace/sub"));
});

test("a repository that cannot be read fails the launch", async () => {
  const d = { ...deps(ready), repo: async () => { throw new Error("bad .git"); } };
  await assert.rejects(wrapFor(d, { workspaceId: "w1", cwd: "/wt", env: {} }), /could not read the workspace repository/);
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

test("buildWrap passes the kubeconfig as one argument before the context, only when set", () => {
  const w = buildWrap({ context: "c", namespace: "n", kubeconfigFile: "/a b/kc" }, "p", { cwd: "/w", envNames: [], launcher: "/l" });
  assert.deepEqual(w.slice(1, 5), ["--kubeconfig", "/a b/kc", "--context", "c"]);
  assert.ok(!buildWrap({ context: "c", namespace: "n" }, "p", { cwd: "/w", envNames: [], launcher: "/l" }).includes("--kubeconfig"));
});
