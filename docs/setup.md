# Setup

Kubernetes Sandbox runs the agents, terminals and commands of selected Paseo workspaces in a
Kubernetes pod. The workspace files stay on the Paseo daemon host's worktree volume; the pod mounts
that volume at the same path and executes programs there through `kubectl exec`.

## Requirements

- Paseo **0.17.5 or later** on the daemon host. The plugin manifest enforces it. The plugin uses launch
  wraps (`wrap` in the `agent.open.before`, `terminal.create.before` and `command.run.before` hooks).
- `kubectl` on the daemon host, authenticated to a cluster (Node 22+ only for plugin development).
- A namespace, and the Role in [`config/plugin-rbac.yaml`](../config/plugin-rbac.yaml) bound to the identity
  kubectl uses.
- A PersistentVolumeClaim in that namespace holding the daemon's worktrees, mountable by the pods
  (ReadWriteMany, or everything on one node). See [`config/example-pvc.yaml`](../config/example-pvc.yaml).
- A container image with a shell and every program your agents and terminals run (git, the agent CLI,
  build tools). The plugin does not ship an image.

## Install

```sh
kubectl create namespace paseo-sandbox
kubectl apply -n paseo-sandbox -f config/plugin-rbac.yaml
kubectl create rolebinding paseo-kubernetes-sandbox -n paseo-sandbox \
  --role=paseo-kubernetes-sandbox --user=<the identity kubectl uses>

cd plugin && npm ci
paseo plugin install "$PWD"
```

## Configure

Open **Kubernetes Sandbox** in the Paseo sidebar.

1. **Settings**: image, CPU and memory, worktree claim, mount path (where the daemon sees the volume),
   optional sub path, idle timeout, optional environment Secret, optional Docker-in-Docker sidecar.
2. **Cluster**: context and namespace, then **Check cluster** (kubectl, access, RBAC, volume claim).
3. **Workspaces**: tick the workspaces that run in a pod, then **Save changes**.

The first agent, terminal or command launched in an opted-in workspace creates its pod (`sbx-<hash>`) and
waits for it to be ready. If that takes more than about 25 seconds the launch fails with a "still
starting" message; retry once the pod is ready.

## Opt-in

Only ticked workspaces are wrapped. Everything else runs locally, as before. The plugin never wraps
all workspaces by default.

## Pod lifecycle

- Created lazily on the first wrapped launch, labelled `app.kubernetes.io/managed-by=paseo-kubernetes-sandbox`.
- Deleted when its workspace is archived (`workspace.archive.after`), when it has run nothing for the idle
  timeout, or from the **Pods** tab. Pods of workspaces that no longer exist are removed by the first sweep
  after the plugin starts.
- Changing settings affects pods created afterwards, not existing ones: delete a pod to rebuild it.

## Secrets

Forwarded environment values travel as `kubectl exec` arguments: they are visible to local `ps` and in
the pod. Put credentials in a Secret and set **Environment Secret** instead; its keys become environment
variables in the pod.

## Limits

- If the plugin is disabled or removed, opted-in workspaces silently run on the daemon host again.
- A wrapped shell has no Paseo shell integration: a `paseo.json` script run in a pod does not report when
  its command finishes.
- A pod isolates CPU, memory and processes. It shares the worktree volume with the daemon. This is not a
  security boundary for that data.
- If the launcher is killed with SIGKILL, the remote process keeps running until the pod is deleted.
  TERM, INT and HUP are handled by killing the remote process.
- Worktree teardown commands use an existing pod and run locally if there is none (not verified against a
  real daemon: the order of archive and teardown is unconfirmed).
- Not tested: specific agents, port forwarding, file views, long idle connections.
