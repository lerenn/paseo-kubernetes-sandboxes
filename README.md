# paseo-kubernetes-sandboxes

Run a Paseo workspace's agents, terminals and commands in a Kubernetes pod.

A plugin for Paseo **0.17.5+**. For workspaces you opt in, it returns a launch wrap from the
`agent.open.before`, `terminal.create.before` and `command.run.before` hooks. Paseo then starts
`[...wrap, command, ...args]`; the wrap runs the command in a pod through `kubectl exec`. The workspace
stays on the main daemon; there is no daemon, gateway or operator in the pod. One pod per workspace serves all its conversations, terminals and commands.

## Requirements

- Paseo 0.17.5 or later; `kubectl` on the daemon host; a Kubernetes cluster.
- The Role in `config/plugin-rbac.yaml`, applied in the sandbox namespace.
- An image with a shell, git and the programs your agents need.
- For the shared worktree mode: a PersistentVolumeClaim holding the worktrees and repositories.
  For the pod-local clone mode: git access from the cluster (a Secret for private repositories).

## Storage modes (per workspace)

- **Shared worktree** (default): the pod mounts the workspace's worktree folder and the main repository's
  `.git` directory at their own absolute paths (a worktree's `.git` file points outside its folder, so
  both are needed). Not the main checkout's working tree. The pod can read and write the whole repository
  (all branches, history, config, hooks): resource and process isolation, not a security boundary.
- **Pod-local clone**: the pod clones the repository into its own storage (`emptyDir`, or an optional
  per-sandbox volume) and works there. Paseo's file tree, diffs and git status read the daemon's disk, so
  they do not show what agents did in the pod; results come back through git. Deleting the pod loses
  unpushed work unless a volume is used.

## Install and use

```sh
kubectl apply -n paseo-sandbox -f config/plugin-rbac.yaml
cd plugin && npm ci && paseo plugin install "$PWD"
```

Open **Kubernetes Sandbox** from the sidebar: set the image and storage in **Settings**, run **Check
cluster**, then opt workspaces in and pick their mode on the **Workspaces** tab. Full guide: [docs/setup.md](docs/setup.md).

## Limits

- Disabling the plugin makes opted-in workspaces silently run locally again.
- Wrapped shells lose command-completion reporting for `paseo.json` scripts.
- Resource and process isolation, not a security boundary: in shared mode the pod shares the repository with the daemon.
- Not tested yet against a real daemon and cluster: agents, ports, file views, clone mode. The layouts come from the docs and one live worktree; Paseo's worktree-creation source was not read.

## Development

```sh
make test   # typecheck, unit tests (fake kubectl, no cluster), version check
```

`plugin/` holds the plugin (`index.server.ts`, `index.client.tsx`, `launcher/kube-exec.sh`). CI runs tests,
a plugin build check, a manifest check and a version check. Bumping `plugin/package.json` on `main` tags and
releases that version.

## Auto-merge

Add the `automerge` label to one of the owner's PRs and GitHub squash-merges it once the required checks on
its base branch pass (`.github/workflows/automerge.yaml`; "Allow auto-merge" must be on). Without required
checks on the base branch it merges as soon as the PR is mergeable. A merge that bumps `plugin/package.json`
on `main` is tagged and released by `release.yaml`; if a merge made with the workflow token does not trigger
it, run Release by hand (`workflow_dispatch`).
