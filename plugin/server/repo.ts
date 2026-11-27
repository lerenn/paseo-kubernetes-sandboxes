import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { join, isAbsolute } from "node:path";

export type RepoInfo = {
  // Top-level folder of the workspace on the daemon host.
  root: string;
  // The main repository's .git directory when `root/.git` is a pointer file (a linked worktree).
  gitDir: string | null;
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
  return { root, gitDir };
}
