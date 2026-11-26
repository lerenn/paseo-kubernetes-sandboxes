import { test } from "node:test";
import assert from "node:assert/strict";
import { settingsSchema, type Configuration } from "../shared/settings.js";
import { podName, workspaceKey } from "../shared/sandbox.js";
import { KubernetesError, type Kubectl } from "./kubectl.js";
import type { RepoInfo } from "./repo.js";
import { buildClonePvc, buildPod, podCwd, configError, deletePod, ensurePod, listPods, sweep } from "./pods.js";

const config = (over: Partial<Configuration> = {}): Configuration =>
  settingsSchema.parse({
    image: "img:1",
    worktree: { claimName: "wt", basePath: "/data/worktrees" },
    repo: { basePath: "/workspace/src" },
    workspaces: [{ id: "w1" }],
    ...over,
  });

const repo: RepoInfo = { root: "/data/worktrees/h1/feat", gitDir: "/workspace/src/app/.git", remoteUrl: "https://example.com/o/app.git", branch: "feat" };
type Call = string[];
function fake(handler: (args: string[], input?: unknown) => string | Error | undefined) {
  const calls: Call[] = [];
  const run: Kubectl = async (args, input) => {
    calls.push(args);
    const r = handler(args, input);
    if (r instanceof Error) throw r;
    return r ?? "";
  };
  return { run, calls };
}
const missing = () => new KubernetesError("missing");
const podJson = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    metadata: { name: podName("w1"), creationTimestamp: "2026-01-01T00:00:00Z", annotations: { "sandbox.paseo.sh/workspace-id": "w1", "sandbox.paseo.sh/mode": "shared" } },
    status: { phase: "Running", containerStatuses: [{ name: "main", ready: true }] },
    ...over,
  });

test("pod names are stable and DNS safe", () => {
  assert.equal(podName("any id / with chars"), podName("any id / with chars"));
  assert.match(podName("x"), /^sbx-[0-9a-f]{16}$/);
  assert.notEqual(podName("a"), podName("b"));
});

test("shared mode mounts the worktree folder and the repo .git at their absolute paths", () => {
  const pod = buildPod(config({ worktree: { claimName: "wt", basePath: "/data/worktrees", subPath: "wts" }, envSecret: "sbx-env" }), "w1", "shared", repo);
  const c = pod.spec.containers[0] as any;
  assert.equal(pod.metadata.labels["app.kubernetes.io/managed-by"], "paseo-kubernetes-sandbox");
  assert.equal(pod.metadata.labels["sandbox.paseo.sh/workspace"], workspaceKey("w1"));
  assert.equal(pod.metadata.annotations["sandbox.paseo.sh/workspace-id"], "w1");
  assert.equal(pod.metadata.annotations["sandbox.paseo.sh/mode"], "shared");
  assert.equal(pod.spec.shareProcessNamespace, true);
  assert.equal(pod.spec.automountServiceAccountToken, false);
  assert.deepEqual(c.volumeMounts, [
    { name: "worktree", mountPath: "/data/worktrees/h1/feat", subPath: "wts/h1/feat" },
    { name: "repo-git", mountPath: "/workspace/src/app/.git", subPath: "app/.git" },
  ]);
  assert.deepEqual(c.envFrom, [{ secretRef: { name: "sbx-env" } }]);
  assert.deepEqual(c.securityContext, { runAsUser: 1000, runAsGroup: 1000 });
  assert.ok(c.env.some((e: any) => e.name === "GIT_CONFIG_KEY_0" && e.value === "safe.directory"));
  assert.equal((pod.spec as any).initContainers, undefined);
  assert.equal(pod.spec.containers.length, 1);
});

test("shared mode without a .git pointer mounts only the folder; runAsUser 0 keeps the image user", () => {
  const pod = buildPod(config({ runAsUser: 0 }), "w1", "shared", { ...repo, gitDir: null });
  const c = pod.spec.containers[0] as any;
  assert.equal(c.volumeMounts.length, 1);
  assert.equal(c.securityContext, undefined);
});

test("paths outside the configured base paths are refused", () => {
  assert.throws(() => buildPod(config(), "w1", "shared", { ...repo, root: "/elsewhere/x" }), /not under the configured base path/);
});

test("clone mode clones in an init container, without a shared volume", () => {
  const c = config({ defaultMode: "clone", clone: { path: "/workspace", storage: "emptyDir", size: "10Gi", storageClass: "", gitSecret: "git-creds" } });
  const pod = buildPod(c, "w1", "clone", repo) as any;
  assert.deepEqual(pod.spec.volumes.map((v: any) => v.name), ["clone", "git"]);
  assert.deepEqual(pod.spec.volumes[0], { name: "clone", emptyDir: {} });
  const init = pod.spec.initContainers[0];
  assert.equal(init.env.find((e: any) => e.name === "URL").value, repo.remoteUrl);
  assert.equal(init.env.find((e: any) => e.name === "BRANCH").value, "feat");
  assert.ok(init.env.some((e: any) => e.name === "GIT_CONFIG_GLOBAL"));
  assert.equal(pod.spec.containers[0].workingDir, "/workspace");
  assert.throws(() => buildPod(c, "w1", "clone", { ...repo, remoteUrl: null }), /no origin remote/);
});

test("clone mode with a per-sandbox volume uses a PVC named after the pod", () => {
  const c = config({ clone: { path: "/workspace", storage: "pvc", size: "5Gi", storageClass: "fast", gitSecret: "" } });
  const pod = buildPod(c, "w1", "clone", repo) as any;
  assert.equal(pod.spec.volumes[0].persistentVolumeClaim.claimName, `${podName("w1")}-clone`);
  const pvc = buildClonePvc(c, "w1");
  assert.equal(pvc.spec.resources.requests.storage, "5Gi");
  assert.equal(pvc.spec.storageClassName, "fast");
});

test("dind adds a privileged sidecar only when enabled", () => {
  const pod = buildPod(config({ dind: true }), "w1", "shared", repo);
  assert.equal(pod.spec.containers.length, 2);
  assert.equal((pod.spec.containers[1] as any).securityContext.privileged, true);
});

test("podCwd maps launches into the clone and keeps daemon paths in shared mode", () => {
  const c = config();
  assert.equal(podCwd(c, "shared", repo, "/data/worktrees/h1/feat/src"), "/data/worktrees/h1/feat/src");
  assert.equal(podCwd(c, "clone", repo, repo.root), "/workspace");
  assert.equal(podCwd(c, "clone", repo, `${repo.root}/pkg/a`), "/workspace/pkg/a");
  assert.equal(podCwd(c, "clone", repo, "/other"), "/workspace");
});

test("configError asks for the missing settings", () => {
  assert.match(configError(config({ image: "" }))!, /image/);
  assert.match(configError(config({ worktree: { claimName: "", basePath: "/x", subPath: "" } }))!, /claim/);
  assert.match(configError(config({ worktree: { claimName: "c", basePath: "x", subPath: "" } }))!, /base path/);
  assert.equal(configError(config()), null);
  assert.equal(configError(config({ worktree: { claimName: "", basePath: "", subPath: "" } }), "clone"), null);
});

test("ensurePod creates a missing pod and waits for it", async () => {
  const { run, calls } = fake((a) => (a[0] === "get" ? missing() : undefined));
  assert.equal(await ensurePod(run, config(), "w1", repo), podName("w1"));
  assert.deepEqual(calls.map((c) => c[0]), ["get", "create", "wait"]);
});

test("ensurePod reuses an existing pod and shares concurrent creation", async () => {
  const a = fake((args) => (args[0] === "get" ? podJson() : undefined));
  await Promise.all([ensurePod(a.run, config(), "w1", repo), ensurePod(a.run, config(), "w1", repo)]);
  assert.equal(a.calls.filter((c) => c[0] === "create").length, 0);
  assert.equal(a.calls.filter((c) => c[0] === "get").length, 1);
});

test("ensurePod replaces a failed pod and refuses incomplete settings", async () => {
  const f = fake((args) => (args[0] === "get" ? podJson({ status: { phase: "Failed" } }) : undefined));
  await ensurePod(f.run, config(), "w1", repo);
  assert.deepEqual(f.calls.map((c) => c[0]), ["get", "delete", "create", "wait"]);
  await assert.rejects(ensurePod(f.run, config({ image: "" }), "w1", repo), /image/);
});

test("ensurePod creates the clone volume first and refuses a mode switch on a live pod", async () => {
  const c = config({ workspaces: [{ id: "w1", mode: "clone" }], clone: { path: "/workspace", storage: "pvc", size: "1Gi", storageClass: "", gitSecret: "" } });
  const f = fake((a) => (a[0] === "get" && a[1] === "pod" ? missing() : undefined));
  await ensurePod(f.run, c, "w1", repo);
  assert.deepEqual(f.calls.map((x) => x[0] + (x[1] ? " " + x[1] : "")).slice(0, 4), ["get pod", "get pvc", "create -f", "create -f"]);
  const live = fake((a) => (a[0] === "get" ? podJson({ metadata: { name: podName("w1"), annotations: { "sandbox.paseo.sh/mode": "shared" } } }) : undefined));
  await assert.rejects(ensurePod(live.run, c, "w1", repo), /Delete the pod/);
});

test("listPods only selects managed pods and deletePod refuses others", async () => {
  const f = fake((a) => (a[0] === "get" ? JSON.stringify({ items: [JSON.parse(podJson())] }) : undefined));
  const pods = await listPods(f.run);
  assert.deepEqual(f.calls[0], ["get", "pods", "-l", "app.kubernetes.io/managed-by=paseo-kubernetes-sandbox", "-o", "json"]);
  assert.equal(pods[0].workspaceId, "w1");
  assert.equal(pods[0].ready, true);
  await assert.rejects(deletePod(f.run, "other-pod"), /Not a sandbox pod/);
  await deletePod(f.run, podName("w1"));
  assert.equal(f.calls.at(-1)![0], "delete");
});

test("sweep removes clone volumes of unknown workspaces only", async () => {
  const f = fake((a) => {
    if (a[0] === "get" && a[1] === "pods") return JSON.stringify({ items: [] });
    if (a[0] === "get" && a[1] === "pvc")
      return JSON.stringify({ items: [{ metadata: { name: "keep-clone", annotations: { "sandbox.paseo.sh/workspace-id": "w1" } } }, { metadata: { name: "gone-clone", annotations: { "sandbox.paseo.sh/workspace-id": "gone" } } }] });
    return undefined;
  });
  const r = await sweep(f.run, config(), { knownWorkspaces: new Set(["w1"]) });
  assert.deepEqual(r.deleted, ["gone-clone"]);
});

const usage = (live: number, last: number) => `${live} ${last}\n`;
function sweepFake(items: string[], u: Record<string, string>) {
  return fake((a) => {
    if (a[0] === "get" && a[1] === "pvc") return JSON.stringify({ items: [] });
    if (a[0] === "get") return JSON.stringify({ items: items.map((n) => JSON.parse(podJson({ metadata: { name: n, creationTimestamp: "2026-01-01T00:00:00Z", annotations: { "sandbox.paseo.sh/workspace-id": n } } }))) });
    if (a[0] === "exec") return u[a[1]];
    return undefined;
  });
}
const NOW = Date.parse("2026-01-01T05:00:00Z");

test("sweep deletes idle pods past the TTL, keeps busy and recent ones", async () => {
  const old = Date.parse("2026-01-01T01:00:00Z") / 1000;
  const recent = Date.parse("2026-01-01T04:30:00Z") / 1000;
  const f = sweepFake(["idle", "busy", "recent"], { idle: usage(0, old), busy: usage(1, old), recent: usage(0, recent) });
  const r = await sweep(f.run, config({ ttlMinutes: 120 }), { now: NOW });
  assert.deepEqual(r.deleted, ["idle"]);
});

test("sweep with ttl 0 never deletes idle pods; orphans are deleted unless busy", async () => {
  const old = Date.parse("2026-01-01T01:00:00Z") / 1000;
  const f = sweepFake(["w1", "gone", "gone-busy"], { w1: usage(0, old), gone: usage(0, old), "gone-busy": usage(2, old) });
  const r = await sweep(f.run, config({ ttlMinutes: 0 }), { now: NOW, knownWorkspaces: new Set(["w1"]) });
  assert.deepEqual(r.deleted, ["gone"]);
});

test("sweep leaves a pod alone when its usage cannot be read", async () => {
  const f = sweepFake(["p"], { p: undefined as unknown as string });
  const failing: Kubectl = async (a, i) => (a[0] === "exec" ? Promise.reject(new KubernetesError("unavailable")) : f.run(a, i));
  assert.deepEqual((await sweep(failing, config(), { now: NOW + 10 * 86400_000 })).deleted, []);
});
