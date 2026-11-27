import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { REQUEST, RESPONSE, createDecoder, encodeFrame, parseStart, remoteCommand, serveExec } from "./exec.mjs";

const root = "/worktrees/app";
const start = (extra = {}) => Buffer.from(JSON.stringify({ command: ["echo", "hi"], cwd: root, env: { A: "1" }, ...extra }));

test("frames survive arbitrary chunking", () => {
  const frames = [];
  const decode = createDecoder((type, payload) => frames.push([type, payload.toString()]));
  const bytes = Buffer.concat([encodeFrame(1, Buffer.from("ab")), encodeFrame(2, Buffer.from("cde"))]);
  for (let i = 0; i < bytes.length; i++) decode(bytes.subarray(i, i + 1));
  assert.deepEqual(frames, [[1, "ab"], [2, "cde"]]);
  assert.throws(() => createDecoder(() => {})(Buffer.from([1, 0xff, 0xff, 0xff, 0xff])));
});

test("start frames are validated", () => {
  assert.equal(parseStart(start(), root).command[0], "echo");
  assert.deepEqual(parseStart(start({ tty: true, cols: 80, rows: 24 }), root).cols, 80);
  for (const bad of [{ command: [] }, { command: ["A=b"] }, { cwd: "/etc" }, { cwd: "/worktrees/app/../x" }, { cwd: "/worktrees/app2" },
    { env: { "1x": "v" } }, { env: { A: "a\0" } }, { tty: true }, { tty: true, cols: 0, rows: 5 }, { command: ["a\0"] }]) {
    assert.throws(() => parseStart(start(bad), root), undefined, JSON.stringify(bad));
  }
});

test("remote command records the pid, enters the directory and carries env before the command", () => {
  const { argv, pidFile } = remoteCommand("abc", parseStart(start(), root));
  assert.equal(pidFile, "/tmp/sbx/pid.abc");
  assert.deepEqual(argv.slice(3), ["sbx", "/tmp/sbx", pidFile, root, "A=1", "echo", "hi"]);
});

function fakeExchange({ tty = false } = {}) {
  const calls = [];
  const conns = [];
  const open = (params) => {
    const events = new EventEmitter();
    const sent = [];
    const conn = {
      params, sent, closed: false, input: false,
      send: (channel, bytes) => sent.push([channel, Buffer.from(bytes ?? []).toString()]),
      endInput: () => { conn.input = true; },
      onOpen: (fn) => events.on("open", fn), onMessage: (fn) => events.on("message", fn), onClose: (fn) => events.on("close", fn),
      pause() {}, resume() {}, close: () => { conn.closed = true; },
      emit: (...a) => events.emit(...a),
    };
    calls.push(params);
    conns.push(conn);
    return conn;
  };
  const request = Object.assign(new EventEmitter(), { pause() {}, resume() {} });
  const written = [];
  const response = Object.assign(new EventEmitter(), {
    headersSent: false, destroyed: false, writableEnded: false,
    writeHead() { this.headersSent = true; }, flushHeaders() {},
    write(bytes) { written.push(bytes); return true; },
    end(bytes) { if (bytes) written.push(bytes); this.writableEnded = true; },
  });
  const tracked = [];
  serveExec(request, response, { root, namespace: "ns", pod: "p", open, track: (d) => tracked.push(d) });
  const decodeResponse = () => {
    const out = [];
    const decode = createDecoder((type, payload) => out.push([type, [...payload]]));
    for (const chunk of written) decode(chunk);
    return out;
  };
  return { request, response, conns, calls, tracked, decodeResponse, tty };
}

test("exec bridges stdin, resize and output, and reports the exit code", () => {
  const x = fakeExchange();
  x.request.emit("data", Buffer.concat([
    encodeFrame(REQUEST.START, start({ tty: true, cols: 100, rows: 30 })),
    encodeFrame(REQUEST.STDIN, Buffer.from("ls\n")),
    encodeFrame(REQUEST.RESIZE, Buffer.from(JSON.stringify({ cols: 120, rows: 40 }))),
    encodeFrame(REQUEST.EOF),
  ]));
  const conn = x.conns[0];
  assert.equal(conn.params.tty, true);
  conn.emit("open");
  assert.deepEqual(conn.sent, [
    [0, "ls\n"],
    [4, JSON.stringify({ Width: 120, Height: 40 })],
    [4, JSON.stringify({ Width: 100, Height: 30 })],
  ]);
  assert.equal(conn.input, true);
  conn.emit("message", 1, Buffer.from("out"));
  conn.emit("message", 3, Buffer.from(JSON.stringify({ status: "Failure", details: { causes: [{ reason: "ExitCode", message: "7" }] } })));
  conn.emit("close");
  assert.deepEqual(x.decodeResponse(), [[RESPONSE.STDOUT, [...Buffer.from("out")]], [RESPONSE.EXIT, [7]]]);
  assert.deepEqual(x.tracked, [1, -1]);
  assert.equal(conn.closed, true);
});

test("a client that disconnects stops the remote process", () => {
  const x = fakeExchange();
  x.request.emit("data", encodeFrame(REQUEST.START, start()));
  x.response.emit("close");
  const kill = x.calls.find((c) => c.argv.some((a) => a.includes("kill -s")));
  assert.ok(kill && kill.argv.at(-1) === "TERM", "TERM is sent to the remote pid");
  assert.equal(x.conns[0].closed, true);
  assert.deepEqual(x.tracked, [1, -1]);
});

test("a signal frame is forwarded; an invalid first frame is rejected", () => {
  const x = fakeExchange();
  x.request.emit("data", Buffer.concat([encodeFrame(REQUEST.START, start()), encodeFrame(REQUEST.SIGNAL, Buffer.from('{"signal":"INT"}'))]));
  assert.ok(x.calls.some((c) => c.argv.at(-1) === "INT"));
  const bad = fakeExchange();
  bad.request.emit("data", encodeFrame(REQUEST.STDIN, Buffer.from("x")));
  assert.equal(bad.conns.length, 0);
  assert.equal(bad.response.writableEnded, true);
});
