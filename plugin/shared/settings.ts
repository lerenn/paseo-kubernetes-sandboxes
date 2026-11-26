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

export const modeSchema = z.enum(["shared", "clone"]);
export type Mode = z.output<typeof modeSchema>;

// Shared worktree: the pod mounts the workspace's worktree folder and the main repository's .git
// directory at their own absolute paths. `basePath` is where the daemon sees the volume, `subPath`
// the directory of the claim that basePath maps to.
export const volumeSchema = z.object({
  claimName: optionalName.default(""),
  basePath: z.string().max(4096).default(""),
  subPath: z.string().max(4096).default(""),
});

// Pod-local clone: the pod clones the repository into its own storage.
export const cloneSchema = z.object({
  path: z.string().max(4096).default("/workspace"),
  storage: z.enum(["emptyDir", "pvc"]).default("emptyDir"),
  size: quantity.default("10Gi"),
  storageClass: z.string().max(253).default(""),
  // Secret mounted at /etc/sandbox-git. If it has a `gitconfig` key, GIT_CONFIG_GLOBAL points to it
  // (use it for a credential helper reading another key of the same Secret).
  gitSecret: optionalName.default(""),
});

export const workspaceEntry = z.object({ id: z.string().min(1).max(200), mode: modeSchema.optional() });

export const settingsSchema = z.object({
  context: z.string().max(200).default(""),
  namespace: resourceName.default("paseo-sandbox"),
  // Must contain a shell, git and every program an agent or terminal will run.
  image: z.string().max(500).default(""),
  resources: resourcesSchema.default(resourcesSchema.parse({})),
  // Storage mode of workspaces that do not choose one.
  defaultMode: modeSchema.default("shared"),
  worktree: volumeSchema.default(volumeSchema.parse({})),
  // Where the main repositories (their .git directories) live. An empty claim reuses the worktree claim.
  repo: volumeSchema.default(volumeSchema.parse({})),
  clone: cloneSchema.default(cloneSchema.parse({})),
  // Run the pod as this uid/gid (the daemon's files are usually uid 1000). 0 keeps the image's user.
  runAsUser: z.number().int().min(0).max(65535).default(1000),
  // Delete a sandbox pod that has run nothing for this many minutes. 0 disables the idle timeout.
  ttlMinutes: z.number().int().min(0).max(10080).default(120),
  // Optional Docker-in-Docker sidecar (privileged). Off by default.
  dind: z.boolean().default(false),
  // Optional Secret whose keys are exposed as environment variables in the pod (envFrom).
  envSecret: optionalName.default(""),
  // Workspaces that run in a sandbox. Everything else keeps running locally.
  workspaces: z.array(workspaceEntry).max(500).default([]),
});
export type Configuration = z.output<typeof settingsSchema>;

export const optedIn = (c: Configuration, id: string) => c.workspaces.some((w) => w.id === id);
export const modeOf = (c: Configuration, id: string): Mode => c.workspaces.find((w) => w.id === id)?.mode ?? c.defaultMode;

export const sandboxSettings = defineSettings({
  id: "sandbox",
  scope: "host",
  version: 1,
  schema: settingsSchema,
});

export const MIN_PASEO_VERSION = "0.17.5";
