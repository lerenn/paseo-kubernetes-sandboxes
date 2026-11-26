import { test } from "node:test";
import assert from "node:assert/strict";
import { settingsSchema } from "../shared/settings.js";
import { age, phaseTone, resourceIssue, setWorkspaceMode, setWorkspaceSidecars, setupSteps, settingsProblems, toggleWorkspace, toggleWorkspaceSidecar } from "./view.js";

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
  const ready = settingsSchema.parse({ image: "i", worktree: { claimName: "c", basePath: "/w" }, workspaces: [{ id: "a" }] });
  const done = setupSteps(ready, [{ id: "x", status: "ok" }]);
  assert.deepEqual(done.map((s) => s.done), [true, true, true]);
  assert.equal(setupSteps(ready, [{ id: "x", status: "fail" }])[1].done, false);
});

test("toggleWorkspace adds once and removes; modes are set per workspace", () => {
  assert.deepEqual(toggleWorkspace([{ id: "a" }], "b", true), [{ id: "a" }, { id: "b" }]);
  assert.deepEqual(toggleWorkspace([{ id: "a" }, { id: "b" }], "b", true), [{ id: "a" }, { id: "b" }]);
  assert.deepEqual(toggleWorkspace([{ id: "a" }, { id: "b" }], "a", false), [{ id: "b" }]);
  assert.deepEqual(setWorkspaceMode([{ id: "a" }], "a", "clone"), [{ id: "a", mode: "clone" }]);
  assert.deepEqual(setWorkspaceMode([{ id: "a", mode: "clone" }], "a", undefined), [{ id: "a" }]);
});

test("problems depend on the modes in use", () => {
  const clone = settingsSchema.parse({ image: "i", defaultMode: "clone" });
  assert.deepEqual(settingsProblems(clone), []);
  const shared = settingsSchema.parse({ image: "i", workspaces: [{ id: "a" }, { id: "b", mode: "clone" }] });
  assert.equal(settingsProblems(shared).length, 2);
});

test("resourceIssue validates quantities", () => {
  assert.equal(resourceIssue("CPU", "500m"), null);
  assert.equal(resourceIssue("Memory", "2Gi"), null);
  assert.match(resourceIssue("CPU", "lots")!, /Kubernetes quantity/);
});

test("workspace sidecar choices keep the mode and return to the defaults", () => {
  assert.deepEqual(setWorkspaceSidecars([{ id: "a", mode: "clone" }], "a", ["x"]), [{ id: "a", mode: "clone", sidecars: ["x"] }]);
  assert.deepEqual(setWorkspaceSidecars([{ id: "a", sidecars: ["x"] }], "a", undefined), [{ id: "a" }]);
  assert.deepEqual(setWorkspaceMode([{ id: "a", sidecars: [] }], "a", "clone"), [{ id: "a", sidecars: [], mode: "clone" }]);
  assert.deepEqual(setWorkspaceMode([{ id: "a", mode: "clone", sidecars: [] }], "a", undefined), [{ id: "a", sidecars: [] }]);
  assert.deepEqual(toggleWorkspaceSidecar([{ id: "a" }], "a", ["x"], "y", true), [{ id: "a", sidecars: ["x", "y"] }]);
  assert.deepEqual(toggleWorkspaceSidecar([{ id: "a" }], "a", ["x"], "x", false), [{ id: "a", sidecars: [] }]);
});
