import { randomBytes } from "node:crypto";
import { posix } from "node:path";
import WebSocket from "ws";

// Wire protocol of POST /v1/sandboxes/<workspace>/exec over HTTP/2. Both directions are a sequence of frames:
// one type byte, a 4-byte big-endian payload length, the payload.
// Request (client to controller): START (JSON, first), STDIN (bytes), RESIZE (JSON {cols, rows}),
//   EOF (no more stdin), SIGNAL (JSON {signal}).
// Response (controller to client): STDOUT, STDERR (bytes; a TTY has only STDOUT), EXIT (one byte: exit code).
export const REQUEST = { START: 0, STDIN: 1, RESIZE: 2, EOF: 3, SIGNAL: 4 };
export const RESPONSE = { STDOUT: 1, STDERR: 2, EXIT: 3 };
const MAX_FRAME = 1 << 20;
const MAX_START = 64 * 1024;
const SIGNALS = new Set(["TERM", "INT", "HUP", "QUIT", "KILL", "WINCH"]);
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const STATE_DIR = "/tmp/sbx";

export function encodeFrame(type, bytes = Buffer.alloc(0)) {
  const header = Buffer.alloc(5);
  header[0] = type;
  header.writeUInt32BE(bytes.length, 1);
  return Buffer.concat([header, bytes]);
}

// Incremental frame decoder: push chunks, receive whole frames. Throws on an oversized frame.
export function createDecoder(onFrame) {
  let buffer = Buffer.alloc(0);
  return (chunk) => {
    buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
    while (buffer.length >= 5) {
      const length = buffer.readUInt32BE(1);
      if (length > MAX_FRAME) throw new Error("Frame too large.");
      if (buffer.length < 5 + length) return;
      const type = buffer[0];
      const payload = buffer.subarray(5, 5 + length);
      buffer = buffer.subarray(5 + length);
      onFrame(type, payload);
    }
  };
}

const text = (value, max = 4096) => typeof value === "string" && !value.includes("\0") && value.length <= max;
const dimension = (value) => Number.isInteger(value) && value >= 1 && value <= 1000;

export function parseStart(payload, root) {
  if (payload.length > MAX_START) throw new Error("Start frame too large.");
  const value = JSON.parse(payload.toString("utf8"));
  const { command, cwd, env = {}, tty = false, cols, rows } = value;
  if (!Array.isArray(command) || !command.length || command.length > 1024 || !command.every((arg) => text(arg, 32768)) ||
      command[0] === "" || command[0].includes("=") ||
      !text(cwd) || cwd !== posix.normalize(cwd) || !(cwd === root || cwd.startsWith(root + "/")) ||
      !env || typeof env !== "object" || Array.isArray(env) || Object.keys(env).length > 512 ||
      !Object.entries(env).every(([name, v]) => ENV_NAME.test(name) && text(v, 32768)) ||
      typeof tty !== "boolean" || (tty && (!dimension(cols) || !dimension(rows)))) {
    throw new Error("Invalid sandbox command, environment or working directory.");
  }
  return { command, cwd, env, tty, cols, rows };
}

// Runs in the pod: record the pid (for later signals), enter the directory, and replace the shell by the command.
const START_SCRIPT = 'mkdir -p "$1" && echo $$ >"$2" || exit 126; d=$3; shift 3; cd "$d" || exit 126; exec env -- "$@"';
const SIGNAL_SCRIPT = 'p=$(cat "$1" 2>/dev/null) || exit 0; [ -n "$p" ] || exit 0; ' +
  'kill -s "$2" "-$p" 2>/dev/null || kill -s "$2" "$p" 2>/dev/null; [ "$2" = KILL ] && rm -f "$1"; exit 0';
const CLEAN_SCRIPT = 'rm -f "$1"';

export function remoteCommand(id, { command, cwd, env }) {
  const pidFile = `${STATE_DIR}/pid.${id}`;
  return {
    pidFile,
    argv: ["sh", "-c", START_SCRIPT, "sbx", STATE_DIR, pidFile, cwd,
      ...Object.entries(env).map(([name, value]) => `${name}=${value}`), ...command],
  };
}

// Connection to the pod's exec subresource over the Kubernetes channel WebSocket protocol.
// Channels: 0 stdin, 1 stdout, 2 stderr, 3 status, 4 resize, 255 close a stream.
export function kubeOpener({ authority, token, ca }) {
  return function open({ namespace, pod, container, argv, tty, stdin }) {
    const query = new URLSearchParams({ container, stdin: String(stdin), stdout: "true", stderr: String(!tty), tty: String(tty) });
    for (const arg of argv) query.append("command", arg);
    const url = `wss://${authority}/api/v1/namespaces/${encodeURIComponent(namespace)}/pods/${encodeURIComponent(pod)}/exec?${query}`;
    const socket = new WebSocket(url, ["v5.channel.k8s.io"], {
      ca,
      headers: { authorization: `Bearer ${token()}` },
      maxPayload: 8 * MAX_FRAME,
      handshakeTimeout: 10_000,
    });
    const pending = [];
    const sendNow = (message, done) => socket.send(message, { binary: true }, done);
    return {
      send(channel, bytes = Buffer.alloc(0), done = () => {}) {
        const message = Buffer.concat([Buffer.from([channel]), bytes]);
        if (socket.readyState === WebSocket.OPEN) sendNow(message, done);
        else if (socket.readyState === WebSocket.CONNECTING) pending.push([message, done]);
        return socket.readyState === WebSocket.OPEN && socket.bufferedAmount < MAX_FRAME;
      },
      endInput() { this.send(255, Buffer.from([0])); },
      onOpen(fn) {
        socket.on("open", () => {
          fn();
          for (const [message, done] of pending.splice(0)) sendNow(message, done);
        });
      },
      onMessage(fn) { socket.on("message", (data) => { if (data.length) fn(data[0], data.subarray(1)); }); },
      onClose(fn) { socket.on("close", fn); socket.on("error", fn); },
      pause: () => socket.pause(),
      resume: () => socket.resume(),
      close() { try { socket.terminate(); } catch {} },
    };
  };
}

function exitCode(payload) {
  let status;
  try { status = JSON.parse(payload.toString("utf8")); } catch { return { code: 125, message: "Unreadable exec status." }; }
  if (status.status === "Success") return { code: 0 };
  const cause = status.details?.causes?.find((c) => c.reason === "ExitCode");
  if (cause) return { code: Math.min(255, Number.parseInt(cause.message, 10) || 1) };
  return { code: 125, message: typeof status.message === "string" ? status.message : "Sandbox exec failed." };
}

// Serves one exec request: the client's frames drive a pod process; its output goes back as frames.
// `open` is injectable (tests); `track(+1|-1)` reports activity to the idle sweeper.
export function serveExec(request, response, { root, namespace, pod, open, track = () => {}, keepEnvironment = [] }) {
  const id = randomBytes(8).toString("hex");
  let conn = null;
  let remote = null;
  let finished = false;
  let started = false;
  let connected = false;
  let inputEnded = false;
  const startTimer = setTimeout(() => reply(408, "Timed out waiting for the start frame."), 10_000).unref();

  const reply = (status, message) => {
    if (finished) return;
    finished = true;
    clearTimeout(startTimer);
    if (!response.headersSent) response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: message }));
  };
  const run = (argv) => {
    try {
      const helper = open({ namespace, pod, container: "main", argv, tty: false, stdin: false });
      helper.onClose(() => {});
      helper.onMessage(() => {});
      return helper;
    } catch {}
  };
  const signalRemote = (signal) => remote && run(["sh", "-c", SIGNAL_SCRIPT, "sbx", remote.pidFile, signal]);
  const cleanRemote = () => remote && run(["sh", "-c", CLEAN_SCRIPT, "sbx", remote.pidFile]);
  function finish(code, message, clean = true) {
    if (finished) return;
    finished = true;
    track(-1);
    request.resume();
    if (message && !response.destroyed) response.write(encodeFrame(RESPONSE.STDERR, Buffer.from(message + "\n")));
    if (!response.destroyed && !response.writableEnded) response.end(encodeFrame(RESPONSE.EXIT, Buffer.from([code])));
    conn?.close();
    if (clean) cleanRemote();
  }
  function terminate() {
    if (!remote) return;
    signalRemote("TERM");
    setTimeout(() => signalRemote("KILL"), 3000).unref();
  }

  function abort() {
    if (finished) return;
    finished = true;
    clearTimeout(startTimer);
    if (started) track(-1);
    terminate();
    conn?.close();
  }

  function endInput() {
    if (inputEnded) return;
    inputEnded = true;
    conn.endInput();
  }

  function begin(payload) {
    let spec;
    try { spec = parseStart(payload, root); } catch (error) { return reply(400, error.message); }
    clearTimeout(startTimer);
    for (const name of keepEnvironment) delete spec.env[name];
    remote = remoteCommand(id, spec);
    track(1);
    started = true;
    response.writeHead(200, { "content-type": "application/octet-stream", "cache-control": "no-store" });
    response.flushHeaders();
    try {
      conn = open({ namespace, pod, container: "main", argv: remote.argv, tty: spec.tty, stdin: true });
    } catch {
      return finish(125, "Could not reach the Kubernetes API.");
    }
    let status = null;
    request.pause();
    conn.onOpen(() => {
      connected = true;
      if (spec.tty) conn.send(4, Buffer.from(JSON.stringify({ Width: spec.cols, Height: spec.rows })));
      request.resume();
    });
    conn.onMessage((channel, bytes) => {
      if (channel === 1 || channel === 2) {
        for (let offset = 0; offset < bytes.length; offset += MAX_FRAME) {
          if (!response.destroyed && !response.write(encodeFrame(channel, bytes.subarray(offset, offset + MAX_FRAME)))) conn.pause();
        }
      } else if (channel === 3) status = exitCode(bytes);
    });
    response.on("drain", () => conn?.resume());
    conn.onClose(() => {
      if (finished) return;
      if (!status && connected) terminate();
      finish(status?.code ?? 255, status?.message ?? (status ? undefined : "Lost the connection to the sandbox."), Boolean(status));
    });
  }

  function handle(type, payload) {
    if (finished) return;
    if (type === REQUEST.STDIN && !inputEnded) {
      if (conn.send(0, payload, () => { if (connected && !finished) request.resume(); }) === false) request.pause();
    } else if (type === REQUEST.EOF) endInput();
    else if (type === REQUEST.RESIZE) {
      try {
        const { cols, rows } = JSON.parse(payload.toString("utf8"));
        if (dimension(cols) && dimension(rows)) conn.send(4, Buffer.from(JSON.stringify({ Width: cols, Height: rows })));
      } catch {}
    } else if (type === REQUEST.SIGNAL) {
      try {
        const { signal } = JSON.parse(payload.toString("utf8"));
        if (SIGNALS.has(signal)) signalRemote(signal);
      } catch {}
    }
  }

  let first = true;
  const decode = createDecoder((type, payload) => {
    if (first) {
      first = false;
      if (type !== REQUEST.START) return reply(400, "The first frame must be START.");
      return begin(payload);
    }
    handle(type, payload);
  });
  request.on("data", (chunk) => {
    if (finished) return;
    try { decode(chunk); } catch {
      if (!started) reply(400, "Malformed frame.");
      else {
        terminate();
        finish(125, "Malformed frame.", false);
      }
    }
  });
  request.on("end", () => {
    if (finished) return;
    if (started) endInput();
    else reply(400, "Missing start frame.");
  });
  request.on("error", abort);
  response.on("close", abort);
}
