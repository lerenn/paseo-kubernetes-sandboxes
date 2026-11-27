import { readFileSync } from "node:fs";
import { createSecureServer } from "node:http2";
import { kubeOpener, serveExec } from "./exec.mjs";
import { inCluster, kubeClient, KubernetesError } from "./kubernetes.mjs";
import { createPolicy, profileRevision, sandboxName } from "./policy.mjs";
import { readTLS, reloadTLS } from "./tls.mjs";
import { buildPod, label, managedBy } from "./pod.mjs";

const config = JSON.parse(readFileSync(process.env.CONTROLLER_CONFIG, "utf8"));
const policy = createPolicy(config);
const namespace = process.env.SANDBOX_NAMESPACE;
const connection = inCluster();
const kube = kubeClient({ namespace, connection });
const openExec = kubeOpener(connection);
const serviceName = process.env.CONTROLLER_SERVICE;
const selector = `${label.managed}=${managedBy},${label.instance}=${serviceName}`;
const service = await kube.getService(serviceName);
const owner = { apiVersion: "v1", kind: "Service", name: serviceName, uid: service.metadata.uid };

const locks = new Map();
async function withSandbox(name, fn) {
  const previous = locks.get(name);
  let unlock;
  const next = new Promise((resolve) => { unlock = resolve; });
  locks.set(name, next);
  await previous;
  try {
    return await fn();
  } finally {
    if (locks.get(name) === next) locks.delete(name);
    unlock();
  }
}

function owns(pod, principal) {
  const { labels = {}, ownerReferences = [] } = pod.metadata;
  return labels[label.managed] === managedBy && labels[label.instance] === serviceName &&
    labels[label.principal] === principal && ownerReferences.some(({ uid }) => uid === owner.uid);
}

// Activity of each sandbox, in memory: a sandbox with no running command for its profile's idle time is deleted.
const activity = new Map();
const touch = (name, delta = 0) => {
  const entry = activity.get(name) ?? { active: 0, last: Date.now() };
  entry.active = Math.max(0, entry.active + delta);
  entry.last = Date.now();
  activity.set(name, entry);
};
async function sweep() {
  const names = new Set();
  for await (const pod of kube.listPods(selector)) {
    const name = pod.metadata.name;
    names.add(name);
    await withSandbox(name, async () => {
      if (!owns(pod, pod.metadata.labels?.[label.principal])) return;
      if (!activity.has(name)) touch(name);
      const idle = policy.idleMs(pod.metadata.annotations?.["paseo.dev/profile"]);
      const entry = activity.get(name);
      if (idle && !pod.metadata.deletionTimestamp && !entry.active && Date.now() - entry.last >= idle) {
        await kube.deletePod(pod);
        activity.delete(name);
      }
    });
  }
  for (const name of activity.keys()) if (!names.has(name) && !activity.get(name).active) activity.delete(name);
}

function status(pod) {
  return pod && {
    profile: pod.metadata.annotations["paseo.dev/profile"],
    phase: pod.status?.phase ?? "Pending",
    ready: pod.status?.conditions?.some(({ type, status }) => type === "Ready" && status === "True") ?? false,
    deleting: Boolean(pod.metadata.deletionTimestamp),
  };
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 32_768) throw new Error("Request body is too large.");
    chunks.push(chunk);
  }
  const body = JSON.parse(Buffer.concat(chunks).toString());
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Expected a JSON object.");
  return body;
}

function send(response, status, body) {
  if (response.destroyed) return;
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

const tlsOptions = () => ({
  ...readTLS("/tls"),
  ca: readFileSync(process.env.GATEWAY_CLIENT_CA_FILE),
  requestCert: true,
  rejectUnauthorized: config.allowDirect !== true,
  minVersion: "TLSv1.2",
});
const server = createSecureServer({ ...tlsOptions(), allowHTTP1: true }, async (request, response) => {
  const path = request.url;
  if (request.method === "GET" && path === "/healthz") return send(response, 200, { ok: true, type: "controller" });
  const asserted = request.headers["x-paseo-backend-principal"];
  const principal = asserted === undefined
    ? policy.authenticateDirect(request.headers.authorization)
    : policy.authenticateGateway(request.socket, asserted);
  if (!principal) return send(response, 401, { error: "Authentication required." });
  if (request.method === "GET" && path === "/v1/profiles") {
    return send(response, 200, { profiles: policy.profilesFor(principal) });
  }

  const route = /^\/v1\/sandboxes\/([^/?#]{1,2400})(\/exec)?$/.exec(path);
  let workspace;
  try { workspace = decodeURIComponent(route?.[1] ?? ""); } catch {}
  if (workspace?.length > 200 || workspace?.includes("\0")) workspace = undefined;
  const exec = Boolean(route?.[2]);
  if (!workspace || (exec ? request.method !== "POST" : !["GET", "PUT", "DELETE"].includes(request.method))) {
    return send(response, 404, { error: "Unknown endpoint." });
  }

  const name = sandboxName(principal, workspace, serviceName);
  try {
    let desired;
    if (request.method === "PUT") {
      try {
        const body = await readBody(request);
        const profile = policy.profileFor(principal, body.profile);
        if (!profile) return send(response, 403, { error: "Profile is unavailable for this credential." });
        if (body.privileged !== undefined && body.privileged !== Boolean(profile.docker?.enabled)) {
          return send(response, 409, { error: "Sandbox profile privilege changed. Select the profile again in Paseo." });
        }
        desired = buildPod(name, principal, body.profile, profile, body, owner);
      } catch {
        return send(response, 400, { error: "Invalid shared-worktree request. Check the profile's volume paths." });
      }
    }

    await withSandbox(name, async () => {
      if (exec && response.destroyed) return;
      let pod = await kube.getPod(name);
      if (pod && !owns(pod, principal)) {
        return send(response, 409, { error: "Sandbox name is already in use." });
      }
      if (pod && !policy.profileFor(principal, status(pod).profile)) {
        return send(response, 403, { error: "Profile access has been removed." });
      }
      if (exec) {
        if (request.httpVersionMajor !== 2) return send(response, 505, { error: "Command streaming requires HTTP/2." });
        const sandbox = status(pod);
        if (!sandbox?.ready || sandbox.deleting) return send(response, 409, { error: "Sandbox is not ready." });
        const expectedProfile = request.headers["x-paseo-sandbox-profile"];
        if (expectedProfile !== undefined && expectedProfile !== sandbox.profile) {
          return send(response, 409, { error: "Sandbox profile changed. Reopen the session in Paseo." });
        }
        const profile = policy.profileFor(principal, sandbox.profile);
        if (!profile) return send(response, 403, { error: "Profile access has been removed." });
        const expectedPrivilege = request.headers["x-paseo-sandbox-privileged"];
        if (expectedPrivilege !== undefined && expectedPrivilege !== String(Boolean(profile.docker?.enabled))) {
          return send(response, 409, { error: "Sandbox profile privilege changed. Reopen the session in Paseo." });
        }
        if (pod.metadata.annotations["paseo.dev/profile-revision"] !== profileRevision(profile)) {
          return send(response, 409, { error: "Profile settings changed. Stop the sandbox and launch again." });
        }
        if (response.destroyed) return;
        touch(name, 1);
        response.once("close", () => touch(name, -1));
        return serveExec(request, response, {
          root: pod.metadata.annotations["paseo.dev/worktree"], namespace, pod: name, open: openExec,
          keepEnvironment: profile.docker?.enabled ? ["DOCKER_HOST", "DOCKER_CONTEXT"] : [],
        });
      }
      if (request.method === "GET") return send(response, 200, { sandbox: status(pod) });
      if (request.method === "DELETE") {
        if (pod) await kube.deletePod(pod);
        return send(response, 202, { sandbox: null });
      }
      if (!pod) {
        try {
          pod = await kube.createPod(desired);
        } catch (error) {
          if (!(error instanceof KubernetesError) || error.status !== 409) throw error;
          pod = await kube.getPod(name);
          if (!pod) throw error;
        }
      }
      if (Object.entries(desired.metadata.annotations).some(([key, value]) => pod.metadata.annotations?.[key] !== value) || !owns(pod, principal)) {
        return send(response, 409, { error: "Remove the existing sandbox before changing its profile or workspace paths." });
      }
      touch(name);
      return send(response, 200, { sandbox: status(pod) });
    });
  } catch (error) {
    console.error(error.message);
    return send(response, 503, { error: "Sandbox operation failed. Check controller permissions and cluster availability." });
  }
});
reloadTLS(server, tlsOptions);
server.listen(8443);
async function scheduleSweep() {
  try {
    await sweep();
  } catch (error) {
    console.error("Idle sweep failed.", error.message);
  }
  setTimeout(scheduleSweep, 60_000).unref();
}
void scheduleSweep();
