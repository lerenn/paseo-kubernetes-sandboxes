import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { createPolicy, sandboxName, volumeSubPath } from "./policy.mjs";

const profile = { image: "sandbox:test", worktree: { claimName: "shared", basePath: "/worktrees", subPath: "paseo" } };
const token = "a".repeat(43);
const hash = createHash("sha256").update(token).digest("hex");
const config = {
  profiles: { default: profile, restricted: profile },
  principals: { daemon: { tokenSha256: hash, profiles: ["default"] } },
};

test("controller tokens scope profile access and workspace identity", () => {
  const policy = createPolicy(config);
  const principal = policy.authenticate("Bearer " + token);
  assert.equal(principal, "daemon");
  assert.equal(policy.authenticate("Bearer " + "b".repeat(43)), null);
  assert.equal(policy.authenticate(undefined), null);
  assert.deepEqual(policy.profilesFor(principal), ["default"]);
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
