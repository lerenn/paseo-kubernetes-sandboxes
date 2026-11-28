import assert from "node:assert/strict";
import test from "node:test";
import { buildPod } from "./pod.mjs";

const owner = { apiVersion: "v1", kind: "Service", name: "controller", uid: "service-uid" };
const root = "/paseo/worktrees/demo";
const profile = { image: "sandbox:test", worktree: { claimName: "shared", basePath: "/paseo/worktrees", subPath: "worktrees" } };
const build = (id, spec = profile) => buildPod("sandbox", "daemon", id, spec, { root }, owner);

test("standard sandbox drops capabilities and has no Docker sidecar or service account token", () => {
  const { spec } = build("standard");
  assert.equal(spec.automountServiceAccountToken, false);
  assert.equal(spec.containers.length, 1);
  assert.equal(spec.containers[0].securityContext.privileged, false);
  assert.equal(spec.containers[0].securityContext.allowPrivilegeEscalation, false);
  assert.deepEqual(spec.containers[0].securityContext.capabilities.drop, ["ALL"]);
});

test("Docker sidecar uses the same worktree subPath and a separate disk-backed state volume", () => {
  const { spec } = build("docker", {
    ...profile,
    docker: { enabled: true, image: "docker:dind", sizeLimit: "20Gi" },
  });
  const [main, docker] = spec.containers;
  assert.equal(main.securityContext.privileged, false);
  assert.equal(docker.securityContext.privileged, true);
  assert.deepEqual(main.volumeMounts[0], { name: "worktree", mountPath: root, subPath: "worktrees/demo" });
  assert.deepEqual(docker.volumeMounts[0], main.volumeMounts[0]);
  assert.equal(main.env.find(({ name }) => name === "DOCKER_HOST").value, "unix:///run/paseo-docker/docker.sock");
  assert.ok(docker.args.includes("--host=unix:///run/paseo-docker/docker.sock"));
  assert.deepEqual(spec.volumes.find(({ name }) => name === "docker-state").emptyDir, { sizeLimit: "20Gi" });
  assert.equal(main.volumeMounts.some(({ name }) => name === "docker-state"), false);
  assert.ok(docker.volumeMounts.some(({ name, mountPath }) => name === "docker-state" && mountPath === "/var/lib/docker"));
});

test("selective home mounts remain in main for Standard and Docker", () => {
  const sharedHome = {
    claimName: "shared",
    mounts: [
      { subPath: ".codex/auth.json", mountPath: "/home/paseo/.codex/auth.json", access: "ro" },
      { subPath: "provider-only/claude", mountPath: "/home/paseo/.claude/cache", access: "rw" },
    ],
  };
  for (const id of ["standard", "docker"]) {
    const { spec } = build(id, {
      ...profile,
      sharedHome,
      sidecars: [{ name: "extra" }],
      podSpec: { initContainers: [{ name: "init" }] },
      ...(id === "docker" && { docker: { enabled: true, image: "docker:dind" } }),
    });
    const [main, ...sidecars] = spec.containers;
    assert.equal(spec.volumes.filter(({ name }) => name === "shared-home").length, 1);
    assert.deepEqual(spec.volumes.find(({ name }) => name === "shared-home").persistentVolumeClaim, { claimName: "shared" });
    assert.deepEqual(main.volumeMounts, [
      { name: "worktree", mountPath: root, subPath: "worktrees/demo" },
      ...sharedHome.mounts.map(({ subPath, mountPath, access }) => ({ name: "shared-home", subPath, mountPath, readOnly: access === "ro" })),
      ...(id === "docker" ? [{ name: "docker-socket", mountPath: "/run/paseo-docker" }] : []),
    ]);
    for (const container of [...sidecars, ...spec.initContainers]) {
      assert.ok(!container.volumeMounts?.some(({ name }) => name === "shared-home"));
    }
  }
  assert.ok(!build("standard").spec.volumes.some(({ name }) => name === "shared-home"));
});
