import { test } from "node:test";
import assert from "node:assert/strict";
import { settingsSchema, type Configuration } from "../shared/settings.js";
import { podName, workspaceKey } from "../shared/sandbox.js";
import { KubernetesError, type Kubectl } from "./kubectl.js";
import { buildPod, configError, deletePod, ensurePod, listPods, sweep } from "./pods.js";

const config = (over: Partial<Configuration> = {}): Configuration =>
  settingsSchema.parse({
    image: "img:1",
    worktree: { claimName: "wt", mountPath: "/data/worktrees" },
    workspaces: ["w1"],
    ...over,
  });

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
    metadata: { name: podName("w1"), creationTimestamp: "2026-01-01T00:00:00Z", annotations: { "sandbox.paseo.sh/workspace-id": "w1" } },
    status: { phase: "Running", containerStatuses: [{ name: "main", ready: true }] },
    ...over,
  });

test("pod names are stable and DNS safe", () => {
  assert.equal(podName("any id / with chars"), podName("any id / with chars"));
  assert.match(podName("x"), /^sbx-[0-9a-f]{16}$/);
  assert.notEqual(podName("a"), podName("b"));
});

test("buildPod mounts the worktree volume at the same path and labels the pod", () => {
  const pod = buildPod(config({ worktree: { claimName: "wt", mountPath: "/data/wt", subPath: "sub" }, envSecret: "sbx-env" }), "w1");
  assert.equal(pod.metadata.labels["app.kubernetes.io/managed-by"], "paseo-kubernetes-sandbox");
  assert.equal(pod.metadata.labels["sandbox.paseo.sh/workspace"], workspaceKey("w1"));
  assert.equal(pod.metadata.annotations["sandbox.paseo.sh/workspace-id"], "w1");
  assert.equal(pod.spec.shareProcessNamespace, true);
  assert.equal(pod.spec.automountServiceAccountToken, false);
  assert.deepEqual((pod.spec.containers[0] as any).volumeMounts, [{ name: "worktrees", mountPath: "/data/wt", subPath: "sub" }]);
  assert.deepEqual((pod.spec.containers[0] as any).envFrom, [{ secretRef: { name: "sbx-env" } }]);
  assert.equal(pod.spec.containers.length, 1);
});

test("dind adds a privileged sidecar only when enabled", () => {
  const pod = buildPod(config({ dind: true }), "w1");
  assert.equal(pod.spec.containers.length, 2);
  assert.equal((pod.spec.containers[1] as any).securityContext.privileged, true);
});

test("configError asks for the missing settings", () => {
  assert.match(configError(config({ image: "" }))!, /image/);
  assert.match(configError(config({ worktree: { claimName: "", mountPath: "/x", subPath: "" } }))!, /claim/);
  assert.match(configError(config({ worktree: { claimName: "c", mountPath: "x", subPath: "" } }))!, /mount path/);
  assert.equal(configError(config()), null);
});

test("ensurePod creates a missing pod and waits for it", async () => {
  const { run, calls } = fake((a) => (a[0] === "get" ? missing() : undefined));
  assert.equal(await ensurePod(run, config(), "w1"), podName("w1"));
  assert.deepEqual(calls.map((c) => c[0]), ["get", "create", "wait"]);
});

test("ensurePod reuses an existing pod and shares concurrent creation", async () => {
  const a = fake((args) => (args[0] === "get" ? podJson() : undefined));
  await Promise.all([ensurePod(a.run, config(), "w1"), ensurePod(a.run, config(), "w1")]);
  assert.equal(a.calls.filter((c) => c[0] === "create").length, 0);
  assert.equal(a.calls.filter((c) => c[0] === "get").length, 1);
});

test("ensurePod replaces a failed pod and refuses incomplete settings", async () => {
  const f = fake((args) => (args[0] === "get" ? podJson({ status: { phase: "Failed" } }) : undefined));
  await ensurePod(f.run, config(), "w1");
  assert.deepEqual(f.calls.map((c) => c[0]), ["get", "delete", "create", "wait"]);
  await assert.rejects(ensurePod(f.run, config({ image: "" }), "w1"), /image/);
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

const usage = (live: number, last: number) => `${live} ${last}\n`;
function sweepFake(items: string[], u: Record<string, string>) {
  return fake((a) => {
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
