import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import type { SandboxProfile } from "../shared/contracts.js";
import type { Connection } from "../shared/settings.js";
import { urlProblem } from "../shared/settings.js";
import { ControllerError } from "./controller.js";

export type CheckResult = { id: string; label: string; status: "ok" | "fail" | "unknown"; detail: string };
type Api = { health(c: Connection): Promise<unknown>; profiles(c: Connection): Promise<SandboxProfile[]> };

const message = (e: unknown) => (e instanceof Error ? e.message : "The request failed.");

async function fileProblem(path: string): Promise<string | null> {
  try {
    if (!(await stat(path)).isFile()) return "The path is not a regular file on the daemon host.";
    await access(path, constants.R_OK);
    return null;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? "The file is missing on the daemon host."
      : "The file is not readable on the daemon host.";
  }
}

// Reads only. Each check says why a later one was skipped.
export async function checkController(c: Connection, api: Api): Promise<{ checks: CheckResult[]; profiles: SandboxProfile[] }> {
  const checks: CheckResult[] = [];
  const add = (id: string, label: string, status: CheckResult["status"], detail: string) => checks.push({ id, label, status, detail });
  const skipped = "Skipped: fix the previous check first.";
  const url = c.controllerUrl === "" ? "Set the controller URL." : urlProblem(c.controllerUrl);
  add("url", "Controller URL", url ? "fail" : "ok", url ?? `Using ${c.controllerUrl}.`);
  const [tokenProblem, caProblem] = await Promise.all([
    c.tokenFile ? fileProblem(c.tokenFile) : "Set the token file given by your administrator.",
    c.caFile ? fileProblem(c.caFile) : null,
  ]);
  add("token", "Token file", tokenProblem ? "fail" : "ok", tokenProblem ?? "The daemon can read the token file.");
  if (c.caFile) {
    add("ca", "CA file", caProblem ? "fail" : "ok", caProblem ?? "The daemon can read the CA file.");
  }
  let known: SandboxProfile[] = [];
  if (url || tokenProblem || caProblem) {
    add("reach", "Controller reachable", "unknown", skipped);
    add("auth", "Token accepted", "unknown", skipped);
  } else {
    try {
      await api.health(c);
      add("reach", "Controller reachable", "ok", "The controller answered over HTTPS.");
      try {
        known = await api.profiles(c);
        add("auth", "Token accepted", "ok", `The token may use ${known.length} profile${known.length === 1 ? "" : "s"}.`);
      } catch (e) {
        add("auth", "Token accepted", "fail", e instanceof ControllerError && e.status === 401 ? "The controller rejected the token." : "The controller did not return authorized profiles.");
      }
    } catch (e) {
      add("reach", "Controller reachable", "fail", message(e));
      add("auth", "Token accepted", "unknown", skipped);
    }
  }
  return { checks, profiles: known };
}
