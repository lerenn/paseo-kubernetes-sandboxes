import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { sshProblems, type Configuration } from "../shared/settings.js";
import {
  ANNOTATION_SSH_HASH,
  ANNOTATION_SSH_SYNCED,
  LABEL_MANAGED,
  MANAGED_BY,
  SSH_KEY_ITEM,
  SSH_KNOWN_HOSTS_ITEM,
  SSH_MOUNT_PATH,
  SSH_SECRET_NAME,
} from "../shared/sandbox.js";
import { KubernetesError, type Kubectl } from "./kubectl.js";

export type ReadFile = (path: string) => Promise<Buffer>;
export type SshInfo = {
  configured: boolean;
  present: boolean;
  hashPrefix: string;
  syncedAt: string | null;
  inSync: boolean;
  problem: string | null;
};

export const sshConfigured = (c: Pick<Configuration, "ssh">) => c.ssh.keyFile !== "";

// The environment variable git reads to pick its ssh command. Strict host key checking, only the
// pinned known_hosts, only the mounted key (no agent, no default identities).
export function gitSshCommand(): string {
  return [
    "ssh",
    "-i", `${SSH_MOUNT_PATH}/${SSH_KEY_ITEM}`,
    "-o", "IdentitiesOnly=yes",
    "-o", "IdentityAgent=none",
    "-o", "StrictHostKeyChecking=yes",
    "-o", `UserKnownHostsFile=${SSH_MOUNT_PATH}/${SSH_KNOWN_HOSTS_ITEM}`,
    "-o", "GlobalKnownHostsFile=/dev/null",
  ].join(" ");
}

// Digest of what the Secret holds. Compared, stored and shown (prefix only); never the content.
export function contentHash(key: Buffer, knownHosts: Buffer): string {
  return createHash("sha256").update(key).update("\0").update(knownHosts).digest("hex");
}

// The Secret manifest. It is only ever given to kubectl on stdin. Neither `apply` (which would copy the
// data into a last-applied annotation) nor argv is used.
export function buildSshSecret(key: Buffer, knownHosts: Buffer, now: Date = new Date()) {
  return {
    apiVersion: "v1",
    kind: "Secret",
    type: "Opaque",
    metadata: {
      name: SSH_SECRET_NAME,
      labels: { [LABEL_MANAGED]: MANAGED_BY },
      annotations: { [ANNOTATION_SSH_HASH]: contentHash(key, knownHosts), [ANNOTATION_SSH_SYNCED]: now.toISOString() },
    },
    data: { [SSH_KEY_ITEM]: key.toString("base64"), [SSH_KNOWN_HOSTS_ITEM]: knownHosts.toString("base64") },
  };
}

// Volume and mount for the main container and the clone init container. Never for sidecars.
export const sshVolume = () => ({ name: "ssh", secret: { secretName: SSH_SECRET_NAME, defaultMode: 0o400 } });
export const sshMount = () => ({ name: "ssh", mountPath: SSH_MOUNT_PATH, readOnly: true });

async function readFiles(c: Configuration, read: ReadFile): Promise<{ key: Buffer; knownHosts: Buffer }> {
  const problem = sshProblems(c.ssh);
  if (problem) throw new Error(problem);
  try {
    return { key: await read(c.ssh.keyFile), knownHosts: await read(c.ssh.knownHostsFile) };
  } catch {
    // Never echo the error: it is about files that hold or sit next to key material.
    throw new Error("The SSH key file or the known_hosts file could not be read on the daemon host.");
  }
}

// Annotations of the Secret, or null when it is absent. `-o jsonpath` limited to the annotations keeps
// the data out of the output.
async function remoteAnnotations(run: Kubectl): Promise<Record<string, string> | null> {
  const out = await run(["get", "secret", SSH_SECRET_NAME, "--ignore-not-found", "-o", "jsonpath={.metadata.annotations}"]);
  if (!out.trim()) {
    const exists = await run(["get", "secret", SSH_SECRET_NAME, "--ignore-not-found", "-o", "name"]);
    return exists.trim() ? {} : null;
  }
  try {
    return JSON.parse(out) as Record<string, string>;
  } catch {
    return {};
  }
}

// Creates or updates the Secret when its content differs from the files. Returns true when something was written.
export async function syncSsh(run: Kubectl, c: Configuration, read: ReadFile = readFile, now: Date = new Date()): Promise<boolean> {
  if (!sshConfigured(c)) return false;
  const { key, knownHosts } = await readFiles(c, read);
  const remote = await remoteAnnotations(run);
  if (remote && remote[ANNOTATION_SSH_HASH] === contentHash(key, knownHosts)) return false;
  const manifest = buildSshSecret(key, knownHosts, now);
  await run([remote ? "replace" : "create", "-f", "-"], manifest);
  return true;
}

export async function removeSsh(run: Kubectl): Promise<void> {
  await run(["delete", "secret", SSH_SECRET_NAME, "--ignore-not-found", "--wait=false"]);
}

export async function sshStatus(run: Kubectl, c: Configuration, read: ReadFile = readFile): Promise<SshInfo> {
  const configured = sshConfigured(c);
  let remote: Record<string, string> | null;
  try {
    remote = await remoteAnnotations(run);
  } catch (e) {
    return { configured, present: false, hashPrefix: "", syncedAt: null, inSync: false, problem: e instanceof KubernetesError ? e.message : "The Secret could not be read." };
  }
  const hash = remote?.[ANNOTATION_SSH_HASH] ?? "";
  let inSync = false;
  let problem: string | null = null;
  if (configured && remote) {
    try {
      const { key, knownHosts } = await readFiles(c, read);
      inSync = hash === contentHash(key, knownHosts);
    } catch (e) {
      problem = e instanceof Error ? e.message : "The files could not be read.";
    }
  }
  return { configured, present: remote !== null, hashPrefix: hash.slice(0, 8), syncedAt: remote?.[ANNOTATION_SSH_SYNCED] ?? null, inSync, problem };
}
