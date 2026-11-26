import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { settingsSchema } from "../shared/settings.js";
import { KubernetesError, connection, type Kubectl } from "./kubectl.js";
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
