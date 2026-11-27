import assert from "node:assert/strict";
import { test } from "node:test";
import { settingsSchema } from "../shared/settings.js";
import { checkRoutingChange } from "./routing.js";

const standard = { id: "standard", name: "Standard", controllerUrl: "https://standard.example", tokenFile: "/standard.token", caFile: "/standard.ca" };
const docker = { id: "docker", name: "Docker Lab", controllerUrl: "https://docker.example", tokenFile: "/docker.token", caFile: "/docker.ca" };
const before = settingsSchema.parse({
  connections: [standard, docker],
  workspaces: [{ id: "w1", connectionId: standard.id, profile: "build", privileged: false }],
});
const after = settingsSchema.parse({
  ...before,
  workspaces: [{ id: "w1", connectionId: docker.id, profile: "build", privileged: true }],
});

test("route changes wait for fully confirmed deletion on the old controller", async () => {
  const api = {
    async status(connection: Pick<typeof standard, "controllerUrl" | "tokenFile" | "caFile">, id: string) {
      assert.deepEqual(connection, standard);
      assert.equal(id, "w1");
      return { profile: "build", phase: "Running", ready: false, deleting: true };
    },
    async profiles() { assert.fail("A deleting pod still owns the old route"); },
  };
  await assert.rejects(checkRoutingChange(before, after, api), /wait for its status/);
  await assert.rejects(checkRoutingChange(before, after, {
    ...api,
    async status() { throw new Error("unreachable"); },
  }), /unreachable/);
});

test("route changes check authorization and privilege on the destination connection", async () => {
  const api = {
    async status(connection: Pick<typeof standard, "controllerUrl" | "tokenFile" | "caFile">) {
      assert.deepEqual(connection, standard);
      return null;
    },
    async profiles(connection: Pick<typeof docker, "controllerUrl" | "tokenFile" | "caFile">) {
      assert.deepEqual(connection, docker);
      return [{ id: "build", label: "Docker (privileged)", privileged: true }];
    },
  };
  await checkRoutingChange(before, after, api);
  await assert.rejects(checkRoutingChange(before, {
    ...after, workspaces: [{ ...after.workspaces[0], privileged: false }],
  }, api), /privilege level/);
  await assert.rejects(checkRoutingChange(before, after, {
    ...api, profiles: async () => [],
  }), /unavailable/);
});

test("renaming a connection preserves its route while credential changes require absence", async () => {
  const api = {
    async status() { assert.fail("A display name does not affect routing"); },
    async profiles() { assert.fail("A display name does not affect profiles"); },
  };
  await checkRoutingChange(before, { ...before, connections: [{ ...standard, name: "Team A" }, docker] }, api);
  await assert.rejects(checkRoutingChange(before, {
    ...before, connections: [{ ...standard, tokenFile: "/replacement" }, docker],
  }, {
    ...api, status: async () => ({ profile: "build", phase: "Running", ready: true, deleting: false }),
  }), /Stop the existing sandbox/);
});

test("dangling connections and duplicate IDs are rejected", () => {
  assert.equal(settingsSchema.safeParse({ ...before, connections: [docker] }).success, false);
  assert.equal(settingsSchema.safeParse({ ...before, connections: [standard, standard] }).success, false);
});
