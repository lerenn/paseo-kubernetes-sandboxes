# paseo-kubernetes-sandboxes

Run a Paseo workspace's agents, terminals and commands in a Kubernetes pod.

A plugin for Paseo **0.17.5+**. For workspaces you opt in, it returns a launch wrap from the
`agent.open.before`, `terminal.create.before` and `command.run.before` hooks. Paseo then starts
`[...wrap, command, ...args]`; the wrap runs the command in a pod through `kubectl exec`. The workspace
stays on the main daemon; there is no daemon, gateway or operator in the pod.

## Requirements

- Paseo 0.17.5 or later; `kubectl` on the daemon host; a Kubernetes cluster.
- The Role in `config/plugin-rbac.yaml`, applied in the sandbox namespace.
- A PersistentVolumeClaim holding the daemon's worktrees, mounted by the pods at the same path.
- An image with a shell and the programs your agents need.

## Install and use

```sh
kubectl apply -n paseo-sandbox -f config/plugin-rbac.yaml
cd plugin && npm ci && paseo plugin install "$PWD"
```

Open **Kubernetes Sandbox** from the sidebar: set the image and volume in **Settings**, run **Check
cluster**, then opt workspaces in on the **Workspaces** tab. Full guide: [docs/setup.md](docs/setup.md).

## Limits

- Disabling the plugin makes opted-in workspaces silently run locally again.
- Wrapped shells lose command-completion reporting for `paseo.json` scripts.
- The pod isolates resources and processes but shares the worktree volume: it is not a security boundary.
- Not tested yet against a real daemon and cluster: agents, ports, file views.

## Development

```sh
make test   # typecheck, unit tests (fake kubectl, no cluster), version check
```

`plugin/` holds the plugin (`index.server.ts`, `index.client.tsx`, `launcher/kube-exec.sh`). CI runs tests,
a plugin build check, a manifest check and a version check. Bumping `plugin/package.json` on `main` tags and
releases that version. The static site in `website/` is previewed with
`python3 -m http.server 8091 --directory website`.
