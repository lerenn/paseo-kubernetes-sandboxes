import assert from "node:assert/strict";
import { test } from "node:test";
import { migrateSettings, settingsSchema } from "../shared/settings.js";
import { checkRoutingChange } from "./routing.js";

const gateway = {
  id: "standard", name: "Gateway", gateway: true,
  controllerUrl: "https://sandbox.example.internal", tokenFile: "/gateway.token", caFile: "",
};
const legacy = settingsSchema.parse(migrateSettings({
  requireSandboxProfile: true,
  connections: [
    { ...gateway, gateway: undefined, name: "Standard", controllerUrl: "https://standard.example.internal" },
    { ...gateway, gateway: undefined, id: "docker", name: "Docker", controllerUrl: "https://docker.example.internal" },
  ],
  workspaces: [
    { id: "a", connectionId: "standard", profile: "standard", privileged: false },
    { id: "b", connectionId: "docker", profile: "docker", privileged: true },
  ],
}, 2));
const migrated = settingsSchema.parse({
  ...legacy,
  connections: [gateway],
  workspaces: legacy.workspaces.map((workspace) => ({ ...workspace, connectionId: gateway.id })),
});
const allowed = [
  { id: "standard", label: "Standard", privileged: false },
  { id: "docker", label: "Docker", privileged: true },
];
const api = {
  health: async () => ({ ok: true as const, type: "gateway" as const }),
  profiles: async () => allowed,
  status: async () => null,
};

test("migrates both direct assignments to one verified Gateway without querying direct endpoints", async () => {
  const calls: string[] = [];
  await checkRoutingChange(legacy, migrated, {
    health: async (connection) => { calls.push(connection.controllerUrl); return api.health(); },
    profiles: async (connection) => { calls.push(connection.controllerUrl); return allowed; },
    status: async () => assert.fail("contacted a legacy direct endpoint"),
  });
  assert.deepEqual(calls, [gateway.controllerUrl, gateway.controllerUrl]);
  assert.deepEqual(migrated.workspaces.map(({ id, profile, privileged }) => [id, profile, privileged]), [
    ["a", "standard", false], ["b", "docker", true],
  ]);
});

test("migration rejects a direct endpoint, a missing or changed grant, and lost assignments", async () => {
  await assert.rejects(checkRoutingChange(legacy, migrated, {
    ...api, health: async () => { throw new Error("Gateway required"); },
    profiles: async () => assert.fail("sent a token before the Gateway check"),
  }), /Gateway required/);
  for (const profiles of [[allowed[0]!], [allowed[0]!, { ...allowed[1]!, privileged: false }]]) {
    await assert.rejects(checkRoutingChange(legacy, migrated, { ...api, profiles: async () => profiles }), /saved profile and privilege/);
  }
  await assert.rejects(checkRoutingChange(legacy, { ...migrated, workspaces: [] }, api), /existing workspace assignments/);
  await assert.rejects(checkRoutingChange(legacy, { ...migrated, requireSandboxProfile: false }, api), /existing workspace assignments/);
});

test("regular route changes require an absent sandbox and a matching grant", async () => {
  const proposed = { ...migrated, workspaces: [{ ...migrated.workspaces[0]!, profile: "docker", privileged: true }, migrated.workspaces[1]!] };
  await assert.rejects(checkRoutingChange(migrated, proposed, {
    ...api,
    status: async () => ({ profile: "standard", phase: "Running", ready: true, deleting: false }),
  }), /wait for its status/);
  await assert.rejects(checkRoutingChange(migrated, proposed, { ...api, profiles: async () => [allowed[0]!] }), /unavailable/);
  await checkRoutingChange(migrated, proposed, api);
});

test("dangling assignments and multiple Gateway connections cannot be saved", async () => {
  assert.equal(settingsSchema.safeParse({ ...migrated, connections: [] }).success, false);
  await assert.rejects(checkRoutingChange(migrated, {
    ...migrated, connections: [gateway, { ...gateway, id: "second" }],
  }, api), /one Gateway/);
});
