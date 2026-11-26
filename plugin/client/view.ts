// Pure helpers for the screen (no React, unit-tested).
import { QUANTITY, modeOf, type Configuration, type Mode } from "../shared/settings.js";

export type Tone = "muted" | "success" | "warning";
export type CheckLike = { id: string; status: "ok" | "warn" | "fail" | "unknown" };

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function age(iso: string | null, now = Date.now()): string {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return "unknown";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

export const phaseTone = (phase: string, ready: boolean): Tone =>
  ready ? "success" : phase === "Pending" || phase === "Terminating" ? "warning" : "muted";

// What is still missing in the saved settings for the storage modes in use, in the order a user fixes it.
export function settingsProblems(c: Configuration): string[] {
  const modes = new Set<Mode>(c.workspaces.length ? c.workspaces.map((w) => modeOf(c, w.id)) : [c.defaultMode]);
  const out: string[] = [];
  if (!c.image) out.push("Set the sandbox image.");
  if (modes.has("shared")) {
    if (!c.worktree.claimName) out.push("Set the worktree volume claim.");
    if (!c.worktree.basePath.startsWith("/")) out.push("Set the worktree base path (absolute).");
  }
  if (modes.has("clone") && !c.clone.path.startsWith("/")) out.push("Set the clone path (absolute).");
  return out;
}

export type Step = { id: string; label: string; done: boolean; detail: string; tab: "settings" | "cluster" | "workspaces" };

export function setupSteps(saved: Configuration, checks: CheckLike[] | null): Step[] {
  const problems = settingsProblems(saved);
  const clusterOk = !!checks && checks.length > 0 && checks.every((c) => c.status === "ok");
  return [
    {
      id: "settings",
      label: "Settings",
      done: problems.length === 0,
      detail: problems.length ? problems[0] : "Image and storage are set.",
      tab: "settings",
    },
    {
      id: "cluster",
      label: "Cluster access",
      done: clusterOk,
      detail: !checks ? "Not checked yet." : clusterOk ? "kubectl, RBAC and the volume check out." : "Some checks need attention.",
      tab: "cluster",
    },
    {
      id: "workspaces",
      label: "Workspaces",
      done: saved.workspaces.length > 0,
      detail: saved.workspaces.length ? `${plural(saved.workspaces.length, "workspace")} run in a sandbox.` : "No workspace runs in a sandbox yet.",
      tab: "workspaces",
    },
  ];
}

type Entry = Configuration["workspaces"][number];
export function toggleWorkspace(entries: Entry[], id: string, on: boolean): Entry[] {
  return on ? (entries.some((e) => e.id === id) ? entries : [...entries, { id }]) : entries.filter((e) => e.id !== id);
}
// `undefined` returns the workspace to the default mode.
export function setWorkspaceMode(entries: Entry[], id: string, mode: Mode | undefined): Entry[] {
  return entries.map((e) => (e.id === id ? withoutKey({ ...e, ...(mode ? { mode } : {}) }, mode ? null : "mode") : e));
}
// `undefined` returns the workspace to the default sidecars; `[]` means none.
export function setWorkspaceSidecars(entries: Entry[], id: string, names: string[] | undefined): Entry[] {
  return entries.map((e) => (e.id === id ? withoutKey({ ...e, ...(names ? { sidecars: names } : {}) }, names ? null : "sidecars") : e));
}
// Toggles one sidecar for a workspace, starting from the sidecars it currently has.
export function toggleWorkspaceSidecar(entries: Entry[], id: string, current: string[], name: string, on: boolean): Entry[] {
  return setWorkspaceSidecars(entries, id, on ? [...new Set([...current, name])] : current.filter((n) => n !== name));
}
function withoutKey(e: Entry, key: "mode" | "sidecars" | null): Entry {
  if (key) delete e[key];
  return e;
}

export const validQuantity = (v: string) => QUANTITY.test(v.trim());
export function resourceIssue(label: string, value: string): string | null {
  return validQuantity(value) ? null : `${label} must be a Kubernetes quantity, for example 500m or 2Gi.`;
}
