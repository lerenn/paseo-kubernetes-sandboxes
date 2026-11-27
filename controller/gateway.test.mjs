import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { connect, constants, createSecureServer } from "node:http2";
import { request } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createGateway } from "./gateway.mjs";

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
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost",
    "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", join(state, "key"), "-out", join(state, "cert"),
  ], { stdio: "ignore" });
  const tls = { key: readFileSync(join(state, "key")), cert: readFileSync(join(state, "cert")) };
  const files = new Map([["ca", tls.cert], ["a", token("C")], ["b", token("D")], ["c", token("E")]]);
  const accesses = [];
  let onCancel;
  const sessions = new Set();
  function backend(name, privileged, credentials) {
    const sandboxes = new Map();
    const server = createSecureServer(tls);
    t.after(() => { server.close(); });
    server.on("request", async (req, res) => {
      const owner = credentials.get(req.headers.authorization);
      accesses.push([name, req.method, req.url, owner]);
      const reply = (status, data) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(data));
      };
      if (!owner) return reply(401, { error: "Authentication required." });
      if (req.url === "/v1/profiles") {
        return reply(200, { profiles: [{ id: "shared", label: name, privileged }] });
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
    safe: { url: await listen(backend("safe", false, new Map([
      [auth(token("C")).authorization, "alice"], [auth(token("D")).authorization, "bob"],
    ]))), caFile: "ca" },
    dind: { url: await listen(backend("dind", true, new Map([
      [auth(token("E")).authorization, "bob"],
    ]))), caFile: "ca" },
  };
  const config = {
    backends,
    profiles: {
      standard: { backend: "safe", profile: "shared", privileged: false },
      docker: { backend: "dind", profile: "shared", privileged: true },
    },
    principals: {
      alice: { tokenSha256: hash(token("A")), profiles: ["standard"], backendTokenFiles: { safe: "a" } },
      bob: { tokenSha256: hash(token("B")), profiles: ["standard", "docker"], backendTokenFiles: { safe: "b", dind: "c" } },
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
      const req = request(url + path, { method, ca: tls.cert, agent: false, headers: {
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
    call, accesses, config, address: () => url, ca: tls.cert, start, stop,
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
