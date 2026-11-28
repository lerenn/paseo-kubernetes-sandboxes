import { profileRevision, sharedHomeVolume, volumeSubPath } from "./policy.mjs";

export const managedBy = "paseo-sandbox-controller";
export const label = {
  managed: "app.kubernetes.io/managed-by",
  instance: "app.kubernetes.io/instance",
  principal: "paseo.dev/principal",
};

function restrictedContainer(container) {
  return {
    ...container,
    securityContext: {
      ...container.securityContext,
      seccompProfile: { type: "RuntimeDefault" },
      privileged: false,
      allowPrivilegeEscalation: false,
      capabilities: { drop: ["ALL"] },
    },
  };
}

function addDocker(docker, worktree, main, sidecars, volumes) {
  const socket = { name: "docker-socket", mountPath: "/run/paseo-docker" };
  const host = `unix://${socket.mountPath}/docker.sock`;
  volumes.push(
    { name: socket.name, emptyDir: {} },
    { name: "docker-state", emptyDir: docker.sizeLimit ? { sizeLimit: docker.sizeLimit } : {} },
  );
  main.volumeMounts.push(socket);
  main.env = [...(main.env ?? []).filter(({ name }) => name !== "DOCKER_HOST"), { name: "DOCKER_HOST", value: host }];
  sidecars.push({
    name: "docker",
    image: docker.image,
    command: ["dockerd-entrypoint.sh"],
    args: ["dockerd", `--host=${host}`, `--group=${docker.socketGroup ?? 0}`,
      ...(docker.storageDriver ? [`--storage-driver=${docker.storageDriver}`] : [])],
    securityContext: { privileged: true, runAsNonRoot: false, runAsUser: 0 },
    volumeMounts: [
      worktree, socket,
      { name: "docker-state", mountPath: "/var/lib/docker", subPath: "docker" },
      { name: "docker-state", mountPath: "/var/lib/containerd", subPath: "containerd" },
    ],
    readinessProbe: {
      exec: { command: ["docker", "--host", host, "version", "--format", "{{.Server.Version}}"] },
      periodSeconds: 5,
      timeoutSeconds: 3,
    },
    ...(docker.resources && { resources: docker.resources }),
  });
}

export function buildPod(name, principal, profileName, profile, { root, gitDir }, owner) {
  const volumes = [];
  const volumeMounts = [];
  function mount(name, volume, path) {
    volumes.push({ name, persistentVolumeClaim: { claimName: volume.claimName } });
    volumeMounts.push({ name, mountPath: path, subPath: volumeSubPath(volume, path) });
  }
  mount("worktree", profile.worktree, root);
  const worktreeMount = volumeMounts[0];
  if (gitDir !== undefined) {
    if (!profile.repository) throw new Error("This profile requires a repository volume for linked worktrees.");
    if (typeof gitDir !== "string" || !gitDir.endsWith("/.git") ||
        gitDir === root + "/.git" || root.startsWith(gitDir + "/") || gitDir.startsWith(root + "/")) {
      throw new Error("Expected a separate Git metadata directory ending in /.git.");
    }
    mount("repository", profile.repository, gitDir);
  }
  if (profile.sharedHome) {
    const { claimName, mounts } = profile.sharedHome;
    volumes.push({ name: sharedHomeVolume, persistentVolumeClaim: { claimName } });
    for (const { mountPath, subPath, access } of mounts) {
      volumeMounts.push({ name: sharedHomeVolume, mountPath, subPath, readOnly: access === "ro" });
    }
  }
  const main = restrictedContainer({
    ...profile.container,
    name: "main",
    image: profile.image,
    command: ["sh", "-c", "while :; do sleep 3600 & wait $!; done"],
    workingDir: root,
    volumeMounts: [...(profile.container?.volumeMounts ?? []), ...volumeMounts],
  });
  const sidecars = (profile.sidecars ?? []).map(restrictedContainer);
  if (profile.docker?.enabled) addDocker(profile.docker, worktreeMount, main, sidecars, volumes);

  return {
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      name,
      labels: { [label.managed]: managedBy, [label.principal]: principal, [label.instance]: owner.name },
      ownerReferences: [owner],
      annotations: {
        "paseo.dev/profile": profileName,
        "paseo.dev/profile-revision": profileRevision(profile),
        "paseo.dev/worktree": root,
        "paseo.dev/repository": gitDir ?? "",
      },
    },
    spec: {
      terminationGracePeriodSeconds: 5,
      ...(profile.podSpec ?? {}),
      restartPolicy: "Never",
      automountServiceAccountToken: false,
      volumes: [...(profile.podSpec?.volumes ?? []), ...volumes],
      containers: [main, ...sidecars],
      ...(profile.podSpec?.initContainers && { initContainers: profile.podSpec.initContainers.map(restrictedContainer) }),
    },
  };
}
