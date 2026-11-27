#!/usr/bin/env node
// Launch wrapper: runs "<command> [args...]" in a sandbox through the Paseo sandbox controller.
// Paseo starts it as `sandbox-exec.mjs <options> -- <command> [args...]`.
//
//   --url URL          controller HTTPS base URL
//   --token-file FILE  file holding the scoped controller token (never passed on the command line)
//   --ca-file FILE     CA certificate that signed the controller's certificate (optional)
//   --workspace ID     workspace id of the sandbox
//   --cwd DIR          working directory in the sandbox
//   --env NAME         forward this local environment variable (repeatable)
//
// Only Node built-ins are used. A terminal on stdin/stdout gets a real TTY in the sandbox, with window resizes.
import { readFileSync } from "node:fs";
import { connect } from "node:http2";

const REQUEST = { START: 0, STDIN: 1, RESIZE: 2, EOF: 3, SIGNAL: 4 };
const RESPONSE = { STDOUT: 1, STDERR: 2, EXIT: 3 };
const fail = (message, code = 64) => {
  process.stderr.write(`sandbox-exec: ${message}\n`);
  process.exit(code);
};

const options = { env: [] };
const args = process.argv.slice(2);
while (args.length) {
  const flag = args.shift();
  if (flag === "--") break;
  const value = args.shift();
  if (value === undefined) fail(`${flag} needs a value`);
  if (flag === "--url") options.url = value;
  else if (flag === "--token-file") options.tokenFile = value;
  else if (flag === "--ca-file") options.caFile = value;
  else if (flag === "--workspace") options.workspace = value;
  else if (flag === "--cwd") options.cwd = value;
  else if (flag === "--env") options.env.push(value);
  else fail(`unknown option ${flag}`);
}
const command = args;
if (!options.url || !options.tokenFile || !options.workspace || !options.cwd) fail("--url, --token-file, --workspace and --cwd are required");
if (!command.length) fail("no command given");

let url;
try { url = new URL(options.url); } catch { fail("invalid controller URL"); }
if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
  fail("the controller URL must be an HTTPS origin");
}
let token;
try {
  token = readFileSync(options.tokenFile, "utf8").trim();
} catch {
  fail("could not read the token file");
}
if (!/^[A-Za-z0-9_-]{43,256}$/.test(token)) fail("invalid controller token");
let ca;
try {
  ca = options.caFile ? readFileSync(options.caFile) : undefined;
} catch {
  fail("could not read the CA file");
}

const tty = Boolean(process.stdin.isTTY && process.stdout.isTTY);
const env = Object.create(null);
for (const name of [...options.env, ...(tty ? ["TERM"] : [])]) {
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && process.env[name] !== undefined) env[name] = process.env[name];
}

const frame = (type, payload = Buffer.alloc(0)) => {
  const header = Buffer.alloc(5);
  header[0] = type;
  header.writeUInt32BE(payload.length, 1);
  return Buffer.concat([header, payload]);
};
const json = (value) => Buffer.from(JSON.stringify(value));
const size = () => ({ cols: process.stdout.columns || 80, rows: process.stdout.rows || 24 });

const session = connect(url.origin, { ca });
session.on("error", (error) => connectionError("could not reach the controller", error));
const stream = session.request({
  ":method": "POST",
  ":path": `/v1/sandboxes/${encodeURIComponent(options.workspace)}/exec`,
  authorization: `Bearer ${token}`,
  "content-type": "application/octet-stream",
});
stream.on("error", (error) => connectionError("connection to the controller failed", error));
stream.write(frame(REQUEST.START, json({ command, cwd: options.cwd, env, tty, ...(tty ? size() : {}) })));

let exited = false;
let buffer = Buffer.alloc(0);
let httpStatus = 0;
const errorBody = [];

const responseTimer = setTimeout(() => connectionError("timed out waiting for the controller"), 45_000).unref();

function connectionError(message, error) {
  if (exited) return;
  process.stderr.write(`sandbox-exec: ${message}${error?.code ? ` (${error.code})` : ""}\n`);
  leave(255);
}

function leave(code) {
  if (exited) return;
  exited = true;
  clearTimeout(responseTimer);
  process.stdin.pause();
  if (tty) process.stdin.setRawMode(false);
  const done = () => process.exit(code);
  process.stdout.write("", () => process.stderr.write("", () => { session.destroy(); done(); }));
}

stream.on("response", (headers) => {
  clearTimeout(responseTimer);
  httpStatus = headers[":status"];
  if (httpStatus === 200) {
    if (tty) process.stdin.setRawMode(true);
    process.stdin.resume();
  }
});
stream.on("data", (chunk) => {
  if (httpStatus !== 200) return void errorBody.push(chunk);
  buffer = Buffer.concat([buffer, chunk]);
  while (buffer.length >= 5) {
    const length = buffer.readUInt32BE(1);
    if (buffer.length < 5 + length) return;
    const type = buffer[0];
    const payload = buffer.subarray(5, 5 + length);
    buffer = buffer.subarray(5 + length);
    if (type === RESPONSE.STDOUT || type === RESPONSE.STDERR) {
      const output = type === RESPONSE.STDOUT ? process.stdout : process.stderr;
      if (!output.write(payload)) {
        stream.pause();
        output.once("drain", () => stream.resume());
      }
    }
    else if (type === RESPONSE.EXIT) return leave(payload[0] ?? 255);
  }
});
stream.on("end", () => {
  if (exited) return;
  if (httpStatus !== 200) {
    let message = `the controller answered ${httpStatus || "nothing"}`;
    try { message = JSON.parse(Buffer.concat(errorBody).toString()).error || message; } catch {}
    process.stderr.write(`sandbox-exec: ${message}\n`);
    return leave(httpStatus === 401 || httpStatus === 403 ? 77 : 125);
  }
  process.stderr.write("sandbox-exec: the controller ended the stream early\n");
  leave(255);
});

// Input: a terminal is raw (every key goes to the sandbox, including ^C); otherwise plain pipes.
process.stdin.on("data", (chunk) => {
  for (let offset = 0; offset < chunk.length; offset += 65536) {
    if (!stream.write(frame(REQUEST.STDIN, chunk.subarray(offset, offset + 65536)))) {
      process.stdin.pause();
      stream.once("drain", () => process.stdin.resume());
    }
  }
});
process.stdin.pause();
process.stdin.on("end", () => { if (!exited) stream.write(frame(REQUEST.EOF)); });
process.stdin.on("error", () => {});
if (tty) process.stdout.on("resize", () => stream.write(frame(REQUEST.RESIZE, json(size()))));

// Stop signals reach the sandbox process; if it does not end, leave with the conventional status.
for (const [signal, number] of [["SIGTERM", 15], ["SIGINT", 2], ["SIGHUP", 1]]) {
  process.on(signal, () => {
    if (!stream.writableEnded) stream.write(frame(REQUEST.SIGNAL, json({ signal: signal.slice(3) })));
    setTimeout(() => { stream.close(); leave(128 + number); }, 3000).unref();
  });
}
