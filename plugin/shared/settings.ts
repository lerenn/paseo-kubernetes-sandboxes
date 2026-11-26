import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const resourceName = z
  .string()
  .max(63)
  .regex(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/);
const quantity = z.string().max(32);
// A Kubernetes quantity, for the fields added with sidecars (older fields stay lenient).
export const QUANTITY = /^(\d+\.?\d*|\.\d+)(Ki|Mi|Gi|Ti|Pi|Ei|n|u|m|k|M|G|T|P|E)?$/;
const strictQuantity = z.string().max(32).regex(QUANTITY);
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

// Names a sidecar may not take: they belong to the plugin's own containers and volumes.
export const RESERVED_NAMES = ["main", "clone", "worktree", "repo-git", "git"];
const sidecarName = z
  .string()
  .max(50)
  .regex(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/);
const envVar = z.object({ name: z.string().min(1).max(253).regex(/^[A-Za-z_][A-Za-z0-9_]*$/), value: z.string().max(4096) });
const envList = z.array(envVar).max(32);
const argList = z.array(z.string().max(4096)).max(64);

// Extra containers of the sandbox pod, as named templates. Nothing is privileged unless `privileged` is true.
export const sidecarSchema = z.object({
  name: sidecarName,
  image: z.string().min(1).max(500),
  command: argList.optional(),
  args: argList.optional(),
  env: envList.default([]),
  privileged: z.boolean().default(false),
  resources: z
    .object({
      cpuRequest: strictQuantity.optional(),
      cpuLimit: strictQuantity.optional(),
      memoryRequest: strictQuantity.optional(),
      memoryLimit: strictQuantity.optional(),
      ephemeralStorageRequest: strictQuantity.optional(),
      ephemeralStorageLimit: strictQuantity.optional(),
    })
    .default({}),
  // Mount the main container's workspace volumes at the same absolute paths (never the git Secret).
  mountWorkspace: z.boolean().default(true),
  // Exactly one of `exec` (a command) or `tcpPort`. The pod is Ready only when every probe passes.
  readinessProbe: z
    .object({
      exec: argList.optional(),
      tcpPort: z.number().int().min(1).max(65535).optional(),
      initialDelaySeconds: z.number().int().min(0).max(600).default(2),
      periodSeconds: z.number().int().min(1).max(600).default(2),
      timeoutSeconds: z.number().int().min(1).max(600).default(1),
      failureThreshold: z.number().int().min(1).max(1000).default(30),
    })
    .optional(),
  // An emptyDir (lost with the pod) mounted at `path` in the sidecar only.
  stateVolume: z.object({ path: z.string().max(4096), sizeLimit: strictQuantity.default("20Gi") }).optional(),
  // Environment added to the main container whenever this sidecar is active (for example DOCKER_HOST).
  mainEnv: envList.default([]),
});
export type Sidecar = z.output<typeof sidecarSchema>;

const label = z.string().min(1).max(253);
// Only these pod-spec fields can be set, for every sandbox pod. There is no raw merge.
export const podOverridesSchema = z.object({
  runtimeClassName: z.union([z.literal(""), resourceName]).default(""),
  tolerations: z
    .array(
      z.strictObject({
        key: label.optional(),
        operator: z.enum(["Exists", "Equal"]).optional(),
        value: z.string().max(63).optional(),
        effect: z.enum(["NoSchedule", "PreferNoSchedule", "NoExecute"]).optional(),
        tolerationSeconds: z.number().int().min(0).max(31536000).optional(),
      }),
    )
    .max(16)
    .default([]),
  nodeSelector: z.record(label, z.string().max(63)).refine((o) => Object.keys(o).length <= 16, "At most 16 entries").default({}),
  priorityClassName: z.string().max(253).regex(/^([a-z0-9]([-a-z0-9.]*[a-z0-9])?)?$/).default(""),
  imagePullSecrets: z.array(z.object({ name: resourceName })).max(8).default([]),
});

export const workspaceEntry = z.object({
  id: z.string().min(1).max(200),
  mode: modeSchema.optional(),
  // Names of sidecars for this workspace. Absent: the default sidecars. `[]`: none.
  sidecars: z.array(sidecarName).max(8).optional(),
});

const baseSchema = z.object({
  context: z.string().max(200).default(""),
  namespace: resourceName.default("paseo-sandboxes"),
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
  // Named sidecar templates, and the names enabled for workspaces that do not choose.
  sidecars: z.array(sidecarSchema).max(8).default([]),
  defaultSidecars: z.array(sidecarName).max(8).default([]),
  podOverrides: podOverridesSchema.default(podOverridesSchema.parse({})),
  // Optional Secret whose keys are exposed as environment variables in the pod (envFrom).
  envSecret: optionalName.default(""),
  // Workspaces that run in a sandbox. Everything else keeps running locally.
  workspaces: z.array(workspaceEntry).max(500).default([]),
});

// Problems with the sidecar settings, or null. Checked on save and again before a pod is built.
export function sidecarProblems(c: Pick<z.output<typeof baseSchema>, "sidecars" | "defaultSidecars" | "workspaces">): string | null {
  const names = new Set<string>();
  for (const s of c.sidecars) {
    if (RESERVED_NAMES.includes(s.name)) return `Sidecar name "${s.name}" is reserved.`;
    if (names.has(s.name)) return `Sidecar name "${s.name}" is used twice.`;
    names.add(s.name);
    const p = s.readinessProbe;
    if (p && (p.exec === undefined) === (p.tcpPort === undefined)) return `Sidecar "${s.name}": the readiness probe needs exactly one of exec or tcpPort.`;
    if (p?.exec && p.exec.length === 0) return `Sidecar "${s.name}": the readiness probe command is empty.`;
    if (s.stateVolume && !s.stateVolume.path.startsWith("/")) return `Sidecar "${s.name}": the state volume path must be absolute.`;
  }
  const unknown = [...c.defaultSidecars, ...c.workspaces.flatMap((w) => w.sidecars ?? [])].find((n) => !names.has(n));
  return unknown ? `Sidecar "${unknown}" is selected but not defined.` : null;
}

export const settingsSchema = baseSchema.superRefine((c, ctx) => {
  const problem = sidecarProblems(c);
  if (problem) ctx.addIssue({ code: "custom", message: problem });
});
export type Configuration = z.output<typeof settingsSchema>;

export const optedIn = (c: Configuration, id: string) => c.workspaces.some((w) => w.id === id);
// Sidecars of a workspace: its own choice, else the defaults. Names are resolved against the templates.
export const sidecarNamesOf = (c: Configuration, id: string): string[] => c.workspaces.find((w) => w.id === id)?.sidecars ?? c.defaultSidecars;
export const sidecarsOf = (c: Configuration, id: string): Sidecar[] => {
  const names = sidecarNamesOf(c, id);
  return c.sidecars.filter((s) => names.includes(s.name));
};
export const modeOf = (c: Configuration, id: string): Mode => c.workspaces.find((w) => w.id === id)?.mode ?? c.defaultMode;

export const sandboxSettings = defineSettings({
  id: "sandbox",
  scope: "host",
  version: 1,
  schema: settingsSchema,
});

export const MIN_PASEO_VERSION = "0.17.5";
