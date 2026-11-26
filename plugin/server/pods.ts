import type { Configuration } from "../shared/settings.js";
import {
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

export type PodInfo = {
  name: string;
  workspaceId: string;
  phase: string;
  ready: boolean;
  createdAt: string;
  lastUsed: string | null;
};

export const DIND_IMAGE = "docker:27-dind";

export function configError(c: Configuration): string | null {
  if (!c.image) return "Set the sandbox image in Settings.";
  if (!c.worktree.claimName) return "Set the worktree volume claim in Settings.";
  if (!c.worktree.mountPath.startsWith("/")) return "Set the worktree mount path (absolute) in Settings.";
  return null;
}

export function buildPod(c: Configuration, workspaceId: string) {
  const name = podName(workspaceId);
  const r = c.resources;
  return {
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      name,
      labels: { [LABEL_MANAGED]: MANAGED_BY, [LABEL_WORKSPACE]: workspaceKey(workspaceId) },
      annotations: { [ANNOTATION_WORKSPACE]: workspaceId },
    },
    spec: {
      restartPolicy: "Always",
      // A shared PID namespace gives the pod a reaping init (the pause process).
      shareProcessNamespace: true,
      terminationGracePeriodSeconds: 5,
      automountServiceAccountToken: false,
      containers: [
        {
          name: MAIN_CONTAINER,
          image: c.image,
          command: ["sh", "-c", `mkdir -p ${STATE_DIR}; while :; do sleep 3600 & wait $!; done`],
          workingDir: c.worktree.mountPath,
          ...(c.envSecret ? { envFrom: [{ secretRef: { name: c.envSecret } }] } : {}),
          ...(c.dind ? { env: [{ name: "DOCKER_HOST", value: "tcp://127.0.0.1:2375" }] } : {}),
          resources: {
            requests: { cpu: r.cpuRequest, memory: r.memoryRequest },
            limits: { cpu: r.cpuLimit, memory: r.memoryLimit },
          },
          volumeMounts: [
            {
              name: "worktrees",
              mountPath: c.worktree.mountPath,
              ...(c.worktree.subPath ? { subPath: c.worktree.subPath } : {}),
            },
          ],
        },
        ...(c.dind
          ? [
              {
                name: "dind",
                image: DIND_IMAGE,
                env: [{ name: "DOCKER_TLS_CERTDIR", value: "" }],
                securityContext: { privileged: true },
              },
            ]
          : []),
      ],
      volumes: [{ name: "worktrees", persistentVolumeClaim: { claimName: c.worktree.claimName } }],
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
export function ensurePod(run: Kubectl, c: Configuration, workspaceId: string): Promise<string> {
  const name = podName(workspaceId);
  const key = `${c.context}/${c.namespace}/${name}`;
  const running = pending.get(key);
  if (running) return running;
  const task = (async () => {
    const problem = configError(c);
    if (problem) throw new Error(problem);
    let existing: PodJson | undefined;
    try {
      existing = JSON.parse(await run(["get", "pod", name, "-o", "json"])) as PodJson;
    } catch (e) {
      if (!(e instanceof KubernetesError && e.reason === "missing")) throw e;
    }
    const phase = existing?.status?.phase;
    if (existing && (phase === "Failed" || phase === "Succeeded" || existing.metadata?.deletionTimestamp)) {
      await run(["delete", "pod", name, "--wait=true", "--ignore-not-found"]);
      existing = undefined;
    }
    if (!existing) await run(["create", "-f", "-"], buildPod(c, workspaceId));
    await run(["wait", "--for=condition=Ready", `pod/${name}`, "--timeout=120s"]);
    return name;
  })().finally(() => pending.delete(key));
  pending.set(key, task);
  return task;
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
  return { deleted };
}
