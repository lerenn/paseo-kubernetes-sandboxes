#!/usr/bin/env node
// Launch wrapper: runs "<command> [args...]" in a sandbox through the Paseo sandbox Gateway.
// Paseo starts it as `sandbox-exec.mjs <options> -- <command> [args...]`.
//
//   --url URL          Gateway HTTPS base URL
//   --token-file FILE  file holding the scoped Gateway token (never passed on the command line)
//   --ca-file FILE     CA certificate that signed the Gateway's certificate (optional)
//   --workspace ID     workspace id of the sandbox
//   --profile ID       expected profile of the sandbox
//   --privileged BOOL  expected privilege level of the sandbox
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
  else if (flag === "--profile") options.profile = value;
  else if (flag === "--privileged") options.privileged = value;
  else if (flag === "--cwd") options.cwd = value;
  else if (flag === "--env") options.env.push(value);
  else fail(`unknown option ${flag}`);
}
const command = args;
if (!options.url || !options.tokenFile || !options.workspace || !options.cwd) fail("--url, --token-file, --workspace and --cwd are required");
if (!command.length) fail("no command given");

let url;
try { url = new URL(options.url); } catch { fail("invalid Gateway URL"); }
if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
  fail("the Gateway URL must be an HTTPS origin");
}
let token;
try {
  token = readFileSync(options.tokenFile, "utf8").trim();
} catch {
  fail("could not read the token file");
}
if (!/^[A-Za-z0-9_-]{43,256}$/.test(token)) fail("invalid Gateway token");
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

const session = connect(url.origin, { ca, rejectUnauthorized: true });
const preflightError = () => {};
session.on("error", preflightError);
try {
  // Verify the versioned Gateway endpoint on this same TLS session before sending the token.
  await new Promise((resolve, reject) => {
    const probe = session.request({ ":method": "GET", ":path": "/v1/gateway/healthz" });
    const timer = setTimeout(() => probe.destroy(new Error("Gateway verification timed out")), 10_000).unref();
    let status;
    let body = "";
    probe.setEncoding("utf8");
    probe.on("response", (headers) => { status = headers[":status"]; });
    probe.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1024) probe.destroy(new Error("Gateway verification response is too large"));
    });
    probe.once("error", reject);
    probe.once("close", () => clearTimeout(timer));
    probe.once("end", () => {
      try {
        const result = JSON.parse(body);
        if (status === 200 && result?.ok === true && result.type === "gateway") return resolve();
      } catch {}
      reject(new Error("Gateway verification failed"));
    });
    probe.end();
  });
} catch {
  session.destroy();
  fail("the HTTPS endpoint did not verify as a Sandbox Gateway", 77);
}
const stream = session.request({
  ":method": "POST",
  ...(options.privileged === undefined ? {} : { "x-paseo-sandbox-privileged": options.privileged }),
  ...(options.profile ? { "x-paseo-sandbox-profile": options.profile } : {}),
  ":path": `/v1/gateway/sandboxes/${encodeURIComponent(options.workspace)}/exec`,
  authorization: `Bearer ${token}`,
  "content-type": "application/octet-stream",
});
stream.on("error", (error) => connectionError("connection to the Gateway failed", error));
stream.write(frame(REQUEST.START, json({ command, cwd: options.cwd, env, tty, ...(tty ? size() : {}) })));

session.off("error", preflightError);
session.on("error", (error) => connectionError("could not reach the Gateway", error));

let exited = false;
let buffer = Buffer.alloc(0);
let httpStatus = 0;
const errorBody = [];

const responseTimer = setTimeout(() => connectionError("timed out waiting for the Gateway"), 45_000).unref();

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
    let message = `the Gateway answered ${httpStatus || "nothing"}`;
    try { message = JSON.parse(Buffer.concat(errorBody).toString()).error || message; } catch {}
    process.stderr.write(`sandbox-exec: ${message}\n`);
    return leave(httpStatus === 401 || httpStatus === 403 ? 77 : 125);
  }
  process.stderr.write("sandbox-exec: the Gateway ended the stream early\n");
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
