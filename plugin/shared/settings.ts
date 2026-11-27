import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

const absolutePath = z.union([z.literal(""), z.string().max(4096).startsWith("/", "The path must be absolute.")]);
export const profileId = z.string().max(63).regex(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/);

export function urlProblem(value: string): string | null {
  if (value === "") return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "Enter a full URL such as https://sandbox-controller.example.internal.";
  }
  if (url.protocol !== "https:") return "The controller URL must use https.";
  if (url.username || url.password) return "Use the token file for credentials.";
  if (url.pathname !== "/" || url.search || url.hash) return "Enter the controller's HTTPS origin.";
  return null;
}

const connection = z.object({
  controllerUrl: z.string().max(500).default(""),
  tokenFile: absolutePath.default(""),
  caFile: absolutePath.default(""),
});

function validateUrl(c: { controllerUrl: string }, ctx: z.RefinementCtx) {
  const problem = urlProblem(c.controllerUrl);
  if (problem) ctx.addIssue({ code: "custom", path: ["controllerUrl"], message: problem });
}

export const connectionSchema = connection.superRefine(validateUrl);
export const standardConnectionId = "standard";
export const namedConnectionSchema = connectionSchema.safeExtend({
  id: profileId,
  name: z.string().trim().min(1).max(80),
});
export const profileRequiredMessage =
  "Select an authorized profile in Kubernetes Sandbox → Workspaces, then retry the launch.";

export const settingsSchema = z.object({
  requireSandboxProfile: z.boolean().default(false),
  connections: z.array(namedConnectionSchema).max(20).default([]),
  workspaces: z.array(z.object({
    id: z.string().min(1).max(200),
    connectionId: profileId.default(standardConnectionId),
    profile: profileId.optional(),
    privileged: z.boolean().optional(),
  })).max(500).default([]),
}).superRefine(({ connections, workspaces }, ctx) => {
  const ids = new Set(connections.map(({ id }) => id));
  if (ids.size !== connections.length || new Set(workspaces.map(({ id }) => id)).size !== workspaces.length) {
    ctx.addIssue({ code: "custom", message: "Connection and workspace IDs must be unique." });
  }
  if (workspaces.some(({ connectionId }) => !ids.has(connectionId))) {
    ctx.addIssue({ code: "custom", path: ["workspaces"], message: "Each workspace needs a saved controller connection." });
  }
});
export type Configuration = z.output<typeof settingsSchema>;
export type Connection = z.output<typeof connectionSchema>;
export type NamedConnection = z.output<typeof namedConnectionSchema>;

export const isConfigured = (c: Connection) => c.controllerUrl !== "" && c.tokenFile !== "";

export function workspaceRoute(c: Configuration, id: string) {
  const workspace = c.workspaces.find((w) => w.id === id);
  if (!workspace) return undefined;
  const connection = c.connections.find(({ id }) => id === workspace.connectionId);
  if (!connection) throw new Error("The workspace controller connection is missing.");
  return { workspace, connection };
}

export function migrateSettings(values: unknown, fromVersion: number) {
  if (fromVersion !== 1) return values;
  const legacy = connection.extend({ workspaces: z.array(z.object({
    id: z.string().min(1).max(200),
    profile: profileId.optional(),
  })).default([]) }).parse(values);
  const { workspaces, ...credentials } = legacy;
  return settingsSchema.parse({
    connections: [{ id: standardConnectionId, name: "Standard", ...credentials }],
    workspaces,
  });
}

export const sandboxSettings = defineSettings({
  id: "sandbox",
  scope: "host",
  version: 2,
  schema: settingsSchema,
  migrate: migrateSettings,
});
