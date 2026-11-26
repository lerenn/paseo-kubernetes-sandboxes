import { test } from "node:test";
import assert from "node:assert/strict";
import { settingsSchema } from "../shared/settings.js";
import { ADVANCED_FIELDS, DEFAULTS, INDICATORS, draftProblems, durationLabel, problemOf, NOT_CHECKED, age, indicatorOf, requirementRows, phaseTone, resourceIssue, setWorkspaceMode, setWorkspaceSidecars, setupSteps, settingsProblems, toggleWorkspace, toggleWorkspaceSidecar } from "./view.js";

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

test("indicatorOf maps statuses: ok green, fail red, warn/unknown/none grey", () => {
  assert.equal(indicatorOf("ok"), "verified");
  assert.equal(indicatorOf("fail"), "failed");
  assert.equal(indicatorOf("warn"), "unverified");
  assert.equal(indicatorOf("unknown"), "unverified");
  assert.equal(indicatorOf(undefined), "unverified");
  const shapes = new Set(Object.values(INDICATORS).map((i) => i.icon));
  assert.equal(shapes.size, 3);
  assert.deepEqual(Object.values(INDICATORS).map((i) => i.label), ["Verified", "Failed", "Cannot verify"]);
});

const shared = settingsSchema.parse({ image: "i", worktree: { claimName: "c", basePath: "/w" } });
const byId = (rows: ReturnType<typeof requirementRows>) => Object.fromEntries(rows.map((r) => [r.id, r]));

test("requirements before any check: Paseo verified, the rest not checked yet", () => {
  const rows = byId(requirementRows(shared, null));
  assert.equal(rows.paseo.indicator, "verified");
  for (const id of ["kubectl", "cluster", "rbac", "settings", "volume"]) {
    assert.equal(rows[id].indicator, "unverified", id);
    assert.equal(rows[id].detail, NOT_CHECKED, id);
  }
  assert.equal(rows.secrets, undefined);
});

test("requirements follow each check result", () => {
  const rows = byId(
    requirementRows(shared, [
      { id: "kubectl", status: "ok", detail: "v1" },
      { id: "cluster", status: "ok", detail: "ctx" },
      { id: "rbac", status: "fail", detail: "Missing: create pods" },
      { id: "volume", status: "warn", detail: "odd" },
      { id: "settings", status: "unknown", detail: "" },
    ]),
  );
  assert.deepEqual([rows.kubectl, rows.cluster, rows.rbac, rows.volume, rows.settings].map((r) => r.indicator), ["verified", "verified", "failed", "unverified", "unverified"]);
  assert.equal(rows.rbac.detail, "Missing: create pods");
  assert.equal(rows.volume.detail, "odd");
});

test("rows the check never reached explain why", () => {
  const noKubectl = byId(requirementRows(shared, [{ id: "kubectl", status: "fail", detail: "gone" }]));
  assert.equal(noKubectl.kubectl.indicator, "failed");
  assert.match(noKubectl.rbac.detail, /kubectl is not available/);
  const down = byId(requirementRows(shared, [{ id: "kubectl", status: "ok" }, { id: "cluster", status: "fail", detail: "x" }]));
  assert.equal(down.rbac.indicator, "unverified");
  assert.match(down.rbac.detail, /unreachable/);
  const noClaim = byId(requirementRows(settingsSchema.parse({ image: "i" }), [{ id: "kubectl", status: "ok" }, { id: "cluster", status: "ok" }]));
  assert.match(noClaim.volume.detail, /Set the worktree volume claim/);
});

test("volume and secret rows only appear when they apply", () => {
  const clone = settingsSchema.parse({ image: "i", defaultMode: "clone", clone: { path: "/c" } });
  assert.equal(byId(requirementRows(clone, null)).volume, undefined);
  const ssh = settingsSchema.parse({ image: "i", worktree: { claimName: "c", basePath: "/w" }, ssh: { keyFile: "/k", knownHostsFile: "/h" } });
  const rows = byId(requirementRows(ssh, [{ id: "secrets", status: "ok", detail: "yes" }]));
  assert.equal(rows.secrets.indicator, "verified");
  assert.equal(byId(requirementRows(ssh, null)).secrets.indicator, "unverified");
});

test("defaults come from the schema", () => {
  assert.deepEqual(DEFAULTS, settingsSchema.parse({}));
  assert.equal(DEFAULTS.ttlMinutes, 120);
  assert.equal(durationLabel(DEFAULTS.ttlMinutes), "2 hours");
  assert.equal(durationLabel(90), "90 minutes");
  assert.equal(durationLabel(1), "1 minute");
  assert.match(durationLabel(0), /never/);
});

test("a fresh draft has no blocking problem; incomplete settings are not problems", () => {
  assert.deepEqual(draftProblems(DEFAULTS), []);
});

test("draftProblems ties each invalid value to its field", () => {
  const bad = {
    ...DEFAULTS,
    resources: { ...DEFAULTS.resources, cpuLimit: "lots" },
    worktree: { ...DEFAULTS.worktree, claimName: "Bad_Name", basePath: "relative" },
    envSecret: "UPPER",
    clone: { ...DEFAULTS.clone, path: "rel", storage: "pvc" as const, size: "big" },
  };
  const p = draftProblems(bad);
  for (const f of ["resources.cpuLimit", "worktree.claimName", "worktree.basePath", "envSecret", "clone.path", "clone.size"]) assert.ok(problemOf(p, f), f);
  assert.equal(problemOf(p, "resources.cpuRequest"), undefined);
  // the volume size is only checked when the per-sandbox volume is used
  assert.equal(problemOf(draftProblems({ ...DEFAULTS, clone: { ...DEFAULTS.clone, size: "big" } }), "clone.size"), undefined);
});

test("draftProblems reports sidecar and ssh problems", () => {
  const sidecar = { name: "main", image: "i" };
  const sc = { ...DEFAULTS, sidecars: [settingsSchema.parse({ sidecars: [{ name: "x", image: "i" }] }).sidecars[0], { ...settingsSchema.parse({ sidecars: [{ name: "x", image: "i" }] }).sidecars[0], name: sidecar.name }] };
  assert.match(problemOf(draftProblems(sc), "sidecars")!, /reserved/);
  const ssh = { ...DEFAULTS, ssh: { keyFile: "/k", knownHostsFile: "" } };
  assert.match(problemOf(draftProblems(ssh), "ssh")!, /known_hosts/);
  assert.ok(ADVANCED_FIELDS.includes("sidecars") && !ADVANCED_FIELDS.includes("worktree.basePath"));
});
