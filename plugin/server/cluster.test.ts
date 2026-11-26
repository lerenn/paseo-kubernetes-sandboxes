import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { settingsSchema } from "../shared/settings.js";
import { KubernetesError, connection, listContexts, type Kubectl } from "./kubectl.js";
import { checkCluster } from "./cluster.js";

const c = settingsSchema.parse({ image: "i", worktree: { claimName: "wt", basePath: "/wt" } });
const version = async () => "v1.37.0";

test("all checks pass with full access", async () => {
  const run: Kubectl = async (a) => (a[0] === "auth" ? "yes\n" : a[0] === "config" ? "kind-x\n" : "persistentvolumeclaim/wt\n");
  const r = await checkCluster(c, run, version);
  assert.equal(r.context, "kind-x");
  assert.deepEqual(r.checks.map((x) => [x.id, x.status]), [["kubectl", "ok"], ["cluster", "ok"], ["rbac", "ok"], ["volume", "ok"], ["settings", "ok"]]);
});

test("missing permissions are listed", async () => {
  const run: Kubectl = async (a) => {
    if (a[0] === "auth" && a[2] === "create" && a[3] === "pods/exec") throw new KubernetesError("unavailable", "no\n");
    return a[0] === "auth" ? "yes" : "x";
  };
  const rbac = (await checkCluster(c, run, version)).checks.find((x) => x.id === "rbac")!;
  assert.equal(rbac.status, "fail");
  assert.match(rbac.detail, /create pods\/exec/);
});

test("an unreachable cluster and a missing kubectl are reported", async () => {
  const down: Kubectl = async () => {
    throw new KubernetesError("unavailable");
  };
  assert.equal((await checkCluster(c, down, version)).checks.find((x) => x.id === "cluster")!.status, "fail");
  const none = await checkCluster(c, down, async () => Promise.reject(new Error("x")));
  assert.deepEqual(none.checks.map((x) => x.status), ["fail"]);
});

test("a missing PVC is reported", async () => {
  const run: Kubectl = async (a) => {
    if (a[0] === "get") throw new KubernetesError("missing");
    return "yes";
  };
  assert.match((await checkCluster(c, run, version)).checks.find((x) => x.id === "volume")!.detail, /does not exist/);
});

test("connection maps kubectl failures without leaking stderr", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kc-"));
  const bin = join(dir, "kubectl");
  writeFileSync(bin, '#!/bin/sh\necho "secret-token Error from server (Forbidden)" >&2\nexit 1\n');
  chmodSync(bin, 0o755);
  await assert.rejects(connection({ context: "", namespace: "n" }, bin)(["get", "pods"]), (e: unknown) => {
    assert.ok(e instanceof KubernetesError);
    assert.equal(e.reason, "forbidden");
    assert.ok(!e.message.includes("secret-token"));
    return true;
  });
});

test("Secret rights are reported apart from pod rights, only with Git over SSH", async () => {
  const ssh = settingsSchema.parse({ image: "i", worktree: { claimName: "wt", basePath: "/wt" }, ssh: { keyFile: "/k", knownHostsFile: "/h" } });
  const deny = (what: string): Kubectl => async (a) => {
    if (a[0] === "auth" && a.slice(2).join(" ") === what) throw new KubernetesError("unavailable", "no\n");
    return a[0] === "auth" ? "yes" : "x";
  };
  const secrets = await checkCluster(ssh, deny("create secrets"), version);
  assert.equal(secrets.checks.find((x) => x.id === "secrets")!.status, "fail");
  assert.equal(secrets.checks.find((x) => x.id === "rbac")!.status, "ok");
  const pods = await checkCluster(ssh, deny("get pods"), version);
  assert.equal(pods.checks.find((x) => x.id === "rbac")!.status, "fail");
  assert.equal(pods.checks.find((x) => x.id === "secrets")!.status, "ok");
  assert.ok(!(await checkCluster(c, deny("x"), version)).checks.some((x) => x.id === "secrets"));
});

// Fake kubectl that logs its arguments (never any content) and prints two context names.
function fakeKubectl() {
  const dir = mkdtempSync(join(tmpdir(), "kc-args-"));
  const log = join(dir, "args.log");
  const bin = join(dir, "kubectl");
  writeFileSync(bin, `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a"; done >>"${log}"\necho ctx-a\necho ctx-b\n`);
  chmodSync(bin, 0o755);
  return { bin, log };
}

test("connection passes --kubeconfig as one argument, spaces included, only when set", async () => {
  const f = fakeKubectl();
  const path = "/tmp/my dir/kube config";
  await connection({ context: "x", namespace: "n", kubeconfigFile: path }, f.bin)(["get", "pods"]);
  assert.deepEqual(readFileSync(f.log, "utf8").split("\n").slice(0, 5), ["--kubeconfig", path, "--context", "x", "--namespace"]);
  const g = fakeKubectl();
  await connection({ context: "", namespace: "n", kubeconfigFile: "" }, g.bin)(["get", "pods"]);
  assert.ok(!readFileSync(g.log, "utf8").includes("--kubeconfig"));
});

test("listContexts asks kubectl for names only, with the kubeconfig", async () => {
  const f = fakeKubectl();
  assert.deepEqual(await listContexts({ kubeconfigFile: "/k c" }, f.bin), ["ctx-a", "ctx-b"]);
  assert.equal(readFileSync(f.log, "utf8").trim(), "--kubeconfig\n/k c\nconfig\nget-contexts\n-o\nname");
  assert.deepEqual(await listContexts({}, "/nonexistent/kubectl"), []);
});

test("Check cluster reports the kubeconfig path, and fails clearly when the file is unusable", async () => {
  const withFile = settingsSchema.parse({ image: "i", worktree: { claimName: "wt", basePath: "/wt" }, kubeconfigFile: "/etc/kc/config" });
  const run: Kubectl = async (a) => (a[0] === "auth" ? "yes\n" : a[0] === "config" ? "ctx\n" : "x");
  const ok = await checkCluster(withFile, run, version, async () => null);
  assert.equal(ok.kubeconfigFile, "/etc/kc/config");
  assert.deepEqual(ok.checks.slice(0, 3).map((x) => [x.id, x.status]), [["kubectl", "ok"], ["kubeconfig", "ok"], ["cluster", "ok"]]);
  assert.match(ok.checks.find((x) => x.id === "cluster")!.detail, /kubeconfig \/etc\/kc\/config/);
  let asked = 0;
  const bad = await checkCluster(withFile, async () => (asked++, "x"), version);
  assert.deepEqual(bad.checks.map((x) => [x.id, x.status]), [["kubectl", "ok"], ["kubeconfig", "fail"]]);
  assert.match(bad.checks[1].detail, /\/etc\/kc\/config does not exist or is not readable/);
  assert.equal(asked, 0, "no kubectl call with an unusable file");
  assert.equal((await checkCluster(c, run, version)).kubeconfigFile, "");
  assert.ok(!(await checkCluster(c, run, version)).checks.some((x) => x.id === "kubeconfig"));
});
