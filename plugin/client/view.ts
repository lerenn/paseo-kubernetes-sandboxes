// Pure helpers for the screen (no React, unit-tested).
import type { Configuration } from "../shared/settings.js";

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

// What is still missing in the saved settings, in the order a user fixes it.
export function settingsProblems(c: Configuration): string[] {
  const out: string[] = [];
  if (!c.image) out.push("Set the sandbox image.");
  if (!c.worktree.claimName) out.push("Set the worktree volume claim.");
  if (!c.worktree.mountPath.startsWith("/")) out.push("Set the worktree mount path (absolute).");
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
      detail: problems.length ? problems[0] : "Image and worktree volume are set.",
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

export function toggleWorkspace(ids: string[], id: string, on: boolean): string[] {
  return on ? [...new Set([...ids, id])] : ids.filter((v) => v !== id);
}

const QUANTITY = /^(\d+\.?\d*|\.\d+)(Ki|Mi|Gi|Ti|Pi|Ei|n|u|m|k|M|G|T|P|E)?$/;
export const validQuantity = (v: string) => QUANTITY.test(v.trim());
export function resourceIssue(label: string, value: string): string | null {
  return validQuantity(value) ? null : `${label} must be a Kubernetes quantity, for example 500m or 2Gi.`;
}
