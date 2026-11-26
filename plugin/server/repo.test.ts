import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanRemote, parseGitdirPointer, resolveRepo, subPathFor } from "./repo.js";

test("parseGitdirPointer finds the main .git of a linked worktree", () => {
  assert.equal(parseGitdirPointer("gitdir: /workspace/src/app/.git/worktrees/feat\n"), "/workspace/src/app/.git");
  assert.equal(parseGitdirPointer("gitdir: relative/.git/worktrees/x"), null);
  assert.equal(parseGitdirPointer("nothing"), null);
});

test("cleanRemote refuses credentials", () => {
  assert.equal(cleanRemote("git@github.com:o/r.git"), "git@github.com:o/r.git");
  assert.equal(cleanRemote("https://github.com/o/r.git"), "https://github.com/o/r.git");
  assert.throws(() => cleanRemote("https://user:tok@github.com/o/r.git"), /credentials/);
  assert.throws(() => cleanRemote("https://tok@github.com/o/r.git"), /credentials/);
});

test("subPathFor maps a daemon path into the claim", () => {
  assert.equal(subPathFor("/base", "", "/base/a/b"), "a/b");
  assert.equal(subPathFor("/base", "x/y", "/base/a"), "x/y/a");
  assert.equal(subPathFor("/base", "x", "/base"), "x");
  assert.equal(subPathFor("/base", "", "/base"), "");
  assert.throws(() => subPathFor("/base", "", "/other"), /not under/);
  assert.throws(() => subPathFor("", "", "/other"), /base path/);
});

test("resolveRepo reads a real linked worktree", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "repo-")));
  const git = (cwd: string, ...a: string[]) => execFileSync("git", ["-C", cwd, "-c", "user.email=t@t", "-c", "user.name=t", ...a], { stdio: "pipe" });
  const main = join(dir, "main");
  mkdirSync(main);
  git(main, "init", "-q", "-b", "trunk");
  git(main, "commit", "-q", "--allow-empty", "-m", "i");
  git(main, "remote", "add", "origin", "https://example.com/o/r.git");
  const wt = join(dir, "wt");
  git(main, "worktree", "add", "-q", "-b", "feat", wt);
  return resolveRepo(join(wt)).then((r) => {
    assert.equal(r.root, wt);
    assert.equal(r.gitDir, join(main, ".git"));
    assert.equal(r.remoteUrl, "https://example.com/o/r.git");
    assert.equal(r.branch, "feat");
    writeFileSync(join(wt, "x"), "");
  });
});
