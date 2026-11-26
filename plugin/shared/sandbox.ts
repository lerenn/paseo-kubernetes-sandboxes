import { createHash } from "node:crypto";

export const MANAGED_BY = "paseo-kubernetes-sandboxes";
export const LABEL_MANAGED = "app.kubernetes.io/managed-by";
export const LABEL_WORKSPACE = "sandbox.paseo.sh/workspace";
export const ANNOTATION_WORKSPACE = "sandbox.paseo.sh/workspace-id";
export const MAIN_CONTAINER = "main";
// Per-pod state used by the launcher (pid files) and the idle check (last use marker).
export const STATE_DIR = "/tmp/sbx";

// Workspace ids are free-form: derive a stable, DNS-safe key from them.
export function workspaceKey(workspaceId: string): string {
  return createHash("sha256").update(workspaceId).digest("hex").slice(0, 16);
}
export function podName(workspaceId: string): string {
  return `sbx-${workspaceKey(workspaceId)}`;
}
export const ANNOTATION_MODE = "sandbox.paseo.sh/mode";
export const cloneClaimName = (workspaceId: string) => `${podName(workspaceId)}-clone`;

// Git over SSH: one plugin-managed Secret, mounted read-only in the main (and clone) containers only.
export const SSH_SECRET_NAME = "paseo-sandbox-ssh";
export const SSH_MOUNT_PATH = "/etc/sandbox-ssh";
export const SSH_KEY_ITEM = "ssh-privatekey";
export const SSH_KNOWN_HOSTS_ITEM = "known_hosts";
export const ANNOTATION_SSH_HASH = "sandbox.paseo.sh/content-sha256";
export const ANNOTATION_SSH_SYNCED = "sandbox.paseo.sh/synced-at";
