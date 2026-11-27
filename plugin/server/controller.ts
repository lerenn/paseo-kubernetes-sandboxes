import { readFileSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import { z } from "zod";
import { sandboxProfile } from "../shared/contracts.js";
import type { Connection } from "../shared/settings.js";

export class ControllerError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const sandboxStatus = z.object({
  profile: z.string(),
  phase: z.string(),
  ready: z.boolean(),
  deleting: z.boolean(),
}).nullable();
const statusResponse = z.object({ sandbox: sandboxStatus });
export type SandboxStatus = z.infer<typeof sandboxStatus>;

// One JSON request to the controller. The token is read per call (a rotated file is picked up) and never logged.
export function call<T>(c: Connection, method: string, path: string, body?: unknown, timeoutMs = 15_000): Promise<T> {
  return new Promise((resolve, reject) => {
    let token = "";
    let ca: Buffer | undefined;
    try {
      token = path === "/healthz" ? "" : readFileSync(c.tokenFile, "utf8").trim();
      ca = c.caFile ? readFileSync(c.caFile) : undefined;
    } catch {
      return reject(new ControllerError(0, "Could not read the token file or CA file on the daemon host."));
    }
    const url = new URL(path, c.controllerUrl);
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = httpsRequest(
      url,
      {
        method,
        ca,
        timeout: timeoutMs,
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("error", reject);
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > 256 * 1024) req.destroy(new Error("controller response was too large"));
          else chunks.push(chunk);
        });
        res.on("end", () => {
          const status = res.statusCode ?? 0;
          let parsed;
          try {
            parsed = JSON.parse(Buffer.concat(chunks).toString());
          } catch {
            return reject(new ControllerError(status, "The controller returned an invalid response."));
          }
          if (status >= 200 && status < 300) resolve(parsed as T);
          else reject(new ControllerError(status, String(parsed?.error ?? `The controller answered ${status}.`)));
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", (e: NodeJS.ErrnoException) => reject(new ControllerError(0, `Could not reach the controller (${e.code ?? e.message}).`)));
    req.end(payload);
  });
}

const sandboxPath = (workspaceId: string) => `/v1/sandboxes/${encodeURIComponent(workspaceId)}`;

export const health = (c: Connection) => call<{ ok: boolean }>(c, "GET", "/healthz");
export const profiles = async (c: Connection, timeoutMs?: number) =>
  z.object({ profiles: z.array(sandboxProfile) }).parse(await call(c, "GET", "/v1/profiles", undefined, timeoutMs)).profiles;
export const getSandbox = async (c: Connection, workspaceId: string) =>
  statusResponse.parse(await call(c, "GET", sandboxPath(workspaceId))).sandbox;
export const stopSandbox = (c: Connection, workspaceId: string) => call(c, "DELETE", sandboxPath(workspaceId));

// Creates the sandbox if needed and waits until it is ready (the controller answers immediately).
export async function ensureSandbox(
  c: Connection & { profile: string; privileged?: boolean },
  workspaceId: string,
  paths: { root: string; gitDir: string | null },
  { timeoutMs = 25_000, intervalMs = 1000 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const body = { profile: c.profile, privileged: c.privileged, root: paths.root, ...(paths.gitDir ? { gitDir: paths.gitDir } : {}) };
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("The sandbox is still starting. Try again in a moment.");
    const { sandbox } = await call<{ sandbox: SandboxStatus }>(c, "PUT", sandboxPath(workspaceId), body, Math.min(remaining, 15_000));
    if (!sandbox?.deleting && (sandbox?.phase === "Failed" || sandbox?.phase === "Succeeded")) {
      throw new Error("The sandbox stopped before it became ready. Stop it in Paseo and retry.");
    }
    if (sandbox?.ready && !sandbox.deleting) return;
    if (Date.now() + intervalMs > deadline) throw new Error("The sandbox is still starting. Try again in a moment.");
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
