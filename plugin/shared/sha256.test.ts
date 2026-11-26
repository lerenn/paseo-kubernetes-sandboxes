import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { sha256Hex } from "./sha256.js";
import { podName, workspaceKey } from "./sandbox.js";

test("sha256Hex matches node:crypto (test-only reference), incl. padding edges and unicode", () => {
  const inputs = ["", "abc", "a".repeat(55), "a".repeat(56), "a".repeat(63), "a".repeat(64), "a".repeat(1000),
    "w1", "any id / with chars", "héllo wörld", "日本語", "emoji 😀 pair", "lone \ud800 surrogate"];
  for (const s of inputs) assert.equal(sha256Hex(s), createHash("sha256").update(s, "utf8").digest("hex"), JSON.stringify(s));
});

test("pod names are unchanged from the node:crypto derivation", () => {
  const ref = (id: string) => createHash("sha256").update(id).digest("hex").slice(0, 16);
  for (const id of ["w1", "/home/x/.paseo/worktrees/abc/main"]) {
    assert.equal(workspaceKey(id), ref(id));
    assert.equal(podName(id), `sbx-${ref(id)}`);
  }
});
