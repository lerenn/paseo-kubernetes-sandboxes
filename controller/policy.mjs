import { createHash, timingSafeEqual } from "node:crypto";
import { posix } from "node:path";

const identifier = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/;
const digest = (value) => createHash("sha256").update(value).digest();

function absolutePath(value) {
  return typeof value === "string" && value.length <= 4096 && value.startsWith("/") &&
    !value.includes("\0") && value === posix.normalize(value) && !value.endsWith("/");
}

export function volumeSubPath(volume, path) {
  if (!absolutePath(path)) throw new Error("Expected a normalized absolute workspace path.");
  const relative = posix.relative(volume.basePath, path);
  if (!relative || relative === ".." || relative.startsWith("../") || posix.isAbsolute(relative)) {
    throw new Error("Workspace path must be inside its configured volume base path.");
  }
  return posix.join(volume.subPath ?? "", relative);
}

function validateVolume(volume) {
  if (!volume || !identifier.test(volume.claimName ?? "") || !absolutePath(volume.basePath)) {
    throw new Error("A volume requires a claim name and an absolute base path below /.");
  }
  const subPath = volume.subPath ?? "";
  if (typeof subPath !== "string" || subPath.includes("\0") ||
      (subPath && (posix.isAbsolute(subPath) || subPath.split("/").some((part) => !part || part === "." || part === "..")))) {
    throw new Error("Volume subPath must be a normalized relative directory.");
  }
}

function validateProfile(name, profile) {
  if (!identifier.test(name) || typeof profile?.image !== "string" || !profile.image.trim()) {
    throw new Error("Each sandbox profile requires a valid name and an image.");
  }
  if (profile.label !== undefined && (typeof profile.label !== "string" || !profile.label.trim() || profile.label.length > 80)) {
    throw new Error("A profile label must contain 1 to 80 characters.");
  }
  if (profile.idleMinutes !== undefined && !(Number.isSafeInteger(profile.idleMinutes) && profile.idleMinutes >= 0)) {
    throw new Error("idleMinutes must be a non-negative integer (0 disables the idle timeout).");
  }
  const docker = profile.docker;
  if (docker && (typeof docker.enabled !== "boolean" ||
      (docker.enabled && (name === "standard" || typeof docker.image !== "string" || !docker.image.trim())))) {
    throw new Error("Enable Docker in a separate profile and provide a Docker-in-Docker image.");
  }
  if (name === "docker" && !docker?.enabled) throw new Error("Enable the Docker sidecar to configure the docker profile.");
  if (docker?.socketGroup !== undefined && (!Number.isSafeInteger(docker.socketGroup) || docker.socketGroup < 0)) {
    throw new Error("The Docker socket group must be a non-negative numeric group ID.");
  }
  const pod = profile.podSpec;
  if (pod?.hostNetwork || pod?.hostPID || pod?.hostIPC || pod?.volumes?.some(({ hostPath }) => hostPath)) {
    throw new Error("Sandbox profiles cannot use host namespaces or hostPath volumes.");
  }
  for (const container of [profile.container, ...(profile.sidecars ?? []), ...(pod?.initContainers ?? [])]) {
    const security = container?.securityContext;
    if (security?.privileged || security?.allowPrivilegeEscalation || security?.capabilities?.add?.length) {
      throw new Error("Only the controller-managed Docker sidecar can run with elevated privileges.");
    }
  }
  validateVolume(profile.worktree);
  if (profile.repository) validateVolume(profile.repository);
}

function profileInfo(id, profile) {
  const privileged = Boolean(profile.docker?.enabled);
  const label = profile.label?.trim() ?? (id === "standard" ? "Standard" : privileged ? "Docker" : id);
  return { id, label: privileged ? `${label} (privileged)` : label, privileged };
}

export function profileRevision(profile) {
  return digest(JSON.stringify(profile)).toString("hex");
}

export function createPolicy(config) {
  const profiles = new Map(Object.entries(config.profiles ?? {}));
  for (const [name, profile] of profiles) validateProfile(name, profile);
  if (!profiles.size) throw new Error("Configure at least one shared-worktree profile.");

  const principals = new Map();
  const tokens = new Set();
  for (const [name, principal] of Object.entries(config.principals ?? {})) {
    if (!identifier.test(name) || !/^[a-f0-9]{64}$/.test(principal?.tokenSha256 ?? "") ||
        !Array.isArray(principal.profiles) || !principal.profiles.length ||
        principal.profiles.some((profile) => !profiles.has(profile)) ||
        tokens.has(principal.tokenSha256)) {
      throw new Error("Each principal requires a unique SHA-256 token digest and access to configured profiles.");
    }
    tokens.add(principal.tokenSha256);
    principals.set(name, { hash: Buffer.from(principal.tokenSha256, "hex"), profiles: new Set(principal.profiles) });
  }
  if (!principals.size) throw new Error("Configure at least one controller principal.");

  return {
    authenticate(authorization) {
      const token = /^Bearer ([A-Za-z0-9_-]{43,256})$/.exec(authorization ?? "")?.[1];
      if (!token) return null;
      const hash = digest(token);
      let match = null;
      for (const [name, principal] of principals) {
        if (timingSafeEqual(hash, principal.hash)) match = name;
      }
      return match;
    },
    // Idle time in milliseconds after which an unused sandbox of this profile is deleted; 0 means never.
    idleMs(name) {
      return (profiles.get(name)?.idleMinutes ?? 120) * 60_000;
    },
    profilesFor(principal) {
      return Array.from(principals.get(principal)?.profiles ?? [], (id) => profileInfo(id, profiles.get(id)));
    },
    profileFor(principal, name) {
      return principals.get(principal)?.profiles.has(name) ? profiles.get(name) : undefined;
    },
  };
}

export function sandboxName(principal, workspaceId, instance) {
  return "sbx-" + digest(JSON.stringify([instance, principal, workspaceId])).toString("hex").slice(0, 32);
}
