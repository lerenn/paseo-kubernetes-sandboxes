import { z } from "zod";
import { profileId, type Configuration } from "./settings.js";

export const executionKey = "kubernetes-sandbox.execution";
export const executionChoice = z.union([
  z.literal("local"),
  z.object({ connectionId: profileId, profile: profileId, privileged: z.boolean() }).strict(),
]);

// Host settings retain precedence so existing controls can reassign or disable a created route.
export function withWorkspaceExecution(
  config: Configuration,
  entries: readonly { id: string; metadata?: Readonly<Record<string, unknown>> | null }[],
): Configuration {
  const assigned = new Set([...config.workspaces.map(({ id }) => id), ...config.localWorkspaces]);
  const workspaces = [...config.workspaces];
  for (const { id, metadata } of entries) {
    const choice = metadata?.[executionKey];
    if (assigned.has(id) || choice === undefined) continue;
    const route = executionChoice.parse(choice);
    if (route !== "local") workspaces.push({ id, ...route });
  }
  return { ...config, workspaces };
}
