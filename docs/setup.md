# Setup

Kubernetes Sandbox runs the agents, terminals and commands of selected Paseo workspaces in a
Kubernetes pod through `kubectl exec`. A workspace chooses how its files get to the pod: a **shared
worktree** (the pod works on the daemon's files) or a **pod-local clone** (the pod works on its own
copy). Either way there is one pod per workspace, shared by all its conversations, terminals and
commands.

## Requirements

- Paseo **0.17.5 or later** on the daemon host. The plugin manifest enforces it. The plugin uses launch
  wraps (`wrap` in the `agent.open.before`, `terminal.create.before` and `command.run.before` hooks).
- `kubectl` on the daemon host, authenticated to a cluster (Node 22+ only for plugin development).
- A namespace, and the Role in [`config/plugin-rbac.yaml`](../config/plugin-rbac.yaml) bound to the identity
  kubectl uses.
- A container image with a shell, `git` and every program your agents and terminals run (the agent CLI,
  build tools). The plugin does not ship an image.
- Shared worktree mode: a PersistentVolumeClaim holding the daemon's worktrees and repositories
  (see [`config/example-pvc.yaml`](../config/example-pvc.yaml)).
- Pod-local clone mode: git access to the repository from the cluster (a Secret for private repositories).

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

1. **Settings**: image, CPU and memory, the default storage mode and its settings (below), run-as user,
   idle timeout, optional environment Secret, optional Docker-in-Docker sidecar.
2. **Cluster**: context and namespace, then **Check cluster** (kubectl, access, RBAC, volume claim).
3. **Workspaces**: tick the workspaces that run in a pod, pick a storage mode for each (or keep the
   default), then **Save changes**. The mode of each workspace shows on the Overview and Pods tabs.

The first agent, terminal or command launched in an opted-in workspace creates its pod (`sbx-<hash>`) and
waits for it to be ready. If that takes more than about 25 seconds the launch fails with a "still
starting" message; retry once the pod is ready. Only ticked workspaces are wrapped; everything else runs
locally, and the plugin never wraps all workspaces by default.

## Storage mode 1: shared worktree (default)

A Paseo worktree lives under the daemon's worktrees folder, and its `.git` is a *file* pointing, by
absolute path, into the main repository's `.git` directory, which is outside the worktree folder. Mounting
only the worktree folder therefore does not work. The pod mounts two things, each at its own absolute path
(the same path the daemon uses):

- the workspace's worktree folder, and
- the main repository's `.git` directory, read-write (commits write objects, refs, index and logs).

It does **not** mount the main checkout's working tree. The plugin finds the `.git` directory by reading
the worktree's `.git` pointer on the daemon host (`gitdir: <repo>/.git/worktrees/<name>`).

Settings:

| Setting | Meaning |
| --- | --- |
| Worktree claim, base path, sub path | The PVC holding worktrees, where the daemon sees it, and the claim directory that base path maps to. The pod mounts each workspace's folder with the matching `subPath`. |
| Repository claim, base path, sub path | The same for the repositories. An empty claim reuses the worktree claim. |
| Run as user ID | The pod runs as this uid/gid (default 1000, the usual owner of the daemon's files). `0` keeps the image's user. Pods also set git's `safe.directory` to `*` through environment variables. |

Both a ReadWriteOnce single-node volume (all pods on the node that holds it) and a ReadWriteMany volume
(NFS and the like) can work; the plugin does not check this.

**Exposure.** The sandbox can read and write the whole repository: all branches and history, the repository
config (remotes and possibly credentials), other worktrees' metadata and `.git/hooks`. This is resource
and process isolation, not a security boundary. Do not store credentials in the repository config.

## Storage mode 2: pod-local clone

No volume is shared with the daemon. An init container clones the repository into the pod's own storage
at the **clone path** (default `/workspace`) and checks out the workspace's branch. The plugin reads the
`origin` URL and the branch from the workspace on the daemon host; a URL with embedded credentials is
refused. Launches start in the clone (a launch from a sub-directory of the workspace starts in the same
sub-directory of the clone).

- **Storage**: pod storage (an `emptyDir`, the default) or a per-sandbox volume (a PVC named
  `sbx-<hash>-clone`, ReadWriteOnce, with a configurable size and storage class). The volume survives pod
  deletion (idle timeout, Pods tab) and is deleted when the workspace is archived or found orphaned.
- **Git credentials**: for private repositories, put them in a Secret and set **Git Secret**. It is mounted
  at `/etc/sandbox-git` and, if it has a `gitconfig` key, used as `GIT_CONFIG_GLOBAL` (for example a
  credential helper that reads another key of the Secret). Never put credentials in the URL or in
  arguments.
- **Getting results back**: through git (commit, push, PR).

**Limits of this mode.** Paseo's file tree, diffs and git status read the daemon's disk, so they do **not**
show what the agents did in the pod. Deleting the pod loses unpushed work unless a per-sandbox volume is
used. Live editing of the daemon's files is not provided in this mode.

## Switching mode

A workspace's mode is fixed while its pod exists: changing it makes the next launch fail with a message
asking you to delete the pod first (Pods tab). Delete clone pods only after pushing.

## Pod lifecycle

- Created lazily on the first wrapped launch, labelled `app.kubernetes.io/managed-by=paseo-kubernetes-sandbox`,
  one per workspace id, shared by every conversation, terminal and command of that workspace.
- Deleted when its workspace is archived (`workspace.archive.after`), when it has run nothing for the idle
  timeout, or from the **Pods** tab. Pods and clone volumes of workspaces that no longer exist are removed
  by the first sweep after the plugin starts.
- Changing settings affects pods created afterwards, not existing ones: delete a pod to rebuild it.

## Secrets

Forwarded environment values travel as `kubectl exec` arguments: they are visible to local `ps` and in
the pod. Put credentials in a Secret (**Environment Secret**, or **Git Secret** for git) instead.

## Limits

- If the plugin is disabled or removed, opted-in workspaces silently run on the daemon host again.
- A wrapped shell has no Paseo shell integration: a `paseo.json` script run in a pod does not report when
  its command finishes.
- A pod isolates CPU, memory and processes. It is not a security boundary (see the exposure above).
- If the launcher is killed with SIGKILL, the remote process keeps running until the pod is deleted.
  TERM, INT and HUP are handled by killing the remote process.
- Worktree teardown commands use an existing pod and run locally if there is none (not verified against a
  real daemon: the order of archive and teardown is unconfirmed).
- Not tested: specific agents, port forwarding, file views, long idle connections, clone mode on a real
  cluster.
- **Unverified basis.** Paseo's source for worktree creation was not read. The shared layout comes from the
  documentation and one live worktree (worktrees under `$PASEO_HOME/worktrees/<hash>/<name>`, `.git` file
  with an absolute `gitdir:`, git 2.39.5, no relative worktree paths).
