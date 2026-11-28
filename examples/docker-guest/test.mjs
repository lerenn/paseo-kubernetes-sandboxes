// Run against a disposable cluster using an administrator kubeconfig.
// The test installs admission policy and RBAC. Every Pod request is a dry-run.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { buildPod } from "../../controller/pod.mjs";
import { createPolicy } from "../../controller/policy.mjs";

const [kubeconfig] = process.argv.slice(2);
if (!kubeconfig) throw new Error("Pass the kubeconfig for a disposable Kubernetes cluster.");

const guest = "paseo-docker-guest";
const standard = "paseo-docker-standard-test";
const controller = "paseo-docker-sandbox-controller";
const identity = `system:serviceaccount:${guest}:${controller}`;
const replicasetController = "system:serviceaccount:kube-system:replicaset-controller";

function kubectl(args, { input, denied } = {}) {
  const result = spawnSync("kubectl", ["--kubeconfig", kubeconfig, "--request-timeout=10s", ...args], { input, encoding: "utf8" });
  if (result.error) throw result.error;
  if (denied) {
    assert.notEqual(result.status, 0, result.stdout);
    assert.match(result.stderr, denied);
  } else {
    assert.equal(result.status, 0, result.stderr);
  }
  return result.stdout;
}

const image = (name, digit) => `registry.example.invalid/${name}@sha256:${digit.repeat(64)}`;
const profile = {
  image: image("paseo-workspace", "2"),
  worktree: { claimName: "docker-worktrees", basePath: "/shared/worktrees", subPath: "worktrees" },
  repository: { claimName: "docker-repositories", basePath: "/shared/repositories", subPath: "repositories" },
  docker: { enabled: true, image: image("docker-dind", "3"), sizeLimit: "10Gi" },
  podSpec: { serviceAccountName: "default" },
};
const pod = (gitDir, spec = profile) => buildPod("sbx-" + "0".repeat(32), "testing", "docker", spec,
  { root: "/shared/worktrees/example", gitDir },
  { apiVersion: "v1", kind: "Service", name: controller, uid: "00000000-0000-4000-a000-000000000000" });
const controllerPod = {
  apiVersion: "v1",
  kind: "Pod",
  metadata: {
    name: controller + "-example",
    ownerReferences: [{ apiVersion: "apps/v1", kind: "ReplicaSet", name: controller + "-rs", uid: "fixture" }],
  },
  spec: {
    serviceAccountName: controller,
    containers: [{
      name: "controller",
      image: image("paseo-controller", "1"),
      securityContext: {
        allowPrivilegeEscalation: false,
        capabilities: { drop: ["ALL"] },
        seccompProfile: { type: "RuntimeDefault" },
      },
    }],
    volumes: [{ name: "tmp", emptyDir: {} }],
  },
};

function install(args) {
  const input = kubectl([...args, "--dry-run=client", "-o", "json"]);
  kubectl(["apply", "-f", "-"], { input });
}

for (const namespace of [guest, standard]) install(["create", "namespace", namespace]);
kubectl(["apply", "-f", fileURLToPath(new URL("./admission.yaml", import.meta.url))]);

for (const [namespace, username, name] of [
  [guest, identity, "docker-controller"],
  [guest, replicasetController, "replicaset-controller"],
  [guest, "test-author", "alternate-author"],
  [standard, identity, "test-author"],
]) {
  install(["-n", namespace, "create", "role", name, "--verb=create", "--resource=pods"]);
  install(["-n", namespace, "create", "rolebinding", name, "--role=" + name, "--user=" + username]);
}
install(["-n", guest, "create", "serviceaccount", controller]);
kubectl(["label", "namespace", guest, "pod-security.kubernetes.io/enforce=privileged", "--overwrite"]);
kubectl(["label", "namespace", standard, "pod-security.kubernetes.io/enforce=baseline", "--overwrite"]);

function dryRun(object, { namespace = guest, user = identity, denied } = {}) {
  return kubectl(["--as", user, "-n", namespace, "create", "--dry-run=server", "-o", "json", "-f", "-"],
    { input: JSON.stringify(object), denied });
}

const ordinary = { apiVersion: "v1", kind: "Pod", metadata: { name: "ordinary" },
  spec: { containers: [{ name: "main", image: "registry.example.invalid/ordinary:1" }] } };
const policyDenial = /The Docker guest admits only/;
dryRun(controllerPod, { user: replicasetController });
dryRun(pod());
dryRun(pod("/shared/repositories/example/.git"));
dryRun(pod(), { user: "test-author", denied: policyDenial });
dryRun(ordinary, { user: "test-author", denied: policyDenial });
dryRun(ordinary, { namespace: standard });
dryRun(pod(), { namespace: standard, denied: /violates PodSecurity/ });

const changedImage = pod();
changedImage.spec.containers[1].image = "registry.example.invalid/docker-dind:latest";
dryRun(changedImage, { denied: policyDenial });
const changedClaim = pod();
changedClaim.spec.volumes[0].persistentVolumeClaim.claimName = "other-claim";
dryRun(changedClaim, { denied: policyDenial });
const changedMount = pod();
changedMount.spec.containers[1].volumeMounts[0].subPath = "worktrees/other";
dryRun(changedMount, { denied: policyDenial });
const extraSidecar = pod();
extraSidecar.spec.containers.push(ordinary.spec.containers[0]);
extraSidecar.spec.containers[2].name = "extra";
dryRun(extraSidecar, { denied: policyDenial });
for (const change of [
  { command: ["dockerd"] },
  { args: ["dockerd", "--version"] },
  { env: [{ name: "EXAMPLE", value: "value" }] },
  { readinessProbe: { exec: { command: ["docker", "version"] } } },
  { workingDir: "/tmp" },
]) {
  const changedExecution = pod();
  Object.assign(changedExecution.spec.containers[1], change);
  dryRun(changedExecution, { denied: policyDenial });
}
const typeChecking = JSON.parse(kubectl(["get", "validatingadmissionpolicy", "paseo-docker-guest", "-o", "json"]));
// Standalone API servers may omit policy status when the controller manager is absent.
assert.deepEqual(typeChecking.status?.typeChecking?.expressionWarnings ?? [], []);

const sharedHome = {
  claimName: "paseo-home",
  mounts: [
    { subPath: ".codex/auth.json", mountPath: "/home/paseo/.codex/auth.json", access: "ro" },
    { subPath: "provider-fixtures/cache", mountPath: "/home/paseo/.claude/cache", access: "rw" },
  ],
};
const optedIn = { ...profile, worktree: { ...profile.worktree, pathDepth: 1 }, sharedHome };
const policy = createPolicy({
  profiles: { docker: optedIn },
  principals: { testing: { gatewayIdentity: "gateway.test", profiles: ["docker"] } },
});
const withHome = () => pod("/shared/repositories/example/.git", policy.profileFor("testing", "docker"));
dryRun(withHome(), { denied: policyDenial });
const exactMounts = Object.fromEntries(sharedHome.mounts.map(({ mountPath, subPath, access }) => [mountPath, [subPath, access]]));
const admission = readFileSync(new URL("./admission.yaml", import.meta.url), "utf8")
  .replace('expression: "{}"', "expression: " + JSON.stringify(JSON.stringify(exactMounts)));
kubectl(["apply", "-f", "-"], { input: admission });
// A successful apply can return before the admission evaluator sees the update.
const admissionDeadline = Date.now() + 10_000;
for (;;) {
  try {
    dryRun(withHome());
    break;
  } catch (error) {
    if (!policyDenial.test(error.message) || Date.now() >= admissionDeadline) throw error;
    await setTimeout(250);
  }
}
for (const change of [
  (p) => delete p.spec.containers[0].volumeMounts.find((m) => m.name === "shared-home").subPath,
  (p) => p.spec.containers[0].volumeMounts.find((m) => m.name === "shared-home").readOnly = false,
  (p) => p.spec.containers[0].volumeMounts.find((m) => m.name === "shared-home").mountPath = "/home/paseo",
  (p) => p.spec.volumes.find((v) => v.name === "shared-home").persistentVolumeClaim.claimName = "other",
  (p) => p.spec.containers[1].volumeMounts.push(p.spec.containers[0].volumeMounts.find((m) => m.name === "shared-home")),
]) {
  const changed = withHome();
  change(changed);
  dryRun(changed, { denied: policyDenial });
}
const standardWithHome = pod(undefined, { ...optedIn, docker: undefined });
dryRun(standardWithHome, { namespace: standard });
console.log("Docker guest allowed and denied admission cases passed with server-side dry-run.");
