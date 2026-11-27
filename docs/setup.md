# Set up Paseo Kubernetes Sandbox

## Administrator setup

Use Kubernetes 1.34 or later. A complete Helm installation requires one Gateway release and a Standard backend release. Deploy Docker as a separate backend release in a namespace approved for its privileged sidecar. Each backend controller manages its own pods through namespace-scoped RBAC. Expose the Gateway to Paseo over private HTTPS with bidirectional HTTP/2.

### Prepare shared storage and a profile

The daemon and the sandbox pods need concurrent access to the same files. Use a ReadWriteMany volume when they can run on different nodes. Pre-create the PVCs in the controller namespace and make the paths writable by the UID and GID in the sandbox image.

For a PVC mounted on the daemon at `/srv/paseo/worktrees`, a worktree at `/srv/paseo/worktrees/feature` is mounted in the pod at that same absolute path from the PVC subdirectory `feature`. Use a mapping's `subPath` when the daemon's base directory corresponds to a subdirectory of the claim. Paths must sit below the configured base directory.

Linked Git worktrees also need a `repository` mapping. The controller mounts the common Git directory at its original absolute path so the worktree's `.git` pointer resolves. The repository mapping may use the same PVC with a different base or subdirectory. Use an image containing a POSIX shell, `env`, Git, and the tools your agents require. Provide image pull secrets, resources, sidecars and pod placement through the profile where needed. Name the default profile `standard` so Paseo can preselect it when authorized. Standard containers run with privilege escalation disabled, all capabilities dropped and the runtime default seccomp profile. Sandbox pods do not mount a ServiceAccount token.

Set CPU, memory and ephemeral-storage requests and limits in `container.resources` for the main container, `sidecars[].resources` for ordinary sidecars, `docker.resources` for the managed Docker sidecar, and `podSpec.initContainers[].resources` for init containers. The Profiles table lists these administrator-configured values per container starting with controller and plugin v0.5.6. **Unset** means the field is omitted from the container configuration. Kubernetes admission can supply defaults. **Unavailable from controller** means the controller did not return resource metadata.

Ephemeral storage covers local pod storage usage such as writable layers, logs and disk-backed `emptyDir` volumes. Persistent worktrees and repositories use shared RWX PVCs. `docker.sizeLimit` caps the separate Docker state `emptyDir` volume and is configured separately from container ephemeral-storage requests and limits.

Treat each profile's storage roots as authorization boundaries. A token holder may request worktrees and repository metadata anywhere below the roots of its permitted profiles. Use separate storage roots for mutually untrusted daemons. Tokens partition pod operations by principal. The shared checkout and common Git directory remain writable from both the daemon and pod. Use dedicated credentials inside sandbox images or administrator-managed mounts where Git or package registries require them. Forwarded command environment values and arguments are present in Kubernetes exec requests and can appear in API audit logs.

### Optional Docker profile for trusted workspaces

Define a separate profile with `docker.enabled: true` and a Docker-in-Docker image in `docker.image`. The main image needs the Docker CLI. The chart example includes the optional settings. Include the Docker profile in only the principal allowlists that need it. Paseo displays **Docker (privileged)** and requires a user to select it.

The sidecar runs privileged and shares the workspace's exact worktree mount path and PVC subdirectory, so Docker bind mounts reference the same files. It listens on a Unix socket shared with the main container. The controller sets `DOCKER_HOST` and keeps daemon-host Docker settings from overriding it. Set `docker.socketGroup` and the main container's supplemental groups for non-root access. Docker and containerd data live on a separate disk-backed `emptyDir`. Use `docker.sizeLimit` to bound that storage and `docker.resources` to set resource requests and limits.

Docker requires a cluster and namespace that allow privileged containers. Give access only to trusted daemons and workspaces. A privileged sidecar has broad node access. Docker images, containers and volumes in this sandbox are discarded when the sandbox pod is deleted.

For lab deployments, use a dedicated Docker controller and namespace with separate storage and backend profile grants. Configure a Docker-only principal and a PVC rooted at the approved lab storage directory. Provide a separately approved repository mapping if linked Git worktrees require it. Apply admission rules in the Docker namespace that restrict privileged containers to the controller-managed Docker sidecar and constrain the allowed images, PVCs and pod settings. The lab team owns the namespace, storage and admission policy.

Each controller accepts only its configured principals and profiles, scopes pod operations to its release, principal and workspace ID, and checks worktree and repository paths against profile mappings. The chart Role operates within its namespace. The dedicated controller needs the chart's existing namespace permissions. Test the lab policy against both the intended pod and rejected pod specs before enabling Docker workspaces.

### Install Gateway and backends

1. Prepare shared storage in the backend namespaces and a dedicated, retained ReadWriteOncePod PVC in the Gateway namespace. Create the external Gateway serving TLS Secret for the hostname the daemon uses. A private route such as TLS passthrough must preserve bidirectional HTTP/2 and allow long-lived streams.
2. Install cert-manager for managed internal TLS. Set `internalTLS.issuerName` to the same dedicated private ClusterIssuer name in every release. The Gateway release can create the issuer and its root with `internalTLS.bootstrap: true`. Its prerequisite is access to cert-manager's cluster resource namespace (default `cert-manager`) and to ClusterIssuers. Restrict issuance through the private issuer to this installation's operators and namespaces. In a shared cluster, use a managed issuer with issuance policy that reserves the Gateway DNS identity. Any client certificate issued with that identity by a trusted CA can act as the Gateway.
3. Copy [the shared installation values](../config/installation-values.example.yaml) to `values.yaml`. Edit shared settings once and update each release under `releases.gateway`, `releases.standard` and, if enabled, `releases.docker`. Update the image and volume mappings, Service HTTPS names, Gateway serving Secret, and state claim. Use the same dedicated DNS SAN for `gateway.clientIdentity` and each matching backend principal's `gatewayIdentity`. Use one stable backend principal per Gateway principal per backend. Map each principal's allowed aliases with `gateway.principals.<name>.profiles` and map the backend IDs to stable principal names with `backendPrincipals`. Grant only the matching backend profiles in each release's `controller.principals` section.
4. Generate one token per Paseo daemon. Place the raw token in a daemon-readable file, and set its digest as `gateway.principals.<name>.tokenSha256`. Grant `standard` and add `docker` only for authorized daemons. For a Standard-only installation, omit the Docker alias, backend and grants from the Gateway values.

   ```sh
   umask 077
   openssl rand -hex 32 > gateway.token
   tr -d '\n' < gateway.token | sha256sum
   ```

5. From the release checkout, install each release with [the Helm helper](../scripts/helm-installation), which uses Mike Farah yq v4 to pass only the selected settings to Helm. The Gateway bootstraps the issuer before the controllers request their serving certificates. Keep release names and backend IDs stable.

   ```sh
   chart=https://github.com/lerenn/paseo-kubernetes-sandboxes/releases/download/v0.6.2/paseo-sandbox-controller-0.6.2.tgz
   scripts/helm-installation values.yaml gateway upgrade --install gateway "$chart" --version 0.6.2 -n paseo --wait
   scripts/helm-installation values.yaml standard upgrade --install standard "$chart" --version 0.6.2 -n standard --wait
   scripts/helm-installation values.yaml docker upgrade --install docker "$chart" --version 0.6.2 -n docker --wait
   ```

   For Argo or other GitOps renderers, run `scripts/helm-installation values.yaml <component>` to emit that component’s normal Helm values. Existing per-release Helm overrides still work. Backend values use `controller.profiles`, `controller.principals`, `controller.resources` and `controller.tlsSecretName`. The corresponding legacy root keys are fallback inputs. When you supply a controller map, it takes precedence over the whole legacy map.

   The release archive works without registry credentials. The chart also publishes to `oci://ghcr.io/lerenn/paseo-kubernetes-sandboxes/charts/paseo-sandbox-controller` for OCI-based deployment.

   For a source build, use `charts/paseo-sandbox-controller` and set `image` to your build. Set `imagePullSecrets` for namespaces that need private registry access.

The Gateway uses a dedicated internal client certificate. Controllers verify its CA and configured DNS SAN before accepting the asserted backend principal, and the Gateway verifies the CA and hostname of each controller. Cert-manager issues 24-hour serving and client certificates, renews them with eight hours remaining and rotates their keys. The Gateway reads new client material on each connection, and the servers reload mounted TLS material for new connections. The bootstrapped root is renewed with the same trust key. For a root key rollover, use operator-managed overlapping CA bundles and renew leaves under the replacement issuer before removing the old CA.

With externally managed PKI, supply the Gateway client Secret through `gateway.credentialsSecretName` with `tls.crt`, `tls.key` and backend trust `ca.crt`. Set `gateway.backends.<id>.caFile` when a backend needs a different CA key in that Secret. For each controller, provide a serving `controller.tlsSecretName` and a `controller.gatewayClientCASecretName` containing the client CA at `ca.crt`. The Gateway serving Secret is separate and may use a publicly trusted certificate such as Let's Encrypt. Backend servers and client certificates use private trust.

From the daemon network verify Gateway HTTPS and authenticated HTTP/2 profile discovery. Expect HTTP 200 and each alias granted to that daemon. Use `--cacert` with a private Gateway serving CA.

```sh
curl --fail --http2 --write-out '\nHTTP/%{http_version}\n' \
  --header @gateway-auth-header.txt \
  https://sandbox.example.internal/v1/gateway/profiles
```

Create `gateway-auth-header.txt` with mode 0600 and the line `Authorization: Bearer <gateway token>`. Remove it after verification. A Standard-only credential should see only `standard`; a dual-profile credential should see `standard` and `docker`. Rotate a Paseo token with a Gateway values update and replacement daemon token file at the same path. Keep Gateway and backend principal names to retain ownership.

### Lifecycle

The controller names and owns sandbox pods per release, principal and workspace. It deletes a pod when the workspace is archived or stopped. An idle pod is eligible for deletion after the profile's `idleMinutes` interval, measured from its last launch or command completion. Open terminals and active commands keep the pod alive. Set `idleMinutes: 0` to retain idle pods until explicitly deleted. The controller scans once a minute and restarts the idle clock on rollout. Deleting the Helm release's Service also garbage-collects its sandbox pods. PersistentVolumeClaims pre-exist the chart and retain the worktrees.

## Paseo user setup

1. Install on the daemon running Paseo 0.18.0 or later and Node.js 22 or later with `paseo plugin install git:lerenn/paseo-kubernetes-sandboxes:plugin --ref v0.6.2`.
2. Open **Kubernetes Sandbox → Gateway → Set up Gateway**. Enter the administrator's HTTPS URL and absolute token file path as seen from the daemon. Enter a CA file path if the Gateway uses a private CA. Select **Check connection**, then **Save Gateway**.
3. In **New workspace**, choose the host and open **Execution**. Select **Local** where permitted, or choose a Gateway profile from the selected host. Choose **Docker** explicitly for workspaces that need its privileged container. The selected profile applies before setup or the first agent starts.
4. To route an existing workspace, open **Kubernetes Sandbox → Workspaces** and save a profile. If the first agent failed, return to the same workspace draft and retry after the profile is saved. **Refresh status** shows the pod state. To change profiles, stop the sandbox and wait for **No sandbox**. A stop ends running sessions and discards ephemeral state. Shared files remain on the volume. Reopen agents and terminals to use the new route.

Assigned workspace launches require the saved Gateway and its profile grant. To require a profile on new workspace launches, enable **Require a sandbox profile** in the Gateway tab.

### Upgrade from direct connections

1. Keep both backend release names, namespaces, Services, storage and existing principal names. Back up the existing plugin configuration and inventory its workspace-to-profile assignments. Configure exact aliases and privilege for those assignments in Gateway. The Standard and Docker aliases are `standard` and `docker`.
2. Keep the current plugin installed while staging the new Gateway and backends. For a short overlap, set `controller.allowDirectMigration: true` and keep the old `tokenSha256` grants alongside the Gateway identities. Keep the old serving certificate trusted by the old plugin for this step. With Helm, `controller.retainLegacyServingTLS: true` can retain a chart-generated Secret from the live release. With Argo, reference a separately managed copy of that Secret, and mount the corresponding backend serving CA with `gateway.backendTrustSecretName` and use `gateway.backends.<id>.caFile: /backend-trust/<key>`. The managed path can issue backend client trust material while the existing controller serving Secret remains in use. You can also drain first using the old releases, then deploy the new backend serving certificates and Gateway together during the maintenance window.
3. Verify both scoped profiles through the Gateway from the daemon network and confirm HTTP/2. Pause new sandbox launches and stop old sandboxes with the old plugin. Wait for them to disappear before changing routes. Existing sessions must be reopened after the cutover. Shared worktree data remains available.
4. Upgrade the existing plugin installation in place so it can read its existing host settings. Keep the staged direct routes available for rollback during the cutover window. Go to **Gateway → Migrate to Gateway**, enter the verified Gateway URL and token paths, then select **Migrate saved assignments**. The operation keeps every workspace ID and profile alias, and checks each assigned profile's privilege and grant before saving. Pending assignments still need a profile before launch. If the migration fails, fix the Gateway grants or aliases and retry with the settings still intact.
5. Check **Workspaces** and **Profiles** after saving to verify that the assignments and scopes match the inventory. Once all migrated daemons use the Gateway and any remaining direct streams have drained, remove direct routes and legacy token digests, and turn off `controller.allowDirectMigration`. Verify the Gateway still returns the expected profiles. A rollback to direct connections requires restoring both the previous plugin version and backed-up host settings and infrastructure as a pair.

For pre-0.5 clone-mode workspaces, preserve pod-local changes and move the checkout to shared storage before enabling launches. Inventory earlier pods, RBAC, SSH Secrets and per-sandbox PVCs before removal.
