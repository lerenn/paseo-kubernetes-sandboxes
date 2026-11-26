import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const launcher = join(dirname(fileURLToPath(import.meta.url)), "kube-exec.sh");

// A fake kubectl: logs its arguments, and runs the command given after `--` locally for `exec`.
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "kube-exec-"));
  const log = join(dir, "calls.log");
  const kubectl = join(dir, "kubectl");
  writeFileSync(
    kubectl,
    `#!/bin/sh
echo "$*" >>"${log}"
[ "$1" = exec ] || exit 0
while [ "$1" != -- ]; do shift; done
shift
exec env -i PATH="$PATH" "$@"
`,
  );
  chmodSync(kubectl, 0o755);
  return { dir, log, state: join(dir, "state"), env: { ...process.env, PASEO_SANDBOX_KUBECTL: kubectl } };
}
const base = (f: ReturnType<typeof fixture>) => ["--namespace", "ns", "--pod", "p1", "--state-dir", f.state];
const calls = (f: ReturnType<typeof fixture>) => readFileSync(f.log, "utf8").trim().split("\n");

test("runs the command through kubectl exec and keeps stdout clean", () => {
  const f = fixture();
  const r = spawnSync(launcher, [...base(f), "--", "printf", "%s\\n", "hello world"], { env: f.env, encoding: "utf8" });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "hello world\n");
  assert.match(calls(f)[0], /^exec -i -n ns p1 -c main -- sh -c /);
});

test("propagates exit codes", () => {
  const f = fixture();
  const r = spawnSync(launcher, [...base(f), "--", "sh", "-c", "exit 7"], { env: f.env });
  assert.equal(r.status, 7);
});

test("passes stdin through and sees EOF", () => {
  const f = fixture();
  const r = spawnSync(launcher, [...base(f), "--", "cat"], { env: f.env, input: "line1\nline2\n", encoding: "utf8" });
  assert.equal(r.stdout, "line1\nline2\n");
});

test("changes directory and forwards only the named, set variables", () => {
  const f = fixture();
  const r = spawnSync(
    launcher,
    [...base(f), "--cwd", tmpdir(), "--env", "FWD_ONE", "--env", "FWD_UNSET", "--", "sh", "-c", 'pwd; echo "$FWD_ONE|${FWD_UNSET-none}|${NOT_FWD-none}"'],
    { env: { ...f.env, FWD_ONE: "a b=c", NOT_FWD: "x" }, encoding: "utf8" },
  );
  assert.equal(r.stdout, `${tmpdir()}\na b=c|none|none\n`);
});

test("uses the context and rejects bad input", () => {
  const f = fixture();
  spawnSync(launcher, ["--context", "ctx1", ...base(f), "--", "true"], { env: f.env });
  assert.match(calls(f)[0], /^--context ctx1 exec /);
  assert.equal(spawnSync(launcher, ["--pod", "p"], { env: f.env }).status, 64);
  assert.equal(spawnSync(launcher, [...base(f), "--"], { env: f.env }).status, 64);
  assert.equal(spawnSync(launcher, [...base(f), "--env", "BAD-NAME", "--", "true"], { env: f.env }).status, 64);
});

test("on SIGTERM it kills the remote process through a second exec", async () => {
  const f = fixture();
  const child = spawn(launcher, [...base(f), "--", "sleep", "30"], { env: f.env, stdio: ["pipe", "pipe", "pipe"] });
  const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
  for (let i = 0; i < 100 && !(existsSync(f.state) && readdirSync(f.state).some((n) => n.startsWith("pid."))); i++)
    await new Promise((r) => setTimeout(r, 50));
  const started = Date.now();
  child.kill("SIGTERM");
  const code = await exited;
  assert.equal(code, 143);
  assert.ok(Date.now() - started < 5000, "exits promptly");
  assert.equal(calls(f).filter((c) => c.startsWith("exec")).length, 2);
  assert.deepEqual(readdirSync(f.state).filter((n) => n.startsWith("pid.")), []);
});
