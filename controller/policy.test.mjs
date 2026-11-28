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

test("shared home requires explicit, isolated per-profile mounts", () => {
  const mount = { subPath: ".codex/auth.json", mountPath: "/home/paseo/.codex/auth.json", access: "ro" };
  const sharedHome = { claimName: "home", mounts: [mount] };
  const worktree = { ...profile.worktree, claimName: "home", subPath: ".paseo/worktrees", pathDepth: 2 };
  const optedIn = { ...profile, worktree, sharedHome };
  const policyFor = (spec) => createPolicy({ ...config, profiles: { default: spec } });
  assert.equal(policyFor(optedIn).profileFor("daemon", "default"), optedIn);
  assert.equal(volumeSubPath(worktree, "/worktrees/project/slug"), ".paseo/worktrees/project/slug");
  for (const root of ["/worktrees/project", "/worktrees/project/slug/child"]) {
    assert.throws(() => volumeSubPath(worktree, root), /configured depth/);
  }
  for (const change of [
    { subPath: "" }, { subPath: "." }, { subPath: "../auth" }, { subPath: "config/../auth" },
    { subPath: "/auth" }, { subPath: ".paseo/config.json" }, { subPath: ".codex" }, { subPath: ".paseo" },
    { mountPath: "/home/paseo" }, { mountPath: "/home/paseo/../auth" },
    { mountPath: "/home/paseo/.paseo/db" }, { mountPath: "/home/paseo/.claude" },
    { mountPath: "/run/paseo-docker" }, { access: undefined }, { access: "readwrite" },
    { subPathExpr: "$(AUTH)" },
  ]) {
    assert.throws(() => policyFor({ ...optedIn, sharedHome: { ...sharedHome, mounts: [{ ...mount, ...change }] } }),
      /Shared home mounts require/);
  }
  assert.throws(() => policyFor({ ...optedIn, worktree: profile.worktree }), /pathDepth/);
  assert.throws(() => policyFor({ ...optedIn, repository: { ...worktree, subPath: ".codex" } }), /separate from/);
  assert.throws(() => policyFor({
    ...optedIn, podSpec: { volumes: [{ name: "bypass", persistentVolumeClaim: { claimName: "home" } }] },
  }), /controller-managed volume/);
  assert.throws(() => policyFor({
    ...optedIn, sidecars: [{ volumeMounts: [{ name: "shared-home", mountPath: "/bypass" }] }],
  }), /main container/);
  assert.throws(() => policyFor({
    ...optedIn, container: { volumeMounts: [{ name: "other", mountPath: "/home/paseo/.codex" }] },
  }), /destinations must be disjoint/);
  assert.throws(() => policyFor({
    ...optedIn, sharedHome: { ...sharedHome, mounts: [mount, { ...mount, mountPath: "/home/paseo/alias", access: "rw" }] },
  }), /sources must be disjoint/);
});
