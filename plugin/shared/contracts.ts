import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { connectionSchema, settingsSchema } from "./settings.js";

export const checkStatus = z.enum(["ok", "fail", "unknown"]);
export const check = z.object({ id: z.string(), label: z.string(), status: checkStatus, detail: z.string() });

export const sandboxProfile = z.object({ id: z.string(), label: z.string(), privileged: z.boolean() });
export type SandboxProfile = z.infer<typeof sandboxProfile>;

// Connection check and the profiles authorized by the token.
export const controllerCheck = defineRpc({
  name: "controller.check",
  input: connectionSchema,
  output: z.object({ checks: z.array(check), profiles: z.array(sandboxProfile) }),
});

export const sandboxState = z.enum(["running", "starting", "stopping", "failed", "absent", "unknown"]);
export type SandboxState = z.infer<typeof sandboxState>;
export const workspaceRow = z.object({
  id: z.string(),
  name: z.string(),
  directory: z.string(),
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
  input: z.object({ workspaceId: z.string().min(1).max(200), revision: z.string() }),
  output: z.object({}),
});

// Checks live routing before the client saves with the same settings revision.
export const prepareSettingsSave = defineRpc({
  name: "settings.prepare-save",
  input: z.object({ revision: z.string(), values: settingsSchema }),
  output: z.object({}),
});
