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
- A namespace where the identity kubectl uses can manage pods, pods/exec, pods/log and persistent volume
  claims (see [Cluster rights](#cluster-rights-only-if-your-identity-lacks-them)).
- A container image with a shell, `git` and every program your agents and terminals run (the agent CLI,
  build tools). The plugin does not ship an image.
- Shared worktree mode: a PersistentVolumeClaim holding the daemon's worktrees and repositories
  (see [`config/example-pvc.yaml`](../config/example-pvc.yaml)).
- Pod-local clone mode: git access to the repository from the cluster (a Secret for private repositories).

## Install

```sh
cd plugin && npm ci
paseo plugin install "$PWD"
```

### Cluster rights (only if your identity lacks them)

Needed only when **Check cluster** reports missing rights, for example not with cluster-admin or when a
GitOps repository already applies the Role. The plugin cannot grant itself rights, and **Check cluster**
only verifies them (read-only, `kubectl auth can-i`). A cluster admin runs:

```sh
kubectl create namespace paseo-sandboxes
kubectl apply -n paseo-sandboxes -f config/plugin-rbac.yaml
kubectl create rolebinding paseo-sandboxes -n paseo-sandboxes \
  --role=paseo-sandboxes --user=<the identity kubectl uses>
```

## Configure

Open **Kubernetes Sandbox** in the Paseo sidebar.

1. **Settings**: image, CPU and memory, the default storage mode and its settings (below), run-as user,
   idle timeout, optional environment Secret, optional sidecars and pod overrides (see Sidecars).
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

- Created lazily on the first wrapped launch, labelled `app.kubernetes.io/managed-by=paseo-sandboxes`,
  one per workspace id, shared by every conversation, terminal and command of that workspace.
- Deleted when its workspace is archived (`workspace.archive.after`), when it has run nothing for the idle
  timeout, or from the **Pods** tab. Pods and clone volumes of workspaces that no longer exist are removed
  by the first sweep after the plugin starts.
- Changing settings affects pods created afterwards, not existing ones: delete a pod to rebuild it.

## Sidecars

A sidecar is an extra container in each sandbox pod. The mechanism is generic: you define named templates
(**Sidecar templates**, JSON, in Settings), choose which are on by default (`defaultSidecars`), and
override the choice per workspace (Workspaces tab, `workspaces[].sidecars`; `[]` means none). Docker is
only an example configuration, not a built-in preset. The old `dind` setting no longer exists; a saved
config that still has it loads and the key is ignored.

Template fields: `name` (DNS label, unique, not `main`, `clone`, `worktree`, `repo-git` or `git`),
`image`, `command`, `args`, `env`, `privileged` (explicit, default `false`), `resources`
(`cpuRequest`, `cpuLimit`, `memoryRequest`, `memoryLimit`, `ephemeralStorageRequest`,
`ephemeralStorageLimit`), `mountWorkspace` (default `true`), `readinessProbe` (either `exec`, a command, or
`tcpPort`, plus timings), `stateVolume` (`path` and `sizeLimit`, an `emptyDir` mounted in the sidecar only,
default limit `20Gi`) and `mainEnv` (environment added to the main container while the sidecar is on).

- Sidecars are regular containers, not native sidecars. Pod readiness waits for every readiness probe, so
  the first launch waits for them. The Pods tab shows the readiness of each sidecar.
- With `mountWorkspace`, the sidecar gets the same volume mounts as the main container at the same
  absolute paths (shared and clone mode). It never gets the git Secret.
- A sidecar does not get the plugin's run-as-user setting: it runs as its image does.
- **Pod overrides** apply to every sandbox pod and are limited to `runtimeClassName`, `tolerations`,
  `nodeSelector`, `priorityClassName` and `imagePullSecrets`. Other keys are dropped. There is no raw
  merge and no per-workspace override.
- Changes apply to pods created afterwards; delete a pod to rebuild it.

### Example: docker

```json
{
  "sidecars": [{
    "name": "docker",
    "image": "docker:27-dind",
    "privileged": true,
    "env": [{ "name": "DOCKER_TLS_CERTDIR", "value": "" }],
    "mainEnv": [{ "name": "DOCKER_HOST", "value": "tcp://127.0.0.1:2375" }],
    "readinessProbe": { "exec": ["docker", "info"], "initialDelaySeconds": 2, "periodSeconds": 2, "failureThreshold": 30 },
    "stateVolume": { "path": "/var/lib/docker", "sizeLimit": "20Gi" },
    "resources": { "cpuRequest": "100m", "memoryRequest": "256Mi", "cpuLimit": "2", "memoryLimit": "4Gi" }
  }],
  "defaultSidecars": []
}
```

Then enable `docker` for the workspaces that need it (Workspaces tab), or put it in `defaultSidecars`.

Requirements:

- The **main image needs a docker CLI**. The sidecar provides only the daemon, reached over
  `tcp://127.0.0.1:2375` (the pod shares a network namespace).
- The namespace's Pod Security level must allow **privileged** pods, otherwise the pod is rejected at creation.

**Isolation.** A privileged sidecar is root-equivalent on the node: a container escape from it is a node
compromise. This is weaker isolation than the base pod. The daemon on `127.0.0.1:2375` has no
authentication: any process in the pod can use it. The pod's processes share one PID namespace, and with
`mountWorkspace` the sidecar can write the repository's `.git` directory (including hooks) in shared mode.
Do not treat this setup as a security boundary.

**Not tested** (nothing below has been run in a real cluster; the unit tests only check the generated pod):

- Docker bind mounts (`docker run -v "$PWD":/w`) of paths that come from `subPath` volume mounts.
- File ownership of files written by containers started through the sidecar.
- Behaviour of the `docker:dind` entrypoint in a shared PID namespace.
- Whether the 25-second launch timeout is too short when the sidecar image is pulled cold (the launch then
  fails with "still starting"; the pod continues to start).
- Eviction when the state volume or ephemeral storage limit is exceeded.
- Whether a namespace that denies privileged pods gives a readable error.
- Nested resource limits: the sidecar's limits apply to the sidecar container, not per docker container.

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
