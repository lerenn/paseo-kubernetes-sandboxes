import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { join, posix, relative, isAbsolute } from "node:path";

export type RepoInfo = {
  // Top-level folder of the workspace on the daemon host.
  root: string;
  // The main repository's .git directory when `root/.git` is a pointer file (a linked worktree).
  gitDir: string | null;
  remoteUrl: string | null;
  branch: string | null;
};

const git = (cwd: string, args: string[]) =>
  new Promise<string>((resolve, reject) =>
    execFile("git", ["-C", cwd, ...args], { timeout: 10_000 }, (e, out) => (e ? reject(e) : resolve(out.trim()))),
  );

// `gitdir: /repo/.git/worktrees/name` -> `/repo/.git`; null when the text is not such a pointer.
export function parseGitdirPointer(text: string): string | null {
  const m = /^gitdir:\s*(.+?)\s*$/m.exec(text);
  if (!m) return null;
  const target = m[1];
  const at = target.lastIndexOf("/worktrees/");
  return isAbsolute(target) && at > 0 ? target.slice(0, at) : null;
}

// Credentials in a remote URL would end up in the pod spec: refuse them.
export function cleanRemote(url: string): string {
  if (/^[a-z][a-z0-9+.-]*:\/\/[^/@\s]*:[^/@\s]*@/i.test(url) || /^https?:\/\/[^/@\s]+@/i.test(url))
    throw new Error("The repository remote URL contains credentials. Remove them and use the git Secret.");
  return url;
}

export async function resolveRepo(cwd: string): Promise<RepoInfo> {
  let root = cwd;
  try {
    root = await git(cwd, ["rev-parse", "--show-toplevel"]);
  } catch {
    /* not a git checkout: keep cwd */
  }
  let gitDir: string | null = null;
  try {
    const dotGit = join(root, ".git");
    if ((await stat(dotGit)).isFile()) {
      gitDir = parseGitdirPointer(await readFile(dotGit, "utf8"));
      if (!gitDir) throw new Error("The workspace's .git file has an unexpected format.");
    }
  } catch (e) {
    if (e instanceof Error && /unexpected format/.test(e.message)) throw e;
  }
  const remote = await git(root, ["remote", "get-url", "origin"]).catch(() => "");
  const branch = await git(root, ["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => "");
  return { root, gitDir, remoteUrl: remote ? cleanRemote(remote) : null, branch: branch && branch !== "HEAD" ? branch : null };
}

// Sub-directory of a claim for `abs`, given where the daemon sees the claim (`base`) and its own subPath.
export function subPathFor(base: string, sub: string, abs: string): string {
  if (!base.startsWith("/")) throw new Error("Set the volume base path (absolute) in Settings.");
  const rel = relative(base, abs);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(`${abs} is not under the configured base path ${base}.`);
  return posix.join(sub.replace(/^\/+/, ""), rel).replace(/^\.$/, "");
}
