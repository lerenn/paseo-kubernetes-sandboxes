# Paseo Kubernetes Sandbox

Run opted-in Paseo agents, terminals and commands in a Kubernetes pod. The Paseo daemon keeps the workspace and its file views. The pod mounts the same worktree at the same absolute path.

An administrator installs the controller with Helm, defines sandbox profiles and issues scoped bearer tokens. The Paseo plugin connects to the controller over private HTTPS. The controller's namespaced Kubernetes identity creates, executes in and deletes sandbox pods.

## Install and use

- Administrators need Kubernetes 1.34 or later, Helm 3 or later, shared persistent storage and an endpoint reachable from the Paseo daemon. The endpoint must carry HTTP/2.
- Paseo users need Paseo 0.17.5 or later and Node.js on the daemon host. Set the controller URL, token file, CA file if required and a profile in **Kubernetes Sandbox**. Check the connection, save it and opt in the workspaces you want.

[Set up the controller and plugin](docs/setup.md).

The controller creates a pod on first use. Agents and terminals in the same workspace share the pod. Archiving the workspace, disabling its opt-in or using **Stop sandbox** requests pod deletion. The profile's idle timeout also reclaims unused pods. Worktree data persists on the shared volume.

## Development and releases

Run `make test` from the repository root. CI also compiles the plugin with the Paseo compiler, builds the controller image, and renders and packages the chart.

Keep the plugin, controller and chart versions aligned. Merging a version bump to `main` publishes the controller image and OCI Helm chart, then creates the GitHub release. Use the **Release** workflow on `main` to retry interrupted publication. The site is served from `website/` and can be previewed with `python3 -m http.server 8091 --directory website`.
