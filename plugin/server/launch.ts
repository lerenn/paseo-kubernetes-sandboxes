import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Configuration } from "../shared/settings.js";
import { MAIN_CONTAINER, STATE_DIR } from "../shared/sandbox.js";

export type Wrap = [string, ...string[]];

export const launcherPath = () => join(dirname(fileURLToPath(import.meta.url)), "..", "launcher", "kube-exec.sh");

// The wrap Paseo prepends to the command. It ends with `--` because Paseo appends the command directly.
export function buildWrap(
  c: Pick<Configuration, "context" | "namespace">,
  pod: string,
  opts: { cwd: string; envNames: string[]; launcher?: string },
): Wrap {
  return [
    opts.launcher ?? launcherPath(),
    ...(c.context ? ["--context", c.context] : []),
    "--namespace",
    c.namespace,
    "--pod",
    pod,
    "--container",
    MAIN_CONTAINER,
    "--state-dir",
    STATE_DIR,
    "--cwd",
    opts.cwd,
    ...opts.envNames.flatMap((n) => ["--env", n]),
    "--",
  ];
}

// Only plain variable names can be forwarded by the launcher.
export const forwardableEnv = (env: Record<string, string>) => Object.keys(env).filter((k) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k));
