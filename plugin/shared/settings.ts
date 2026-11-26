import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const resourceName = z
  .string()
  .max(63)
  .regex(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/);
const quantity = z.string().max(32);
const optionalName = z.union([z.literal(""), resourceName]);

export const resourcesSchema = z.object({
  cpuRequest: quantity.default("250m"),
  cpuLimit: quantity.default("2"),
  memoryRequest: quantity.default("512Mi"),
  memoryLimit: quantity.default("4Gi"),
});

export const worktreeSchema = z.object({
  // PersistentVolumeClaim (in the sandbox namespace) holding the daemon's worktrees.
  claimName: optionalName.default(""),
  // Absolute path where the daemon sees that volume. Mounted at the same path in the pod.
  mountPath: z.string().max(4096).default(""),
  // Optional sub-directory of the volume that mountPath maps to.
  subPath: z.string().max(4096).default(""),
});

export const settingsSchema = z.object({
  context: z.string().max(200).default(""),
  namespace: resourceName.default("paseo-sandbox"),
  // Must contain a shell and every program an agent or terminal will run (git, the agent CLI, ...).
  image: z.string().max(500).default(""),
  resources: resourcesSchema.default(resourcesSchema.parse({})),
  worktree: worktreeSchema.default(worktreeSchema.parse({})),
  // Delete a sandbox pod that has run nothing for this many minutes. 0 disables the idle timeout.
  ttlMinutes: z.number().int().min(0).max(10080).default(120),
  // Optional Docker-in-Docker sidecar (privileged). Off by default.
  dind: z.boolean().default(false),
  // Optional Secret whose keys are exposed as environment variables in the pod (envFrom).
  envSecret: optionalName.default(""),
  // Workspace ids that run in a sandbox. Everything else keeps running locally.
  workspaces: z.array(z.string().min(1).max(200)).max(500).default([]),
});
export type Configuration = z.output<typeof settingsSchema>;

export const sandboxSettings = defineSettings({
  id: "sandbox",
  scope: "host",
  version: 1,
  schema: settingsSchema,
});

export const MIN_PASEO_VERSION = "0.17.5";
