# Paseo Kubernetes Sandbox

Run opted-in Paseo agents, terminals and commands in a Kubernetes pod. The Paseo daemon keeps the workspace and its file views. The pod mounts the same worktree at the same absolute path.

An administrator installs the Gateway and backend controllers with Helm. The Paseo plugin uses one scoped credential over private HTTPS. The Gateway routes Standard and explicitly selected Docker profiles to their controllers over mutual TLS.

## Install and use

- Administrators need Kubernetes 1.34 or later, Helm 3 or later, shared persistent storage and an endpoint reachable from the Paseo daemon. The endpoint must carry HTTP/2.
- Paseo users need Paseo 0.18.0 or later and Node.js on the daemon host. Check and save the Gateway URL, token file and CA file if required in **Kubernetes Sandbox**. Choose an authorized profile in **New workspace → Execution**, or assign a profile to an existing workspace from **Kubernetes Sandbox → Workspaces**.

[Set up the Gateway, controllers and plugin](docs/setup.md).

The controller creates a pod on first use. Agents and terminals in the same workspace share the pod. Archiving the workspace, disabling its opt-in or using **Stop sandbox** requests pod deletion. The profile's idle timeout also reclaims unused pods. Worktree data persists on the shared volume. To change profiles, confirm stopping an existing sandbox first. Running processes and ephemeral state are lost when the pod is deleted.

## Development and releases

Run `make test` from the repository root. CI also compiles the plugin with the Paseo compiler, builds the controller image, and renders and packages the chart.

Keep the plugin, controller and chart versions aligned. Merging a version bump to `main` publishes the controller image and OCI Helm chart, then creates the GitHub release. Use the **Release** workflow on `main` to retry interrupted publication. The site is served from `website/` and can be previewed with `python3 -m http.server 8091 --directory website`.
