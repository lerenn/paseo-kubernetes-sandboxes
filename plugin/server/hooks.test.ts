import { test } from "node:test";
import assert from "node:assert/strict";
import { settingsSchema } from "../shared/settings.js";
import { wrapFor, type HookDeps } from "./hooks.js";

const config = settingsSchema.parse({
  controllerUrl: "https://controller.example.internal",
  tokenFile: "/var/lib/paseo/sandbox.token",
  caFile: "/var/lib/paseo/sandbox.crt",
  workspaces: [{ id: "w1", profile: "standard" }, { id: "w2", profile: "docker" }],
});

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
    "--", "sandbox-exec", "--url", config.controllerUrl, "--token-file", config.tokenFile, "--ca-file", config.caFile,
    "--workspace", "w1", "--cwd", "/wt/a/sub", "--env", "FOO", "--",
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
    ...deps, configuration: async () => ({ ...config, workspaces: [{ id: "w1" }] }),
  }, launch), /Choose a profile/);
});
