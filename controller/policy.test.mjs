import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { createPolicy, sandboxName, volumeSubPath } from "./policy.mjs";

const profile = { image: "sandbox:test", worktree: { claimName: "shared", basePath: "/worktrees", subPath: "paseo" } };
const unsetResources = (kind, name) => ({ kind, name, requests: {}, limits: {} });
const token = "a".repeat(43);
const hash = createHash("sha256").update(token).digest("hex");
const config = {
  allowDirect: true,
  profiles: { default: profile, restricted: profile },
  principals: { daemon: { tokenSha256: hash, profiles: ["default"] } },
};

test("controller tokens scope profile access and workspace identity", () => {
  const policy = createPolicy(config);
  const principal = policy.authenticateDirect("Bearer " + token);
  assert.equal(principal, "daemon");
  assert.equal(policy.authenticateDirect("Bearer " + "b".repeat(43)), null);
  assert.equal(policy.authenticateDirect(undefined), null);
  assert.deepEqual(policy.profilesFor(principal), [{ id: "default", label: "default", privileged: false, resources: [unsetResources("main", "main")] }]);
  assert.equal(policy.profileFor(principal, "restricted"), undefined);
  assert.notEqual(sandboxName(principal, "workspace"), sandboxName("another-daemon", "workspace"));
});

test("shared workspace mounts stay below the configured base", () => {
  assert.equal(volumeSubPath(profile.worktree, "/worktrees/project one"), "paseo/project one");
  for (const path of ["/worktrees", "/worktrees2/project", "/worktrees/../etc", "project", "/worktrees/project/"]) {
    assert.throws(() => volumeSubPath(profile.worktree, path));
  }
  assert.throws(() => createPolicy({
    ...config,
    profiles: { default: { ...profile, worktree: { ...profile.worktree, subPath: "../outside" } } },
  }));
});

test("Docker visibility requires an explicit enabled profile and principal allowlist", () => {
  const standard = profile;
  const docker = {
    ...profile,
    container: { resources: { requests: { cpu: 1, memory: "256Mi" }, limits: { memory: "1Gi" } } },
    sidecars: [{ name: "cache", resources: { limits: { "ephemeral-storage": "3Gi" } } }],
    docker: { enabled: true, image: "docker:dind", sizeLimit: "20Gi", resources: { requests: { cpu: "250m" } } },
    podSpec: { initContainers: [{ name: "prepare" }] },
  };
  const scoped = createPolicy({
    profiles: { standard, docker },
    principals: {
      normal: { gatewayIdentity: "gateway.internal.test", profiles: ["standard"] },
      trusted: { gatewayIdentity: "gateway.internal.test", profiles: ["docker"] },
    },
  });
  assert.deepEqual(scoped.profilesFor("normal"), [{ id: "standard", label: "Standard", privileged: false, resources: [unsetResources("main", "main")] }]);
  assert.deepEqual(scoped.profilesFor("trusted"), [{ id: "docker", label: "Docker (privileged)", privileged: true, resources: [
    { ...unsetResources("main", "main"), requests: { cpu: "1", memory: "256Mi" }, limits: { memory: "1Gi" } },
    { ...unsetResources("sidecar", "cache"), limits: { "ephemeral-storage": "3Gi" } },
    { ...unsetResources("sidecar", "docker"), requests: { cpu: "250m" } },
    unsetResources("init", "prepare"),
  ] }]);
  assert.equal(scoped.profileFor("normal", "docker"), undefined);
  assert.throws(() => createPolicy({ profiles: { standard: docker } }), /separate profile/);
  assert.throws(() => createPolicy({ profiles: { docker: profile } }), /Enable the Docker sidecar/);
  assert.throws(() => createPolicy({ profiles: {
    standard: { ...standard, sidecars: [{ securityContext: { privileged: true } }] },
  } }), /controller-managed Docker sidecar/);
});

test("controller rejects legacy bearer tokens without explicit migration mode", () => {
  assert.throws(() => createPolicy({ ...config, allowDirect: false }), /explicit opt-in/);
  const policy = createPolicy({
    ...config,
    allowDirect: false,
    principals: { daemon: { gatewayIdentity: "gateway.internal.test", profiles: ["default"] } },
  });
  assert.equal(policy.authenticateDirect("Bearer " + token), null);
  assert.equal(policy.authenticateGateway({ authorized: false }, "daemon"), null);
});
