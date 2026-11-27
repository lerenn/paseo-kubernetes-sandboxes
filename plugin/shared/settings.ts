import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

const absolutePath = z.union([z.literal(""), z.string().max(4096).startsWith("/", "The path must be absolute.")]);
const profileId = z.string().max(63).regex(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/);

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
export const settingsSchema = connection.extend({
  // Older settings keep their opt-ins, but each workspace needs a profile selection before its next launch.
  workspaces: z.array(z.object({ id: z.string().min(1).max(200), profile: profileId.optional() })).max(500).default([]),
}).superRefine(validateUrl);
export type Configuration = z.output<typeof settingsSchema>;
export type Connection = z.output<typeof connectionSchema>;

export const optedIn = (c: Configuration, id: string) => c.workspaces.some((w) => w.id === id);
export const isConfigured = (c: Connection) => c.controllerUrl !== "" && c.tokenFile !== "";

export const sandboxSettings = defineSettings({
  id: "sandbox",
  scope: "host",
  version: 1,
  schema: settingsSchema,
});
