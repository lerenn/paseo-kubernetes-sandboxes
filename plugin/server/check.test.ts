import { sandboxProfile } from "../shared/contracts.js";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { checkController } from "./check.js";

test("checks credential files independently before making controller requests", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "sandbox-check-"));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const tokenFile = join(directory, "token");
  const caFile = join(directory, "ca");
  const connection = { controllerUrl: "https://sandbox.example.internal", tokenFile, caFile };
  const calls: string[] = [];
  const api = {
    health: async () => { calls.push("health"); },
    profiles: async () => { calls.push("profiles"); return []; },
  };
  const statuses = async (caPath = caFile) => {
    const { checks } = await checkController({ ...connection, caFile: caPath }, api);
    assert.ok(!JSON.stringify(checks).includes("token-secret"));
    return Object.fromEntries(checks.map(({ id, status }) => [id, status]));
  };

  assert.deepEqual(await statuses(), { url: "ok", token: "fail", ca: "fail", reach: "unknown", auth: "unknown" });
  await writeFile(tokenFile, "token-secret");
  assert.deepEqual(await statuses(directory), { url: "ok", token: "ok", ca: "fail", reach: "unknown", auth: "unknown" });
  assert.deepEqual(calls, []);

  await writeFile(caFile, "test-ca");
  assert.deepEqual(await statuses(), { url: "ok", token: "ok", ca: "ok", reach: "ok", auth: "ok" });
  assert.deepEqual(await statuses(""), { url: "ok", token: "ok", reach: "ok", auth: "ok" });
  assert.deepEqual(calls, ["health", "profiles", "health", "profiles"]);
});


test("profile discovery keeps resource metadata optional and preserves configured quantities", () => {
  const profile = { id: "standard", label: "Standard", privileged: false };
  assert.deepEqual(sandboxProfile.parse(profile), profile);
  const withResources = {
    ...profile,
    resources: [{ kind: "main", name: "main", requests: { cpu: "250m", "ephemeral-storage": "1Gi" }, limits: {} }],
  };
  assert.deepEqual(sandboxProfile.parse(withResources), withResources);
});
