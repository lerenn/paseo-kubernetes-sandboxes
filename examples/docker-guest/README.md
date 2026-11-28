# Opt-in Docker guest admission

This Kubernetes 1.34+ example is applied separately from Helm. Use an empty,
dedicated guest namespace called `paseo-docker-guest`, with a Docker-only backend
Helm release named `paseo-docker`. The policy binds to that exact namespace.
Keep Standard and other workloads in their existing namespaces with their
existing Pod Security enforcement. The example admits only the Helm controller
Pod and the managed Docker sandbox shape in the dedicated namespace.

1. Set the controller chart's `image` and the Docker profile's main and sidecar
   images to approved digest references. Replace the three example image
   references in [admission.yaml](admission.yaml) with the same digests.
2. Confirm the guest uses per-controller service account credentials. The
   example expects the ReplicaSet controller to authenticate as
   `system:serviceaccount:kube-system:replicaset-controller`. Compare this with
   the guest's audit record for the backend's controller Pod create. Restrict
   writes to the backend Deployment, release configuration, and admission
   resources to trusted operators. The Dockerd socket is available to code in
   the main container, so grant Docker only to trusted workspaces.
3. Configure the `docker` profile like the sample below. If you change names,
   paths, digests, storage limit or Docker options, update the policy and
   re-run admission tests. Keep worktree and Git scope explicit.
4. Apply the policy and its binding as a cluster administrator. Check that the
   policy reports type-checking results without warnings. Keep Pod Security
   enforcement in place while confirming that the binding denies wrong
   identities and shapes. When the binding is verified, the administrator
   can set the dedicated namespace's Pod Security enforcement to
   `privileged`. Use `baseline` for its Pod Security audit and warning labels.
   Before removing the binding, restore the namespace's baseline enforcement.
5. Run the [launch preflight](../../docs/setup.md#launch-preflight). For a
   virtual cluster, have the host operator check translated Pod admission and
   storage separately.

```yaml
controller:
  profiles:
    docker:
      image: registry.example.invalid/paseo-workspace@sha256:<approved-digest>
      worktree:
        claimName: docker-worktrees
        basePath: /shared/worktrees
        subPath: worktrees
      repository:                         # optional for standalone checkouts
        claimName: docker-repositories
        basePath: /shared/repositories
        subPath: repositories
      podSpec:
        serviceAccountName: default
      docker:
        enabled: true
        image: registry.example.invalid/docker-dind@sha256:<approved-digest>
        sizeLimit: 10Gi
```

The API server regression test installs the example and test RBAC in a
disposable cluster. It sends dry-run Pod requests for the controller,
standalone and linked Docker worktrees, and ordinary pods. It also checks
denials for an alternate identity, unpinned image, wrong claim, wrong mount,
additional sidecar, and a Docker Pod in the Standard namespace.

```sh
node examples/docker-guest/test.mjs /path/to/disposable-cluster.kubeconfig
```
