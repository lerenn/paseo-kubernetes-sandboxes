import { test } from "node:test";
import assert from "node:assert/strict";
import { migrateSettings, settingsSchema } from "../shared/settings.js";
import { wrapFor, type HookDeps } from "./hooks.js";

const legacy = {
  controllerUrl: "https://controller.example.internal",
  tokenFile: "/var/lib/paseo/sandbox.token",
  caFile: "/var/lib/paseo/sandbox.crt",
  workspaces: [{ id: "w1", profile: "standard" }, { id: "w2", profile: "docker" }, { id: "pending" }],
};
const config = settingsSchema.parse(migrateSettings(legacy, 1));

const deps: HookDeps = {
  configuration: async () => config,
  repo: async () => ({ root: "/wt/a", gitDir: "/repos/a/.git" }),
  ensure: async () => {},
};
const launch = { workspaceId: "w1", cwd: "/wt/a/sub", env: { FOO: "secret-value" } };

test("only opted-in launches are wrapped", async () => {
  assert.equal(await wrapFor(deps, { ...launch, workspaceId: "other" }), undefined);
  assert.equal(await wrapFor(deps, { ...launch, workspaceId: null }), undefined);
  assert.equal(await wrapFor(deps, { ...launch, wrap: ["/other"] }), undefined);
});

test("the wrap uses shared paths and forwards only environment names", async () => {
  const wrap = await wrapFor({
    ...deps,
    ensure: async (settings, workspace, paths) => {
      assert.equal(settings.profile, "standard");
      assert.equal(workspace, "w1");
      assert.deepEqual(paths, { root: "/wt/a", gitDir: "/repos/a/.git" });
    },
  }, launch);
  assert.deepEqual(wrap?.slice(0, 3), [process.execPath, "--input-type=module", "-e"]);
  assert.match(wrap?.[3] ?? "", /node:http2/);
  assert.deepEqual(wrap?.slice(4), [
    "--", "sandbox-exec", "--url", legacy.controllerUrl, "--token-file", legacy.tokenFile, "--ca-file", legacy.caFile,
    "--workspace", "w1", "--profile", "standard", "--cwd", "/wt/a/sub", "--env", "FOO", "--",
  ]);
});

test("an opted-in launch fails closed on controller or repository errors", async () => {
  await assert.rejects(wrapFor({ ...deps, ensure: async () => { throw new Error("unavailable"); } }, launch), /could not start the sandbox/);
  await assert.rejects(wrapFor({ ...deps, repo: async () => { throw new Error("bad .git"); } }, launch), /could not read the workspace repository/);
});

test("teardown reuses a ready sandbox without creating one", async () => {
  const teardown = { ...launch, reuseOnly: true };
  const reuse = { ...deps, ensure: async () => assert.fail("teardown tried to create a sandbox") };
  assert.equal(await wrapFor({ ...reuse, status: async () => null }, teardown), undefined);
  assert.ok(await wrapFor({
    ...reuse, status: async () => ({ ready: true, deleting: false, phase: "Running", profile: "standard" }),
  }, teardown));
});

test("each workspace launches with its saved profile and legacy opt-ins must choose one", async () => {
  await wrapFor({ ...deps, ensure: async (settings) => assert.equal(settings.profile, "docker") }, { ...launch, workspaceId: "w2" });
  await assert.rejects(wrapFor({
    ...deps,
  }, { ...launch, workspaceId: "pending" }), /Choose a profile/);
});


test("migration preserves the Standard connection and existing workspace selections", () => {
  const { workspaces, ...connection } = legacy;
  assert.deepEqual(config.connections, [{ ...connection, id: "standard", name: "Standard" }]);
  assert.deepEqual(config.workspaces, workspaces.map((workspace) => ({ ...workspace, connectionId: "standard" })));
});

test("duplicate profile IDs use the saved connection for launch, teardown and exec", async () => {
  const docker = {
    id: "docker-lab", name: "Docker Lab", controllerUrl: "https://docker.example.internal",
    tokenFile: "/etc/docker.token", caFile: "/etc/docker.ca",
  };
  const multi = settingsSchema.parse({
    connections: [...config.connections, docker],
    workspaces: [...config.workspaces, { id: "w3", connectionId: docker.id, profile: "standard" }],
  });
  const input = { ...launch, workspaceId: "w3" };
  const selected = {
    ...deps,
    configuration: async () => multi,
    ensure: async (connection: Parameters<NonNullable<HookDeps["ensure"]>>[0]) => {
      assert.deepEqual(connection, { ...docker, profile: "standard" });
    },
    status: async (connection: Parameters<NonNullable<HookDeps["status"]>>[0]) => {
      assert.deepEqual(connection, docker);
      return { ready: true, deleting: false, phase: "Running", profile: "standard" };
    },
  };
  for (const reuseOnly of [false, true]) {
    const wrap = await wrapFor(selected, { ...input, reuseOnly });
    assert.deepEqual(wrap?.slice(6, 12), [
      "--url", docker.controllerUrl, "--token-file", docker.tokenFile, "--ca-file", docker.caFile,
    ]);
  }
});

test("launches reject a privilege change under a saved profile ID", async () => {
  const pinned = settingsSchema.parse({
    ...config,
    workspaces: [{ id: "w1", connectionId: "standard", profile: "build", privileged: false }],
  });
  await assert.rejects(wrapFor({
    ...deps,
    configuration: async () => pinned,
    profiles: async () => [{ id: "build", label: "Build (privileged)", privileged: true }],
    ensure: async () => assert.fail("a changed privilege level must prevent provisioning"),
  }, launch), /privilege level changed/);
});

test("requiring profiles blocks unassigned launches while allowing recovery and maintenance", async () => {
  assert.equal(config.requireSandboxProfile, false);
  const required = { ...deps, configuration: async () => ({ ...config, requireSandboxProfile: true }) };
  const unassigned = { ...launch, workspaceId: "other" };
  await assert.rejects(wrapFor(required, unassigned), /Select an authorized profile/);
  await assert.rejects(wrapFor(required, { ...unassigned, wrap: ["/other"] }), /Select an authorized profile/);
  await assert.rejects(wrapFor(required, { ...launch, wrap: ["/other"] }), /conflicting wrapper/);
  assert.equal(await wrapFor(required, { ...unassigned, allowUnassigned: true }), undefined);
  assert.equal(await wrapFor(required, { ...unassigned, reuseOnly: true }), undefined);
  assert.equal(await wrapFor(required, { ...unassigned, workspaceId: null }), undefined);
});

test("required profiles recheck authorization and pin privilege even for legacy routes", async () => {
  const required = {
    ...deps,
    configuration: async () => ({ ...config, requireSandboxProfile: true }),
    profiles: async () => [{ id: "standard", label: "Standard", privileged: false }],
    ensure: async (settings: { privileged?: boolean }) => assert.equal(settings.privileged, false),
  };
  assert.ok(await wrapFor(required, launch));
  await assert.rejects(wrapFor({ ...required, profiles: async () => [] }, launch), /Select an authorized profile/);
  await assert.rejects(wrapFor({
    ...required,
    profiles: async () => [{ id: "docker", label: "Docker", privileged: true }],
  }, { ...launch, workspaceId: "w2" }), /Select an authorized profile/);
});
