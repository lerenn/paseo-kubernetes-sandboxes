import { modeOf, sidecarProblems, sidecarsOf, type Configuration, type Mode, type Sidecar } from "../shared/settings.js";
import { subPathFor, type RepoInfo } from "./repo.js";
import {
  ANNOTATION_MODE,
  cloneClaimName,
  ANNOTATION_WORKSPACE,
  LABEL_MANAGED,
  LABEL_WORKSPACE,
  MAIN_CONTAINER,
  MANAGED_BY,
  STATE_DIR,
  podName,
  workspaceKey,
} from "../shared/sandbox.js";
import { KubernetesError, type Kubectl } from "./kubectl.js";
import { gitSshCommand, sshConfigured, sshMount, sshVolume, syncSsh, type ReadFile } from "./ssh.js";

export type PodInfo = {
  name: string;
  workspaceId: string;
  phase: string;
  ready: boolean;
  createdAt: string;
  lastUsed: string | null;
  mode: Mode;
  // Readiness of the other containers of the pod (the sidecars).
  sidecars: { name: string; ready: boolean }[];
};

export function configError(c: Configuration, mode: Mode = c.defaultMode): string | null {
  if (!c.image) return "Set the sandbox image in Settings.";
  const sidecar = sidecarProblems(c);
  if (sidecar) return sidecar;
  if (mode === "shared") {
    if (!c.worktree.claimName) return "Set the worktree volume claim in Settings.";
    if (!c.worktree.basePath.startsWith("/")) return "Set the worktree base path (absolute) in Settings.";
  } else if (!c.clone.path.startsWith("/")) return "Set the clone path (absolute) in Settings.";
  return null;
}

// Where a launch from `daemonCwd` runs in the pod.
export function podCwd(c: Configuration, mode: Mode, repo: RepoInfo, daemonCwd: string): string {
  if (mode === "shared") return daemonCwd;
  const rel = daemonCwd === repo.root ? "" : daemonCwd.startsWith(repo.root + "/") ? daemonCwd.slice(repo.root.length + 1) : "";
  return rel ? `${c.clone.path.replace(/\/+$/, "")}/${rel}` : c.clone.path;
}

const quantities = (r: Sidecar["resources"], kind: "Request" | "Limit") => {
  const out: Record<string, string> = {};
  if (r[`cpu${kind}`]) out.cpu = r[`cpu${kind}`]!;
  if (r[`memory${kind}`]) out.memory = r[`memory${kind}`]!;
  if (r[`ephemeralStorage${kind}`]) out["ephemeral-storage"] = r[`ephemeralStorage${kind}`]!;
  return out;
};

// A regular container (not a native sidecar) so that the pod's Ready condition waits for its probe.
// It gets the main container's workspace mounts at the same absolute paths, never the git or SSH Secrets.
function sidecarContainer(s: Sidecar, mounts: Record<string, unknown>[], volumes: Record<string, unknown>[]) {
  const volumeMounts = s.mountWorkspace ? mounts.filter((m) => m.name !== "git" && m.name !== "ssh").map((m) => ({ ...m })) : [];
  if (s.stateVolume) {
    volumes.push({ name: `state-${s.name}`, emptyDir: { sizeLimit: s.stateVolume.sizeLimit } });
    volumeMounts.push({ name: `state-${s.name}`, mountPath: s.stateVolume.path });
  }
  const requests = quantities(s.resources, "Request");
  const limits = quantities(s.resources, "Limit");
  const p = s.readinessProbe;
  return {
    name: s.name,
    image: s.image,
    ...(s.command ? { command: s.command } : {}),
    ...(s.args ? { args: s.args } : {}),
    ...(s.env.length ? { env: s.env } : {}),
    ...(s.privileged ? { securityContext: { privileged: true } } : {}),
    ...(Object.keys(requests).length || Object.keys(limits).length
      ? { resources: { ...(Object.keys(requests).length ? { requests } : {}), ...(Object.keys(limits).length ? { limits } : {}) } }
      : {}),
    ...(p
      ? {
          readinessProbe: {
            ...(p.exec ? { exec: { command: p.exec } } : { tcpSocket: { port: p.tcpPort } }),
            initialDelaySeconds: p.initialDelaySeconds,
            periodSeconds: p.periodSeconds,
            timeoutSeconds: p.timeoutSeconds,
            failureThreshold: p.failureThreshold,
          },
        }
      : {}),
    ...(volumeMounts.length ? { volumeMounts } : {}),
  };
}

export function buildPod(c: Configuration, workspaceId: string, mode: Mode, repo: RepoInfo) {
  const name = podName(workspaceId);
  const r = c.resources;
  const key = workspaceKey(workspaceId);
  const volumes: Record<string, unknown>[] = [];
  const mounts: Record<string, unknown>[] = [];
  const initContainers: Record<string, unknown>[] = [];
  const env: { name: string; value: string }[] = [];
  const common = { image: c.image, ...(c.runAsUser ? { securityContext: { runAsUser: c.runAsUser, runAsGroup: c.runAsUser } } : {}) };

  // Git over SSH: mounted read-only in the main container and, in clone mode, the clone init container
  // (both receive `mounts` and `env`). Sidecars never get it (see sidecarContainer).
  if (sshConfigured(c)) {
    volumes.push(sshVolume());
    mounts.push(sshMount());
    env.push({ name: "GIT_SSH_COMMAND", value: gitSshCommand() });
  }

  if (mode === "shared") {
    volumes.push({ name: "worktree", persistentVolumeClaim: { claimName: c.worktree.claimName } });
    mounts.push({ name: "worktree", mountPath: repo.root, subPath: subPathFor(c.worktree.basePath, c.worktree.subPath, repo.root) });
    if (repo.gitDir) {
      const claim = c.repo.claimName || c.worktree.claimName;
      volumes.push({ name: "repo-git", persistentVolumeClaim: { claimName: claim } });
      mounts.push({ name: "repo-git", mountPath: repo.gitDir, subPath: subPathFor(c.repo.basePath, c.repo.subPath, repo.gitDir) });
    }
    // The daemon's files may belong to another user than the pod's.
    env.push({ name: "GIT_CONFIG_COUNT", value: "1" }, { name: "GIT_CONFIG_KEY_0", value: "safe.directory" }, { name: "GIT_CONFIG_VALUE_0", value: "*" });
  } else {
    if (!repo.remoteUrl) throw new Error("This workspace has no origin remote to clone.");
    volumes.push(
      c.clone.storage === "pvc"
        ? { name: "clone", persistentVolumeClaim: { claimName: cloneClaimName(workspaceId) } }
        : { name: "clone", emptyDir: {} },
    );
    mounts.push({ name: "clone", mountPath: c.clone.path });
    if (c.clone.gitSecret) {
      volumes.push({ name: "git", secret: { secretName: c.clone.gitSecret, defaultMode: 0o400 } });
      mounts.push({ name: "git", mountPath: "/etc/sandbox-git", readOnly: true });
      env.push({ name: "GIT_CONFIG_GLOBAL", value: "/etc/sandbox-git/gitconfig" });
    }
    initContainers.push({
      ...common,
      name: "clone",
      command: ["sh", "-c", '[ -d "$DEST/.git" ] || { git clone "$URL" "$DEST" && { [ -z "$BRANCH" ] || git -C "$DEST" checkout "$BRANCH"; }; }'],
      env: [...env, { name: "URL", value: repo.remoteUrl }, { name: "DEST", value: c.clone.path }, { name: "BRANCH", value: repo.branch ?? "" }],
      volumeMounts: mounts,
    });
  }
  const sidecars = sidecarsOf(c, workspaceId);
  const mainEnv = sidecars.flatMap((s) => s.mainEnv);
  const mainEnvNames = new Set(mainEnv.map((e) => e.name));
  const mainEnvFull = [...env.filter((e) => !mainEnvNames.has(e.name)), ...mainEnv];
  const sidecarContainers = sidecars.map((s) => sidecarContainer(s, mounts, volumes));
  const o = c.podOverrides;

  return {
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      name,
      labels: { [LABEL_MANAGED]: MANAGED_BY, [LABEL_WORKSPACE]: key },
      annotations: { [ANNOTATION_WORKSPACE]: workspaceId, [ANNOTATION_MODE]: mode },
    },
    spec: {
      restartPolicy: "Always",
      // A shared PID namespace gives the pod a reaping init (the pause process).
      shareProcessNamespace: true,
      terminationGracePeriodSeconds: 5,
      automountServiceAccountToken: false,
      ...(o.runtimeClassName ? { runtimeClassName: o.runtimeClassName } : {}),
      ...(o.priorityClassName ? { priorityClassName: o.priorityClassName } : {}),
      ...(o.tolerations.length ? { tolerations: o.tolerations } : {}),
      ...(Object.keys(o.nodeSelector).length ? { nodeSelector: o.nodeSelector } : {}),
      ...(o.imagePullSecrets.length ? { imagePullSecrets: o.imagePullSecrets } : {}),
      ...(initContainers.length ? { initContainers } : {}),
      containers: [
        {
          ...common,
          name: MAIN_CONTAINER,
          command: ["sh", "-c", `mkdir -p ${STATE_DIR}; while :; do sleep 3600 & wait $!; done`],
          workingDir: mode === "shared" ? repo.root : c.clone.path,
          ...(c.envSecret ? { envFrom: [{ secretRef: { name: c.envSecret } }] } : {}),
          env: mainEnvFull,
          resources: {
            requests: { cpu: r.cpuRequest, memory: r.memoryRequest },
            limits: { cpu: r.cpuLimit, memory: r.memoryLimit },
          },
          volumeMounts: mounts,
        },
        ...sidecarContainers,
      ],
      volumes,
    },
  };
}

export function buildClonePvc(c: Configuration, workspaceId: string) {
  return {
    apiVersion: "v1",
    kind: "PersistentVolumeClaim",
    metadata: {
      name: cloneClaimName(workspaceId),
      labels: { [LABEL_MANAGED]: MANAGED_BY, [LABEL_WORKSPACE]: workspaceKey(workspaceId) },
      annotations: { [ANNOTATION_WORKSPACE]: workspaceId },
    },
    spec: {
      accessModes: ["ReadWriteOnce"],
      resources: { requests: { storage: c.clone.size } },
      ...(c.clone.storageClass ? { storageClassName: c.clone.storageClass } : {}),
    },
  };
}

type PodJson = {
  metadata?: { name?: string; creationTimestamp?: string; annotations?: Record<string, string>; deletionTimestamp?: string };
  status?: { phase?: string; containerStatuses?: { name: string; ready: boolean }[] };
};

function toInfo(p: PodJson): PodInfo {
  const main = p.status?.containerStatuses?.find((s) => s.name === MAIN_CONTAINER);
  return {
    name: p.metadata?.name ?? "",
    workspaceId: p.metadata?.annotations?.[ANNOTATION_WORKSPACE] ?? "",
    phase: p.metadata?.deletionTimestamp ? "Terminating" : (p.status?.phase ?? "Unknown"),
    ready: !!main?.ready && !p.metadata?.deletionTimestamp,
    createdAt: p.metadata?.creationTimestamp ?? "",
    lastUsed: null,
    mode: p.metadata?.annotations?.[ANNOTATION_MODE] === "clone" ? "clone" : "shared",
    sidecars: (p.status?.containerStatuses ?? []).filter((s) => s.name !== MAIN_CONTAINER).map((s) => ({ name: s.name, ready: s.ready })),
  };
}

const selector = `${LABEL_MANAGED}=${MANAGED_BY}`;

export async function listPods(run: Kubectl): Promise<PodInfo[]> {
  const out = JSON.parse(await run(["get", "pods", "-l", selector, "-o", "json"])) as { items?: PodJson[] };
  return (out.items ?? []).map(toInfo).sort((a, b) => a.name.localeCompare(b.name));
}

// Number of live recorded processes and the epoch seconds of the last recorded use, from the pod.
export async function readUsage(run: Kubectl, name: string): Promise<{ live: number; last: number | null }> {
  const script =
    `live=0; for f in ${STATE_DIR}/pid.*; do [ -f "$f" ] && kill -0 "$(cat "$f")" 2>/dev/null && live=$((live+1)); done; ` +
    `last=$(stat -c %Y ${STATE_DIR}/last 2>/dev/null); ` +
    `new=$(ls -t ${STATE_DIR}/pid.* 2>/dev/null | head -n1); ` +
    `[ -n "$new" ] && p=$(stat -c %Y "$new") && { [ -z "$last" ] || [ "$p" -gt "$last" ]; } && last=$p; ` +
    `echo "$live \${last:-0}"`;
  const out = await run(["exec", name, "-c", MAIN_CONTAINER, "--", "sh", "-c", script]);
  const [live, last] = out.trim().split(/\s+/).map(Number);
  return { live: Number.isFinite(live) ? live : 0, last: last ? last : null };
}

export async function listPodsWithUsage(run: Kubectl): Promise<PodInfo[]> {
  const pods = await listPods(run);
  return Promise.all(
    pods.map(async (p) => {
      if (!p.ready) return p;
      try {
        const u = await readUsage(run, p.name);
        return { ...p, lastUsed: u.last ? new Date(u.last * 1000).toISOString() : null };
      } catch {
        return p;
      }
    }),
  );
}

export async function deletePod(run: Kubectl, name: string) {
  // Only pods this plugin manages can be deleted through it.
  const pods = await listPods(run);
  if (!pods.some((p) => p.name === name)) throw new Error("Not a sandbox pod managed by this plugin.");
  await run(["delete", "pod", name, "--wait=false", "--ignore-not-found"]);
}

export async function podLogs(run: Kubectl, name: string): Promise<string> {
  const pods = await listPods(run);
  if (!pods.some((p) => p.name === name)) throw new Error("Not a sandbox pod managed by this plugin.");
  return run(["logs", name, "-c", MAIN_CONTAINER, "--tail=200"]);
}

const pending = new Map<string, Promise<string>>();

// Returns the pod name once the pod is ready, creating it on first use. Concurrent launches share one creation.
export function ensurePod(run: Kubectl, c: Configuration, workspaceId: string, repo: RepoInfo, read?: ReadFile): Promise<string> {
  const name = podName(workspaceId);
  const key = `${c.context}/${c.namespace}/${name}`;
  const running = pending.get(key);
  if (running) return running;
  const mode = modeOf(c, workspaceId);
  const task = (async () => {
    const problem = configError(c, mode);
    if (problem) throw new Error(problem);
    let existing: PodJson | undefined;
    try {
      existing = JSON.parse(await run(["get", "pod", name, "-o", "json"])) as PodJson;
    } catch (e) {
      if (!(e instanceof KubernetesError && e.reason === "missing")) throw e;
    }
    const phase = existing?.status?.phase;
    if (existing && existing.metadata?.annotations?.[ANNOTATION_MODE] !== mode && phase !== "Failed" && phase !== "Succeeded")
      throw new Error(`This workspace's pod uses the ${toInfo(existing).mode} storage mode. Delete the pod (Pods tab) to switch to ${mode}.`);
    if (existing && (phase === "Failed" || phase === "Succeeded" || existing.metadata?.deletionTimestamp)) {
      await run(["delete", "pod", name, "--wait=true", "--ignore-not-found"]);
      existing = undefined;
    }
    if (!existing) {
      const pod = buildPod(c, workspaceId, mode, repo);
      // The Secret must exist before the pod that mounts it.
      await syncSsh(run, c, read);
      if (mode === "clone" && c.clone.storage === "pvc") {
        const have = await run(["get", "pvc", cloneClaimName(workspaceId), "--ignore-not-found", "-o", "name"]);
        if (!have.trim()) await run(["create", "-f", "-"], buildClonePvc(c, workspaceId));
      }
      await run(["create", "-f", "-"], pod);
    }
    await run(["wait", "--for=condition=Ready", `pod/${name}`, "--timeout=300s"]);
    return name;
  })().finally(() => pending.delete(key));
  pending.set(key, task);
  return task;
}

export async function deleteClonePvc(run: Kubectl, workspaceId: string) {
  await run(["delete", "pvc", cloneClaimName(workspaceId), "--wait=false", "--ignore-not-found"]);
}

export type SweepResult = { deleted: string[] };

// Deletes pods whose workspace is gone (when `knownWorkspaces` is given) or that have been idle past the TTL.
export async function sweep(
  run: Kubectl,
  c: Configuration,
  opts: { knownWorkspaces?: Set<string>; now?: number } = {},
): Promise<SweepResult> {
  const now = opts.now ?? Date.now();
  const deleted: string[] = [];
  for (const pod of await listPods(run)) {
    const orphan = opts.knownWorkspaces ? !opts.knownWorkspaces.has(pod.workspaceId) : false;
    let idle = false;
    let busy = false;
    if (pod.ready && (orphan || c.ttlMinutes > 0)) {
      try {
        const u = await readUsage(run, pod.name);
        busy = u.live > 0;
        const since = Math.max((u.last ?? 0) * 1000, Date.parse(pod.createdAt) || 0);
        idle = c.ttlMinutes > 0 && now - since > c.ttlMinutes * 60_000;
      } catch {
        busy = true; // Unknown state: leave the pod alone.
      }
    }
    if (!busy && (orphan || idle)) {
      await run(["delete", "pod", pod.name, "--wait=false", "--ignore-not-found"]);
      deleted.push(pod.name);
    }
  }
  if (opts.knownWorkspaces) {
    // Clone volumes outlive their pod on purpose; they go when the workspace does.
    const out = JSON.parse(await run(["get", "pvc", "-l", selector, "-o", "json"])) as { items?: PodJson[] };
    for (const pvc of out.items ?? []) {
      const id = pvc.metadata?.annotations?.[ANNOTATION_WORKSPACE] ?? "";
      if (pvc.metadata?.name && !opts.knownWorkspaces.has(id)) {
        await run(["delete", "pvc", pvc.metadata.name, "--wait=false", "--ignore-not-found"]);
        deleted.push(pvc.metadata.name);
      }
    }
  }
  return { deleted };
}
