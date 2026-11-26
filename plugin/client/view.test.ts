import { test } from "node:test";
import assert from "node:assert/strict";
import { settingsSchema } from "../shared/settings.js";
import { age, phaseTone, resourceIssue, setupSteps, settingsProblems, toggleWorkspace } from "./view.js";

test("age formats elapsed time", () => {
  const now = Date.parse("2026-01-02T00:00:00Z");
  assert.equal(age("2026-01-01T23:59:30Z", now), "30s");
  assert.equal(age("2026-01-01T23:00:00Z", now), "1h");
  assert.equal(age("2025-12-30T00:00:00Z", now), "3d");
  assert.equal(age(null, now), "unknown");
});

test("phaseTone", () => {
  assert.equal(phaseTone("Running", true), "success");
  assert.equal(phaseTone("Pending", false), "warning");
  assert.equal(phaseTone("Failed", false), "muted");
});

test("settings problems and setup steps follow the saved settings", () => {
  const empty = settingsSchema.parse({});
  assert.equal(settingsProblems(empty).length, 3);
  const steps = setupSteps(empty, null);
  assert.deepEqual(steps.map((s) => s.done), [false, false, false]);
  const ready = settingsSchema.parse({ image: "i", worktree: { claimName: "c", mountPath: "/w" }, workspaces: ["a"] });
  const done = setupSteps(ready, [{ id: "x", status: "ok" }]);
  assert.deepEqual(done.map((s) => s.done), [true, true, true]);
  assert.equal(setupSteps(ready, [{ id: "x", status: "fail" }])[1].done, false);
});

test("toggleWorkspace adds once and removes", () => {
  assert.deepEqual(toggleWorkspace(["a"], "b", true), ["a", "b"]);
  assert.deepEqual(toggleWorkspace(["a", "b"], "b", true), ["a", "b"]);
  assert.deepEqual(toggleWorkspace(["a", "b"], "a", false), ["b"]);
});

test("resourceIssue validates quantities", () => {
  assert.equal(resourceIssue("CPU", "500m"), null);
  assert.equal(resourceIssue("Memory", "2Gi"), null);
  assert.match(resourceIssue("CPU", "lots")!, /Kubernetes quantity/);
});
