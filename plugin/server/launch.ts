import launcher from "./launcher-source.generated.js";
import type { Connection } from "../shared/settings.js";

export type Wrap = [string, ...string[]];

// The wrap Paseo prepends to the command. It ends with `--` because Paseo appends the command directly.
// The token is never in the wrap: the launcher reads it from the token file.
export function buildWrap(
  c: Connection,
  workspaceId: string,
  opts: { cwd: string; envNames: string[] },
): Wrap {
  return [
    // Paseo evaluates the server bundle without a source directory. Keep the launcher in the wrap
    // so an existing agent can reuse it even after the plugin is reloaded.
    process.execPath,
    "--input-type=module",
    "-e",
    launcher,
    "--",
    "sandbox-exec",
    "--url",
    c.controllerUrl,
    "--token-file",
    c.tokenFile,
    ...(c.caFile ? ["--ca-file", c.caFile] : []),
    "--workspace",
    workspaceId,
    "--cwd",
    opts.cwd,
    ...opts.envNames.flatMap((n) => ["--env", n]),
    "--",
  ];
}

// Only plain variable names can be forwarded.
export const forwardableEnv = (env: Record<string, string>) => Object.keys(env).filter((k) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k));
