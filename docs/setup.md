# Set up Paseo Kubernetes Sandbox

## Administrator setup

Use a dedicated namespace on Kubernetes 1.34 or later. The Helm chart installs one controller, a ClusterIP Service, TLS configuration and a namespace-scoped Role. The Role lets the controller manage pods, open exec sessions and read its own Service. Paseo connects with a controller token and needs no Kubernetes credentials.

### Prepare shared storage and a profile

The daemon and the sandbox pods need concurrent access to the same files. Use a ReadWriteMany volume when they can run on different nodes. Pre-create the PVCs in the controller namespace and make the paths writable by the UID and GID in the sandbox image.

For a PVC mounted on the daemon at `/srv/paseo/worktrees`, a worktree at `/srv/paseo/worktrees/feature` is mounted in the pod at that same absolute path from the PVC subdirectory `feature`. Use a mapping's `subPath` when the daemon's base directory corresponds to a subdirectory of the claim. Paths must sit below the configured base directory.

Linked Git worktrees also need a `repository` mapping. The controller mounts the common Git directory at its original absolute path so the worktree's `.git` pointer resolves. The repository mapping may use the same PVC with a different base or subdirectory. Use an image containing a POSIX shell, `env`, Git, and the tools your agents require. Provide image pull secrets, resources, sidecars and pod placement through the profile where needed. Name the default profile `standard` so Paseo can preselect it when authorized. Standard containers run with privilege escalation disabled, all capabilities dropped and the runtime default seccomp profile. Sandbox pods do not mount a ServiceAccount token.

Treat each profile's storage roots as authorization boundaries. A token holder may request worktrees and repository metadata anywhere below the roots of its permitted profiles. Use separate storage roots for mutually untrusted daemons. Tokens partition pod operations by principal. The shared checkout and common Git directory remain writable from both the daemon and pod. Use dedicated credentials inside sandbox images or administrator-managed mounts where Git or package registries require them. Forwarded command environment values and arguments are present in Kubernetes exec requests and can appear in API audit logs.

### Optional Docker profile for trusted workspaces

Define a separate profile with `docker.enabled: true` and a Docker-in-Docker image in `docker.image`. The main image needs the Docker CLI. The chart example includes the optional settings. Include the Docker profile in only the principal allowlists that need it. Paseo displays **Docker (privileged)** and requires a user to select it.

The sidecar runs privileged and shares the workspace's exact worktree mount path and PVC subdirectory, so Docker bind mounts reference the same files. It listens on a Unix socket shared with the main container. The controller sets `DOCKER_HOST` and keeps daemon-host Docker settings from overriding it. Set `docker.socketGroup` and the main container's supplemental groups for non-root access. Docker and containerd data live on a separate disk-backed `emptyDir`. Use `docker.sizeLimit` to bound that storage and `docker.resources` to set resource requests and limits.

Docker requires a cluster and namespace that allow privileged containers. Give access only to trusted daemons and workspaces. A privileged sidecar has broad node access. Docker images, containers and volumes in this sandbox are discarded when the sandbox pod is deleted.

### Issue a scoped token

Generate a distinct token for each daemon. Keep the raw token in a file readable only by the daemon identity, and configure its SHA-256 digest and permitted profiles in your values.

```sh
umask 077
openssl rand -hex 32 > controller.token
tr -d '\n' < controller.token | sha256sum
```

Copy [the example values](../config/controller-values.example.yaml) and set the profile's image, claims and base paths. Replace the example token digest. Keep a principal name stable when rotating its token to retain access to that principal's existing pods. Change the digest with a Helm upgrade and replace the daemon's token file. A controller restart closes existing exec streams.

### Install the chart

```sh
helm upgrade --install sandbox \
  oci://ghcr.io/lerenn/paseo-kubernetes-sandboxes/charts/paseo-sandbox-controller \
  --version 0.5.0 --namespace paseo-sandboxes --create-namespace \
  --values controller-values.yaml --wait
```

For a source build, use `charts/paseo-sandbox-controller` as the chart path and set `image` to your controller image reference. For private registry packages, authenticate Helm before pulling the chart and create an image pull Secret in the namespace, and reference it in the controller chart's `imagePullSecrets`.

The default endpoint for an in-cluster daemon is `https://sandbox-sandbox-controller.paseo-sandboxes.svc`. Export the chart-generated CA from the install context and place it on the daemon host.

```sh
kubectl -n paseo-sandboxes get secret sandbox-sandbox-controller-tls \
  -o jsonpath='{.data.ca\.crt}' | base64 -d > controller-ca.crt
```

For a daemon outside the cluster, use a private route to the Service, such as TLS passthrough on a private load balancer. With a custom hostname, set `tlsSecretName` to a Secret in the controller namespace containing `tls.crt` and `tls.key` for that hostname. Ensure intermediaries support bidirectional HTTP/2 streaming and allow long-lived terminal sessions. Restart the controller after replacing a custom TLS Secret in place.

Verify the private route from the daemon before installing the plugin.

```sh
curl --cacert controller-ca.crt https://sandbox-sandbox-controller.paseo-sandboxes.svc/healthz
```

### Lifecycle

The controller names and owns sandbox pods per release, principal and workspace. It deletes a pod when the workspace is archived or stopped. An idle pod is eligible for deletion after the profile's `idleMinutes` interval, measured from its last launch or command completion. Open terminals and active commands keep the pod alive. Set `idleMinutes: 0` to retain idle pods until explicitly deleted. The controller scans once a minute and restarts the idle clock on rollout. Deleting the Helm release's Service also garbage-collects its sandbox pods. PersistentVolumeClaims pre-exist the chart and retain the worktrees.

## Paseo user setup

1. Install the plugin from the release checkout on the daemon host with `paseo plugin install "$PWD/plugin"`. The manifest installs the plugin dependencies. Paseo 0.17.5 and Node.js 22 or later are supported.
2. Open **Kubernetes Sandbox** and enter the controller HTTPS URL, absolute daemon-local token path, and absolute daemon-local CA path if the endpoint uses a private CA.
3. Run **Check connection** to verify TLS, the token and its permitted profiles. Save the connection. Select **Enable sandbox** for a workspace, choose a profile backed by its shared storage, and confirm. Paseo offers only profiles allowed by the token and saves the choice for that workspace.
4. Open a new terminal or start an agent. **Refresh status** shows the sandbox state. **Stop sandbox** terminates that workspace's current pod and sessions. A later launch recreates it while the workspace stays opted in. To change profiles, first confirm **Stop and delete sandbox**, wait for **No sandbox** and select **Change profile**. Running processes and ephemeral state are lost on deletion. Shared worktree files are kept.

Existing sessions keep their launch location until reopened. Opted-in launches fail if their controller or storage is unavailable. Disabling the plugin removes its launch hooks. Preserve the plugin installation and opt-in settings if those workspaces must keep running in Kubernetes.

### Upgrade from releases before 0.5

Install the controller and prepare shared storage before upgrading the plugin. Existing opt-ins carry over by workspace ID. Choose a profile for each existing opt-in before launching again. For old clone-mode workspaces, preserve any pod-local changes and move the checkout to the shared storage before enabling launches. Earlier pods, legacy RBAC, SSH Secrets and per-sandbox PVCs were managed by the old plugin. Inventory them and review ownership and data retention before removing them. The controller adopts only its own pods.
