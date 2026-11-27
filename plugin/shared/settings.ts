import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

const absolutePath = z.union([z.literal(""), z.string().max(4096).startsWith("/", "The path must be absolute.")]);

// The controller serves private HTTPS.
export function urlProblem(value: string): string | null {
  if (value === "") return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "Enter a full URL such as https://sandbox-controller.example.internal.";
  }
  if (url.protocol !== "https:") return "The controller URL must use https.";
  if (url.username || url.password) return "Do not put credentials in the URL; use the token file.";
  if ((url.pathname !== "/" && url.pathname !== "") || url.search || url.hash) return "Use only the controller's address (no path).";
  return null;
}

const baseSchema = z.object({
  // Base URL of the Paseo sandbox controller (installed by an administrator with the Helm chart).
  controllerUrl: z.string().max(500).default(""),
  // Files on the DAEMON HOST. Only the paths are stored; the token is read when a command launches and is never logged.
  tokenFile: absolutePath.default(""),
  // CA certificate that signed the controller's certificate (the `ca.crt` of the chart's TLS Secret). Empty: system CAs.
  caFile: absolutePath.default(""),
  // Administrator-defined profile (image, volumes, resources) used by this daemon's sandboxes.
  profile: z.string().max(63).regex(/^([a-z0-9]([-a-z0-9]*[a-z0-9])?)?$/).default(""),
  // Workspaces that run in a sandbox. Everything else keeps running locally.
  workspaces: z.array(z.object({ id: z.string().min(1).max(200) })).max(500).default([]),
});

const validateUrl = (c: { controllerUrl: string }, ctx: z.RefinementCtx) => {
  const problem = urlProblem(c.controllerUrl);
  if (problem) ctx.addIssue({ code: "custom", path: ["controllerUrl"], message: problem });
};

export const connectionSchema = baseSchema.omit({ workspaces: true }).superRefine(validateUrl);
export const settingsSchema = baseSchema.superRefine(validateUrl);
export type Configuration = z.output<typeof settingsSchema>;

export const optedIn = (c: Configuration, id: string) => c.workspaces.some((w) => w.id === id);
export const isConfigured = (c: Configuration) => c.controllerUrl !== "" && c.tokenFile !== "" && c.profile !== "";

export const sandboxSettings = defineSettings({
  id: "sandbox",
  scope: "host",
  version: 1,
  schema: settingsSchema,
});
