import { createHash, timingSafeEqual, X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import { open, readFile, rename } from "node:fs/promises";
import { connect, createSecureServer, constants } from "node:http2";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { readTLS, reloadTLS, validateTLS } from "./tls.mjs";

const id = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/;
const digest = (value) => createHash("sha256").update(value).digest("hex");
const sandboxPath = (key, alias) => `/v1/sandboxes/gw-${digest(JSON.stringify([key, alias]))}`;

function requireConfig(condition, message) {
  if (!condition) throw new Error(message);
}

function gatewayPolicy(config) {
  const backends = new Map();
  for (const [name, backend] of Object.entries(config.backends ?? {})) {
    const url = new URL(backend.url);
    requireConfig(id.test(name) && url.href === `${url.origin}/` && url.protocol === "https:",
      "Each backend requires an ID and an HTTPS origin.");
    const clusterDisplayName = typeof backend.clusterDisplayName === "string"
      ? backend.clusterDisplayName.trim() : backend.clusterDisplayName;
    requireConfig(clusterDisplayName === undefined ||
      (typeof clusterDisplayName === "string" && clusterDisplayName.length <= 80 &&
        /^[\p{L}\p{N}][\p{L}\p{N} ._-]*$/u.test(clusterDisplayName)),
    "Each backend clusterDisplayName must be a display name of 1–80 characters.");
    backends.set(name, { origin: url.origin, caFile: backend.caFile ?? "/credentials/ca.crt", clusterDisplayName });
  }

  const routes = new Map();
  for (const [alias, route] of Object.entries(config.profiles ?? {})) {
    const backend = backends.get(route.backend);
    requireConfig(id.test(alias) && backend && typeof route.profile === "string" && id.test(route.profile) && typeof route.privileged === "boolean",
      "Each gateway profile requires a unique alias, backend, backend profile and privilege setting.");
    requireConfig(alias !== "standard" || !route.privileged, "The standard alias must be unprivileged.");
    routes.set(alias, { alias, backend: route.backend, profile: route.profile, privileged: route.privileged, ...backend });
  }

  requireConfig(routes.get("standard") && !routes.get("standard").privileged, "Configure an unprivileged standard alias.");
  const docker = routes.get("docker");
  requireConfig(!docker || (docker.privileged && docker.backend !== routes.get("standard").backend),
    "The Docker alias requires a separate privileged backend.");

  const principals = [];
  const backendOwners = new Map();
  const credentialHashes = new Set();
  for (const [name, principal] of Object.entries(config.principals ?? {})) {
    requireConfig(id.test(name) && /^[a-f0-9]{64}$/.test(principal.tokenSha256) &&
      !credentialHashes.has(principal.tokenSha256), "Each gateway principal requires a unique token digest.");
    credentialHashes.add(principal.tokenSha256);
    const allowed = new Map();
    for (const alias of principal.profiles ?? []) {
      const route = routes.get(alias);
      const backendPrincipal = route && principal.backendPrincipals?.[route.backend];
      requireConfig(typeof backendPrincipal === "string" && id.test(backendPrincipal),
        "Every authorized profile requires an explicit backend principal.");
      allowed.set(alias, route);
    }
    requireConfig(allowed.size > 0, "Each gateway principal requires at least one allowed profile.");
    for (const backend of new Set([...allowed.values()].map((route) => route.backend))) {
      const ownership = JSON.stringify([backend, principal.backendPrincipals[backend]]);
      requireConfig(!backendOwners.has(ownership), "Each backend principal must belong to one Gateway principal.");
      backendOwners.set(ownership, name);
    }
    principals.push({
      name, hash: Buffer.from(principal.tokenSha256, "hex"),
      allowed: new Map([...allowed].map(([alias, route]) => [
        alias, { ...route, principal: principal.backendPrincipals[route.backend] },
      ])),
    });
  }
  requireConfig(principals.length > 0, "Configure at least one gateway principal.");
  return (authorization) => {
    const token = /^Bearer ([A-Za-z0-9_-]{43,256})$/.exec(authorization ?? "")?.[1];
    if (!token) return undefined;
    const hash = Buffer.from(digest(token), "hex");
    let principal;
    for (const candidate of principals) {
      if (timingSafeEqual(hash, candidate.hash)) principal = candidate;
    }
    return principal;
  };
}

async function body(stream, max) {
  let size = 0;
  const chunks = [];
  // Keep the HTTP stream open so the caller can return a JSON error.
  for await (const chunk of stream.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > max) throw new Error("JSON body exceeded its limit.");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString());
}

function upstream(load, route, method, path, headers = {}) {
  const session = connect(route.origin, {
    ...readTLS("/credentials", load),
    ca: load(route.caFile),
    rejectUnauthorized: true,
    minVersion: "TLSv1.2",
  });
  session.on("error", () => {});
  const stream = session.request({ ":method": method, ":path": path, "x-paseo-backend-principal": route.principal, ...headers });
  stream.on("error", () => {});
  stream.once("close", () => session.destroy());
  return stream;
}

async function backendJson(load, route, method, path, data) {
  const stream = upstream(load, route, method, path, data ? { "content-type": "application/json" } : {});
  const timer = setTimeout(() => stream.destroy(new Error("Controller request timed out.")), 12_000).unref();
  let status;
  stream.on("response", (headers) => { status = headers[":status"]; });
  stream.end(data ? JSON.stringify(data) : undefined);
  try {
    const result = await body(stream, 256 * 1024);
    if (status === undefined) throw new Error("Missing controller response.");
    return { status, result };
  } finally {
    clearTimeout(timer);
    stream.destroy();
  }
}

function send(response, status, body) {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

function relayExec(request, response, load, route, path) {
  if (response.destroyed) return;
  const stream = upstream(load, route, "POST", path + "/exec", {
    "content-type": "application/octet-stream",
    "x-paseo-sandbox-profile": route.profile,
    "x-paseo-sandbox-privileged": String(route.privileged),
  });
  const timer = setTimeout(() => stream.destroy(new Error("Controller response timed out.")), 30_000).unref();
  response.once("close", () => {
    request.unpipe(stream);
    stream.close(constants.NGHTTP2_CANCEL);
  });
  stream.once("response", (headers) => {
    clearTimeout(timer);
    if (response.destroyed) return;
    response.writeHead(headers[":status"], {
      "content-type": headers["content-type"] ?? "application/json",
      "cache-control": "no-store",
    });
    response.flushHeaders();
    stream.pipe(response);
  });
  stream.once("close", () => {
    clearTimeout(timer);
    if (!response.headersSent) send(response, 503, { error: "Controller stream unavailable." });
    else if (!stream.readableEnded && !response.destroyed) response.stream.close(constants.NGHTTP2_INTERNAL_ERROR);
  });
  request.pipe(stream);
}

async function saveRoute(file, record) {
  // A single gateway pod owns the PVC. Publish the record before any request can create a sandbox.
  const temp = file + ".tmp";
  const handle = await open(temp, "w", 0o600);
  try {
    await handle.writeFile(JSON.stringify(record));
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temp, file);
  await syncDirectory(file);
}

async function syncDirectory(file) {
  const directory = await open(join(file, ".."), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

function routeRecord(route) {
  const { alias, backend, profile, origin, privileged, principal } = route;
  return { alias, backend, profile, origin, privileged, principal };
}

export function createGateway({ config, state, tls, load = readFileSync }) {
  const authenticate = gatewayPolicy(config);
  const locks = new Map();

  async function authorizedProfiles(route) {
    const { status, result } = await backendJson(load, route, "GET", "/v1/profiles");
    if (status === 401 || status === 403) return [];
    if (status !== 200 || !Array.isArray(result.profiles)) throw new Error("Invalid controller profile response.");
    return result.profiles;
  }

  const listed = (profiles, route) => profiles.find((p) =>
    p?.id === route.profile && p.privileged === route.privileged && typeof p.label === "string");

  return createSecureServer({ ...tls, allowHTTP1: true, minVersion: "TLSv1.2" }, async (request, response) => {
    const { method } = request;
    const url = request.url?.replace(/^\/v1\/gateway(?=\/)/, "/v1");
    if (method === "GET" && (url === "/healthz" || request.url === "/v1/gateway/healthz")) return send(response, 200, { ok: true, type: "gateway" });
    const principal = authenticate(request.headers.authorization);
    if (!principal) return send(response, 401, { error: "Authentication required." });

    try {
      if (method === "GET" && url === "/v1/profiles") {
        const discoveries = new Map();
        for (const route of principal.allowed.values()) {
          if (!discoveries.has(route.backend)) discoveries.set(route.backend, authorizedProfiles(route));
        }
        const results = new Map();
        const settled = await Promise.allSettled([...discoveries].map(async ([backend, profiles]) =>
          results.set(backend, await profiles)));
        if (settled.every(({ status }) => status === "rejected")) throw new Error("Controller discovery failed.");
        const profiles = [];
        for (const route of principal.allowed.values()) {
          const profile = listed(results.get(route.backend) ?? [], route);
          if (profile) profiles.push({
            ...profile, id: route.alias, controller: route.backend, clusterDisplayName: route.clusterDisplayName,
          });
        }
        return send(response, 200, { profiles });
      }

      const match = /^\/v1\/sandboxes\/([^/?#]{1,2400})(\/exec)?$/.exec(url);
      let workspace;
      try { workspace = decodeURIComponent(match?.[1] ?? ""); } catch {}
      const exec = Boolean(match?.[2]);
      if (!workspace || workspace.length > 200 || workspace.includes("\0") ||
          (exec ? method !== "POST" : !["PUT", "GET", "DELETE"].includes(method))) {
        return send(response, 404, { error: "Unknown endpoint." });
      }
      if (exec && request.httpVersionMajor !== 2) return send(response, 505, { error: "Command streaming requires HTTP/2." });

      let data;
      let desired;
      if (method === "PUT") {
        try { data = await body(request, 32_768); } catch {}
        if (!data || typeof data !== "object" || Array.isArray(data)) {
          return send(response, 400, { error: "Invalid sandbox request." });
        }
        desired = principal.allowed.get(data.profile);
        if (!desired) return send(response, 403, { error: "Profile is unavailable for this credential." });
        if (data.privileged !== undefined && data.privileged !== desired.privileged) {
          return send(response, 409, { error: "Sandbox profile privilege changed." });
        }
      }

      const key = digest(JSON.stringify([principal.name, workspace]));
      const file = join(state, key + ".json");
      const previous = locks.get(key);
      let unlock;
      const current = new Promise((resolve) => { unlock = resolve; });
      locks.set(key, current);
      await previous;
      try {
        if (response.destroyed) return;
        let record;
        try { record = JSON.parse(await readFile(file, "utf8")); } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
        let route;
        if (record) {
          route = principal.allowed.get(record.alias);
          if (!route || JSON.stringify(routeRecord(route)) !== JSON.stringify(record)) {
            return send(response, 403, { error: "Access to the sandbox route is unavailable." });
          }
          if (!listed(await authorizedProfiles(route), route)) {
            return send(response, 403, { error: "Access to the sandbox profile is unavailable." });
          }
        }

        if (desired && desired !== route) {
          if (!listed(await authorizedProfiles(desired), desired)) {
            return send(response, 403, { error: "Access to the requested profile is unavailable." });
          }
          if (route) {
            const { status, result } = await backendJson(load, route, "GET", sandboxPath(key, route.alias));
            if (status !== 200 || result.sandbox !== null) {
              return send(response, 409, { error: "Stop the existing sandbox before changing its profile." });
            }
          }
          await saveRoute(file, routeRecord(desired));
          route = desired;
        }

        if (!route) {
          if (exec) return send(response, 409, { error: "Sandbox is not ready." });
          return send(response, method === "DELETE" ? 202 : 200, { sandbox: null });
        }
        const path = sandboxPath(key, route.alias);
        if (exec) {
          const expected = request.headers["x-paseo-sandbox-profile"];
          const privilege = request.headers["x-paseo-sandbox-privileged"];
          if ((expected !== undefined && expected !== route.alias) ||
              (privilege !== undefined && privilege !== String(route.privileged))) {
            return send(response, 409, { error: "Sandbox profile changed. Reopen the session in Paseo." });
          }
          return relayExec(request, response, load, route, path);
        }

        const { status, result } = await backendJson(load, route, method, path, data && {
          profile: route.profile, privileged: route.privileged, root: data.root, gitDir: data.gitDir,
        });
        if (status >= 200 && status < 300 && result.sandbox) {
          if (result.sandbox.profile !== route.profile) throw new Error("Controller sandbox profile mismatch.");
          result.sandbox.profile = route.alias;
        }
        return send(response, status, result);
      } finally {
        if (locks.get(key) === current) locks.delete(key);
        unlock();
      }
    } catch {
      return send(response, 503, { error: "Sandbox gateway operation failed. Check backend and storage availability." });
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = JSON.parse(readFileSync(process.env.GATEWAY_CONFIG, "utf8"));
  const state = process.env.GATEWAY_STATE;
  const directory = await open(state, "r");
  await directory.sync();
  await directory.close();
  const credentials = validateTLS(readTLS("/credentials"));
  requireConfig(new X509Certificate(credentials.cert).checkHost(config.clientIdentity, {
    subject: "never", wildcards: false,
  }) === config.clientIdentity, "Gateway client certificate does not match its configured identity.");
  for (const backend of Object.values(config.backends)) {
    validateTLS({ ca: readFileSync(backend.caFile ?? "/credentials/ca.crt") });
  }
  const serving = () => readTLS("/tls");
  const server = createGateway({ config, state, tls: serving() });
  reloadTLS(server, serving);
  server.listen(8443);
}
