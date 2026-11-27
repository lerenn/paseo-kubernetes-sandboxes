import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect, constants, createSecureServer } from "node:http2";
import { request } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createGateway } from "./gateway.mjs";
import { createPolicy } from "./policy.mjs";

const token = (character) => character.repeat(43);
const hash = (value) => createHash("sha256").update(value).digest("hex");
const path = "/v1/sandboxes/workspace%2Fexample";
const auth = (value) => ({ authorization: `Bearer ${value}` });

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `https://127.0.0.1:${server.address().port}`;
}

async function fixture(t) {
  const state = mkdtempSync(join(tmpdir(), "paseo-gateway-"));
  t.after(() => rmSync(state, { recursive: true, force: true }));
  const openssl = (...args) => execFileSync("openssl", args, { cwd: state, stdio: "ignore" });
  openssl("req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes",
    "-days", "1", "-subj", "/CN=Testing CA", "-keyout", "ca.key", "-out", "ca.crt");
  function issue(name, extension) {
    openssl("req", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes",
      "-subj", "/CN=" + name, "-keyout", name + ".key", "-out", name + ".csr");
    writeFileSync(join(state, "ext"), extension);
    openssl("x509", "-req", "-in", name + ".csr", "-CA", "ca.crt", "-CAkey", "ca.key",
      "-CAcreateserial", "-days", "1", "-extfile", "ext", "-out", name + ".crt");
    return { key: readFileSync(join(state, name + ".key")), cert: readFileSync(join(state, name + ".crt")) };
  }
  const tls = issue("server", "subjectAltName=IP:127.0.0.1\nextendedKeyUsage=serverAuth");
  const gatewayIdentity = "gateway.internal.test";
  const issueClient = (name, identity) => issue(name, `subjectAltName=DNS:${identity}\nextendedKeyUsage=clientAuth`);
  const legitimate = issueClient("client", gatewayIdentity);
  const rogue = issueClient("rogue", "other.internal.test");
  const renewed = issueClient("renewed", gatewayIdentity);
  const ca = readFileSync(join(state, "ca.crt"));
  const files = new Map([["ca", ca], ["/credentials/tls.key", legitimate.key], ["/credentials/tls.crt", legitimate.cert]]);
  const accesses = [];
  let onCancel;
  const sessions = new Set();
  function backend(name, privileged, credentials) {
    const sandboxes = new Map();
    const policy = createPolicy({
      profiles: { shared: {
        image: "workspace", worktree: { claimName: "workspace", basePath: "/workspace" },
        ...(privileged ? { docker: { enabled: true, image: "docker" } } : {}),
      } },
      principals: Object.fromEntries(credentials.map((principal) => [principal, { gatewayIdentity, profiles: ["shared"] }])),
    });
    const server = createSecureServer({ ...tls, ca, requestCert: true, rejectUnauthorized: true });
    t.after(() => { server.close(); });
    server.on("request", async (req, res) => {
      assert.equal(req.headers.authorization, undefined);
      const owner = policy.authenticateGateway(req.socket, req.headers["x-paseo-backend-principal"]);
      accesses.push([name, req.method, req.url, owner]);
      const reply = (status, data) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(data));
      };
      if (!owner) return reply(401, { error: "Authentication required." });
      if (req.url === "/v1/profiles") {
        return reply(200, { profiles: policy.profilesFor(owner) });
      }
      const key = owner + ":" + req.url.replace(/\/exec$/, "");
      if (req.method === "PUT") {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks));
        assert.equal(body.profile, "shared");
        assert.equal(body.privileged, privileged);
        sandboxes.set(key, { profile: "shared", phase: "Running", ready: true, deleting: false });
      }
      if (req.method === "DELETE") sandboxes.delete(key);
      if (req.method === "POST") {
        if (!sandboxes.has(key)) return reply(409, { error: "Sandbox is not ready." });
        assert.equal(req.headers["x-paseo-sandbox-profile"], "shared");
        assert.equal(req.headers["x-paseo-sandbox-privileged"], String(privileged));
        res.once("close", () => onCancel?.());
        res.writeHead(200, { "content-type": "application/octet-stream" });
        res.flushHeaders();
        req.pipe(res);
        return;
      }
      reply(req.method === "DELETE" ? 202 : 200, { sandbox: sandboxes.get(key) ?? null });
    });
    return server;
  }
  const backends = {
    safe: { url: await listen(backend("safe", false, ["alice", "bob"])), caFile: "ca" },
    dind: { url: await listen(backend("dind", true, ["bob"])), caFile: "ca" },
  };
  const config = {
    backends,
    profiles: {
      standard: { backend: "safe", profile: "shared", privileged: false },
      docker: { backend: "dind", profile: "shared", privileged: true },
    },
    principals: {
      alice: { tokenSha256: hash(token("A")), profiles: ["standard"], backendPrincipals: { safe: "alice" } },
      bob: { tokenSha256: hash(token("B")), profiles: ["standard", "docker"], backendPrincipals: { safe: "bob", dind: "bob" } },
    },
  };
  let url;
  let gateway;
  async function start() {
    gateway = createGateway({ config, state, tls, load: (key) => files.get(key) });
    gateway.on("session", (session) => {
      sessions.add(session);
      session.once("close", () => sessions.delete(session));
    });
    url = await listen(gateway);
  }
  async function stop() {
    for (const session of sessions) session.destroy();
    await new Promise((resolve) => gateway.close(resolve));
  }
  await start();
  t.after(stop);
  function call(method, path, user, data) {
    return new Promise((resolve, reject) => {
      const req = request(url + path, { method, ca, agent: false, headers: {
        ...auth(token(user)), ...(data ? { "content-type": "application/json" } : {}),
      } }, async (res) => {
        const chunks = [];
        for await (const chunk of res) chunks.push(chunk);
        resolve([res.statusCode, JSON.parse(Buffer.concat(chunks))]);
      });
      req.on("error", reject);
      req.end(data ? JSON.stringify(data) : undefined);
    });
  }
  return {
    call, accesses, config, address: () => url, ca, start, stop,
    useClient(material) {
      files.set("/credentials/tls.key", material.key);
      files.set("/credentials/tls.crt", material.cert);
    },
    rogue, renewed, legitimate, files, serverCert: tls.cert,
    cancelled: () => new Promise((resolve) => { onCancel = resolve; }),
  };
}

test("gateway filters discovery and routes colliding backend profile IDs with durable ownership", { timeout: 10000 }, async (t) => {
  const { call, accesses, config, start, stop } = await fixture(t);
  assert.deepEqual(await call("GET", "/healthz", "X"), [200, { ok: true, type: "gateway" }]);
  assert.equal((await call("GET", "/v1/profiles", "C"))[0], 401);
  const [, alice] = await call("GET", "/v1/profiles", "A");
  assert.deepEqual(alice.profiles.map(({ id, controller }) => [id, controller]), [["standard", "safe"]]);
  assert.equal((await call("PUT", path, "A", { profile: "docker" }))[0], 403);
  assert.equal((await call("PUT", path, "A", { profile: "standard", privileged: true }))[0], 409);
  assert.ok(accesses.every(([backend]) => backend === "safe"));
  const [, bob] = await call("GET", "/v1/profiles", "B");
  assert.deepEqual(bob.profiles.map(({ id, controller }) => [id, controller]), [["standard", "safe"], ["docker", "dind"]]);
  assert.equal((await call("PUT", path, "B", { profile: "docker" }))[1].sandbox.profile, "docker");
  assert.deepEqual(await call("GET", path, "A"), [200, { sandbox: null }]);
  assert.equal((await call("DELETE", path, "A"))[0], 202);
  assert.equal((await call("PUT", path, "A", { profile: "standard" }))[1].sandbox.profile, "standard");
  assert.equal((await call("PUT", path, "B", { profile: "standard" }))[0], 409);
  await stop();
  await start();
  assert.equal((await call("GET", path, "B"))[1].sandbox.profile, "docker");
  assert.equal((await call("GET", path, "A"))[1].sandbox.profile, "standard");
  assert.equal((await call("DELETE", path, "B"))[0], 202);
  assert.deepEqual(await call("GET", path, "B"), [200, { sandbox: null }]);
  assert.equal((await call("PUT", path, "B", { profile: "standard" }))[1].sandbox.profile, "standard");
  assert.equal((await call("GET", path, "A"))[1].sandbox.profile, "standard");

  const another = "/v1/sandboxes/another";
  assert.equal((await call("PUT", another, "B", { profile: "docker" }))[0], 200);
  await stop();
  config.principals.bob.profiles = ["standard"];
  await start();
  const count = accesses.length;
  assert.equal((await call("GET", another, "B"))[0], 403);
  assert.equal((await call("DELETE", another, "B"))[0], 403);
  assert.equal((await call("PUT", another, "B", { profile: "standard" }))[0], 403);
  assert.equal(accesses.length, count);
});

test("gateway preserves HTTP/2 input, output, resize bytes, half-close, and cancellation", { timeout: 10000 }, async (t) => {
  const { call, address, ca, cancelled } = await fixture(t);
  await call("PUT", path, "A", { profile: "standard" });
  assert.equal((await call("POST", path + "/exec", "A"))[0], 505);
  const session = connect(address(), { ca });
  t.after(() => session.destroy());
  const launch = (profile) => session.request({
    ":method": "POST", ":path": path + "/exec", ...auth(token("A")), "x-paseo-sandbox-profile": profile,
  });
  const rejected = launch("docker");
  rejected.end();
  assert.equal((await once(rejected, "response"))[0][":status"], 409);
  rejected.resume();

  const stream = launch("standard");
  stream.write(Buffer.from([1, 0, 0, 0, 2, 123, 125]));
  const [headers] = await once(stream, "response");
  assert.equal(headers[":status"], 200);
  const resize = Buffer.from([4, 0, 0, 0, 2, 123, 125]);
  const payload = Buffer.alloc(512 * 1024, 7);
  stream.write(resize);
  stream.end(payload);
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  assert.deepEqual(Buffer.concat(chunks), Buffer.concat([Buffer.from([1, 0, 0, 0, 2, 123, 125]), resize, payload]));

  const active = launch("standard");
  active.write("start");
  await once(active, "response");
  const finished = cancelled();
  active.close(constants.NGHTTP2_CANCEL);
  await finished;
  session.destroy();
});

test("mTLS rejects unrelated identities and verifies the controller, with stable ownership after renewal", { timeout: 10000 }, async (t) => {
  const { call, useClient, rogue, renewed, legitimate, files, serverCert, ca, config, stop, start } = await fixture(t);
  const profilesPath = "/v1/gateway/profiles";
  assert.equal((await call("PUT", path, "B", { profile: "docker", privileged: true }))[0], 200);
  useClient(rogue);
  assert.deepEqual((await call("GET", profilesPath, "B"))[1].profiles, []);
  assert.equal((await call("GET", path, "B"))[0], 403);
  useClient(renewed);
  assert.equal((await call("GET", path, "B"))[1].sandbox.profile, "docker");

  await stop();
  config.principals.bob.backendPrincipals.dind = "ungranted";
  await start();
  assert.equal((await call("GET", path, "B"))[0], 403);

  useClient(legitimate);
  files.set("ca", serverCert);
  assert.equal((await call("GET", profilesPath, "A"))[0], 503);
  files.set("ca", ca);
  assert.equal((await call("GET", profilesPath, "A"))[0], 200);
});
