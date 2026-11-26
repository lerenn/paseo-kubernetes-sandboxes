import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const checkStatus = z.enum(["ok", "warn", "fail", "unknown"]);
export const check = z.object({
  id: z.string(),
  label: z.string(),
  status: checkStatus,
  detail: z.string(),
});

export const podInfo = z.object({
  name: z.string(),
  workspaceId: z.string(),
  phase: z.string(),
  ready: z.boolean(),
  createdAt: z.string(),
  lastUsed: z.string().nullable(),
  mode: z.enum(["shared", "clone"]),
  sidecars: z.array(z.object({ name: z.string(), ready: z.boolean() })),
});

// Cluster, RBAC and volume checks. Never needs more than the RBAC Role in config/plugin-rbac.yaml.
export const clusterCheck = defineRpc({
  name: "cluster.check",
  input: z.object({}),
  output: z.object({
    context: z.string(),
    namespace: z.string(),
    checks: z.array(check),
  }),
});

export const podsList = defineRpc({
  name: "pods.list",
  input: z.object({}),
  output: z.object({ pods: z.array(podInfo) }),
});
export const podsDelete = defineRpc({
  name: "pods.delete",
  input: z.object({ name: z.string().max(63) }),
  output: z.object({ pods: z.array(podInfo) }),
});
export const podsLogs = defineRpc({
  name: "pods.logs",
  input: z.object({ name: z.string().max(63) }),
  output: z.object({ text: z.string() }),
});

export const workspaceRow = z.object({
  id: z.string(),
  name: z.string(),
  directory: z.string(),
  optedIn: z.boolean(),
  mode: z.enum(["shared", "clone"]),
  pod: z.string(),
});
export const workspacesList = defineRpc({
  name: "workspaces.list",
  input: z.object({}),
  output: z.object({ workspaces: z.array(workspaceRow) }),
});

// Status of the plugin-managed SSH Secret. Only a hash prefix is ever returned, never content.
export const sshInfo = z.object({
  configured: z.boolean(),
  present: z.boolean(),
  hashPrefix: z.string(),
  syncedAt: z.string().nullable(),
  // The Secret matches the key and known_hosts files currently on the daemon host.
  inSync: z.boolean(),
  problem: z.string().nullable(),
});
export const sshStatus = defineRpc({ name: "ssh.status", input: z.object({}), output: sshInfo });
export const sshSync = defineRpc({ name: "ssh.sync", input: z.object({}), output: sshInfo });
export const sshRemove = defineRpc({ name: "ssh.remove", input: z.object({}), output: sshInfo });
