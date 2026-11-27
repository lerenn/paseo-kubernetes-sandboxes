import type { SandboxProfile } from "../shared/contracts.js";
import type { Connection } from "../shared/settings.js";
import { urlProblem } from "../shared/settings.js";
import { ControllerError } from "./controller.js";

export type CheckResult = { id: string; label: string; status: "ok" | "fail" | "unknown"; detail: string };
type Api = { health(c: Connection): Promise<unknown>; profiles(c: Connection): Promise<SandboxProfile[]> };

const message = (e: unknown) => (e instanceof Error ? e.message : "The request failed.");

// Reads only. Each check says why a later one was skipped.
export async function checkController(c: Connection, api: Api): Promise<{ checks: CheckResult[]; profiles: SandboxProfile[] }> {
  const checks: CheckResult[] = [];
  const add = (id: string, label: string, status: CheckResult["status"], detail: string) => checks.push({ id, label, status, detail });
  const skipped = "Skipped: fix the previous check first.";
  const url = c.controllerUrl === "" ? "Set the controller URL." : urlProblem(c.controllerUrl);
  add("url", "Controller URL", url ? "fail" : "ok", url ?? `Using ${c.controllerUrl}.`);
  add("token", "Token file", c.tokenFile ? "ok" : "fail", c.tokenFile ? `Configured at ${c.tokenFile} on this host.` : "Set the token file given by your administrator.");
  let known: SandboxProfile[] = [];
  if (url || !c.tokenFile) {
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
        add("auth", "Token accepted", "fail", e instanceof ControllerError && e.status === 401 ? "The controller rejected the token." : message(e));
      }
    } catch (e) {
      add("reach", "Controller reachable", "fail", message(e));
      add("auth", "Token accepted", "unknown", skipped);
    }
  }
  return { checks, profiles: known };
}
