import { test } from "node:test";
import assert from "node:assert/strict";
import { settingsSchema, type Configuration } from "../shared/settings.js";
import { checkCluster } from "./cluster.js";
import { type Kubectl } from "./kubectl.js";
import type { RepoInfo } from "./repo.js";
import { buildPod } from "./pods.js";
import { buildSshSecret, contentHash, removeSsh, sshStatus, syncSsh } from "./ssh.js";

// Obviously fake placeholders. Never put a real key in a test.
const FAKE_KEY = Buffer.from("FAKE-PRIVATE-KEY-PLACEHOLDER-NOT-A-KEY\n");
const FAKE_HOSTS = Buffer.from("example.invalid ssh-ed25519 FAKE-HOST-KEY-PLACEHOLDER\n");
const files: Record<string, Buffer> = { "/k/key": FAKE_KEY, "/k/hosts": FAKE_HOSTS };
const read = async (p: string) => {
  if (!files[p]) throw new Error("ENOENT secret-looking-path-detail");
  return files[p];
};

const config = (over: Record<string, unknown> = {}): Configuration =>
  settingsSchema.parse({
    image: "img:1",
    worktree: { claimName: "wt", basePath: "/data/worktrees" },
    repo: { basePath: "/workspace/src" },
    ssh: { keyFile: "/k/key", knownHostsFile: "/k/hosts" },
    workspaces: [{ id: "w1" }],
    sidecars: [{ name: "docker", image: "docker:dind" }],
    defaultSidecars: ["docker"],
    ...over,
  });
const repo: RepoInfo = { root: "/data/worktrees/h1/feat", gitDir: "/workspace/src/app/.git", remoteUrl: "git@example.invalid:o/app.git", branch: "feat" };

type Call = { args: string[]; input?: unknown };
function fake(remote: { annotations?: Record<string, string> } | null) {
  const calls: Call[] = [];
  const run: Kubectl = async (args, input) => {
    calls.push({ args, input });
    if (args[0] === "get") {
      if (!remote) return "";
      return args.includes("name") ? "secret/paseo-sandbox-ssh\n" : JSON.stringify(remote.annotations ?? {});
    }
    return "";
  };
  return { run, calls };
}
const leaks = (v: unknown, ...secrets: Buffer[]) => {
  const s = JSON.stringify(v);
  return secrets.some((b) => s.includes(b.toString()));
};

test("settings: paths must be absolute, a key needs known_hosts, nothing is read at parse time", () => {
  assert.equal(settingsSchema.safeParse({ ssh: { keyFile: "relative/key", knownHostsFile: "/h" } }).success, false);
  assert.equal(settingsSchema.safeParse({ ssh: { keyFile: "/k", knownHostsFile: "~/h" } }).success, false);
  assert.equal(settingsSchema.safeParse({ ssh: { keyFile: "/k" } }).success, false);
  assert.equal(settingsSchema.safeParse({ ssh: { knownHostsFile: "/h" } }).success, false);
  // Paths that do not exist parse fine: files are only read when syncing.
  assert.equal(settingsSchema.safeParse({ ssh: { keyFile: "/does/not/exist", knownHostsFile: "/nor/this" } }).success, true);
  assert.equal(settingsSchema.parse({}).ssh.keyFile, "");
});

test("the Secret manifest: labels, hash annotation, data, no plain key", () => {
  const s = buildSshSecret(FAKE_KEY, FAKE_HOSTS, new Date("2026-01-02T03:04:05Z"));
  assert.equal(s.metadata.name, "paseo-sandbox-ssh");
  assert.equal(s.metadata.labels["app.kubernetes.io/managed-by"], "paseo-sandboxes");
  assert.equal(s.metadata.annotations["sandbox.paseo.sh/content-sha256"], contentHash(FAKE_KEY, FAKE_HOSTS));
  assert.equal(s.metadata.annotations["sandbox.paseo.sh/synced-at"], "2026-01-02T03:04:05.000Z");
  assert.equal(Buffer.from(s.data["ssh-privatekey"], "base64").toString(), FAKE_KEY.toString());
  assert.notEqual(contentHash(FAKE_KEY, FAKE_HOSTS), contentHash(FAKE_HOSTS, FAKE_KEY));
  assert.ok(!("annotations" in s.metadata.annotations) && !JSON.stringify(s.metadata).includes(FAKE_KEY.toString()));
});

test("sync creates an absent Secret, key material only on stdin", async () => {
  const f = fake(null);
  assert.equal(await syncSsh(f.run, config(), read), true);
  const write = f.calls.find((c) => c.args[0] === "create")!;
  assert.deepEqual(write.args, ["create", "-f", "-"]);
  assert.equal(leaks(write.args, FAKE_KEY, FAKE_HOSTS), false);
  assert.equal(leaks(f.calls.map((c) => c.args), FAKE_KEY, FAKE_HOSTS), false);
  assert.ok((write.input as any).data["ssh-privatekey"]);
  assert.ok(f.calls.every((c) => c.args[0] !== "apply"), "apply would store the data in last-applied-configuration");
  assert.ok(f.calls.filter((c) => c.args[0] === "get").every((c) => c.args.includes("--ignore-not-found") && !c.args.includes("json") && !c.args.includes("yaml")), "reads never fetch the data");
});

test("sync is a no-op when the hash matches and replaces when the content changed", async () => {
  const same = fake({ annotations: { "sandbox.paseo.sh/content-sha256": contentHash(FAKE_KEY, FAKE_HOSTS) } });
  assert.equal(await syncSsh(same.run, config(), read), false);
  assert.ok(same.calls.every((c) => c.args[0] === "get"));
  const stale = fake({ annotations: { "sandbox.paseo.sh/content-sha256": "0".repeat(64) } });
  assert.equal(await syncSsh(stale.run, config(), read), true);
  assert.deepEqual(stale.calls.at(-1)!.args, ["replace", "-f", "-"]);
});

test("sync does nothing when unconfigured, and read failures do not echo details", async () => {
  const f = fake(null);
  assert.equal(await syncSsh(f.run, settingsSchema.parse({ image: "i" }), read), false);
  assert.equal(f.calls.length, 0);
  await assert.rejects(syncSsh(f.run, config({ ssh: { keyFile: "/missing", knownHostsFile: "/k/hosts" } }), read), (e: Error) => !/secret-looking/.test(e.message));
});

test("status reports presence, hash prefix, time and sync; remove deletes only the fixed name", async () => {
  const h = contentHash(FAKE_KEY, FAKE_HOSTS);
  const ok = await sshStatus(fake({ annotations: { "sandbox.paseo.sh/content-sha256": h, "sandbox.paseo.sh/synced-at": "T" } }).run, config(), read);
  assert.deepEqual(ok, { configured: true, present: true, hashPrefix: h.slice(0, 8), syncedAt: "T", inSync: true, problem: null });
  assert.equal(leaks(ok, FAKE_KEY), false);
  const old = await sshStatus(fake({ annotations: { "sandbox.paseo.sh/content-sha256": "a".repeat(64) } }).run, config(), read);
  assert.equal(old.inSync, false);
  const none = await sshStatus(fake(null).run, config(), read);
  assert.equal(none.present, false);
  const f = fake({});
  await removeSsh(f.run);
  assert.deepEqual(f.calls[0].args.slice(0, 3), ["delete", "secret", "paseo-sandbox-ssh"]);
});

for (const mode of ["shared", "clone"] as const) {
  test(`${mode} pod: main container mounts the Secret read-only with 0400 and GIT_SSH_COMMAND`, () => {
    const pod = buildPod(config(), "w1", mode, repo) as any;
    const vol = pod.spec.volumes.find((v: any) => v.name === "ssh");
    assert.deepEqual(vol, { name: "ssh", secret: { secretName: "paseo-sandbox-ssh", defaultMode: 0o400 } });
    const main = pod.spec.containers[0];
    assert.deepEqual(main.volumeMounts.find((m: any) => m.name === "ssh"), { name: "ssh", mountPath: "/etc/sandbox-ssh", readOnly: true });
    const cmd = main.env.find((e: any) => e.name === "GIT_SSH_COMMAND").value as string;
    assert.match(cmd, /StrictHostKeyChecking=yes/);
    assert.match(cmd, /IdentitiesOnly=yes/);
    assert.match(cmd, /UserKnownHostsFile=\/etc\/sandbox-ssh\/known_hosts/);
    assert.match(cmd, /-i \/etc\/sandbox-ssh\/ssh-privatekey/);
    // Sidecars never get the volume mount or the variable.
    const side = pod.spec.containers.find((c: any) => c.name === "docker");
    assert.ok(!(side.volumeMounts ?? []).some((m: any) => m.name === "ssh"));
    assert.equal(side.env, undefined);
    assert.ok(pod.spec.containers.slice(1).every((c: any) => !JSON.stringify(c).includes("sandbox-ssh")));
    assert.equal(JSON.stringify(pod).includes("FAKE-"), false);
  });
}

test("clone mode: the clone init container gets the Secret too; shared mode has no init container", () => {
  const pod = buildPod(config(), "w1", "clone", repo) as any;
  const init = pod.spec.initContainers[0];
  assert.ok(init.volumeMounts.some((m: any) => m.name === "ssh" && m.readOnly === true));
  assert.ok(init.env.some((e: any) => e.name === "GIT_SSH_COMMAND"));
  assert.equal((buildPod(config(), "w1", "shared", repo) as any).spec.initContainers, undefined);
});

test("without SSH settings pods are unchanged, and the git Secret still works beside SSH", () => {
  const plain = buildPod(config({ ssh: {} }), "w1", "clone", repo) as any;
  assert.ok(!JSON.stringify(plain).includes("ssh"));
  const both = buildPod(config({ clone: { gitSecret: "gs" } }), "w1", "clone", repo) as any;
  const names = both.spec.volumes.map((v: any) => v.name);
  assert.ok(names.includes("git") && names.includes("ssh"));
  const env = both.spec.containers[0].env.map((e: any) => e.name);
  assert.ok(env.includes("GIT_CONFIG_GLOBAL") && env.includes("GIT_SSH_COMMAND"));
  const side = both.spec.containers.find((c: any) => c.name === "docker");
  assert.ok(!(side.volumeMounts ?? []).some((m: any) => m.name === "git" || m.name === "ssh"));
  assert.equal(settingsSchema.safeParse({ sidecars: [{ name: "ssh", image: "i" }] }).success, false);
});

test("the RBAC check covers the Secret rights only when SSH is configured, without reading the Secret", async () => {
  const asked: string[] = [];
  const run: Kubectl = async (a) => {
    asked.push(a.join(" "));
    return a[0] === "auth" ? "yes" : a[0] === "config" ? "ctx" : "x";
  };
  await checkCluster(settingsSchema.parse({ image: "i", worktree: { claimName: "wt", basePath: "/w" } }), run, async () => "v");
  assert.ok(!asked.some((a) => a.includes("secret")));
  asked.length = 0;
  const r = await checkCluster(config(), run, async () => "v");
  for (const q of ["auth can-i create secrets", ...["get", "update", "patch", "delete"].map((v) => `auth can-i ${v} secrets/paseo-sandbox-ssh`)]) assert.ok(asked.includes(q), q);
  assert.ok(asked.every((a) => !/^get secret/.test(a)));
  assert.equal(r.checks.find((x) => x.id === "rbac")!.status, "ok");
});
