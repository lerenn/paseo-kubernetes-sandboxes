import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { connectionSchema } from "./settings.js";

export const checkStatus = z.enum(["ok", "fail", "unknown"]);
export const check = z.object({ id: z.string(), label: z.string(), status: checkStatus, detail: z.string() });

// Connection check: reachability, token, and the profile. Reads only; never creates anything.
export const controllerCheck = defineRpc({
  name: "controller.check",
  input: connectionSchema,
  output: z.object({ checks: z.array(check), profiles: z.array(z.string()) }),
});

export const sandboxState = z.enum(["running", "starting", "stopping", "failed", "absent", "unknown"]);
export type SandboxState = z.infer<typeof sandboxState>;
export const workspaceRow = z.object({
  id: z.string(),
  name: z.string(),
  directory: z.string(),
  optedIn: z.boolean(),
  sandbox: sandboxState,
});
export const workspacesList = defineRpc({
  name: "workspaces.list",
  input: z.object({}),
  output: z.object({ workspaces: z.array(workspaceRow) }),
});

// Stops and removes a workspace's sandbox (it is recreated at the next launch).
export const sandboxStop = defineRpc({
  name: "sandbox.stop",
  input: z.object({ workspaceId: z.string().min(1).max(200) }),
  output: z.object({}),
});
