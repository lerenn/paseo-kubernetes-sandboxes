import { useCallback } from "react";
import { useNewWorkspace, useRpc } from "@getpaseo/plugin/client";
import { Combobox } from "@getpaseo/plugin/client/ui";
import { executionOptions } from "../shared/contracts.js";
import { executionChoice, executionKey } from "../shared/execution.js";
import { useSelectedExecution } from "./use-selected-execution.js";

export function ExecutionField() {
  const workspace = useNewWorkspace();
  const options = useRpc(executionOptions);
  const load = useCallback(() => options({}), [options]);
  const saved = executionChoice.safeParse(workspace.metadata[executionKey]);
  const { value, discover } = useSelectedExecution(workspace.host.id, saved.success ? saved.data : undefined, load);

  const search = useCallback(async ({ query }: { query: string }) => {
    const { localAllowed, profiles, connectionId, error } = await discover();
    const items = [
      ...(localAllowed ? [{
        id: "local", label: "Local", description: `Runs on ${workspace.host.label}`, selection: "local" as const,
      }] : []),
      ...(connectionId ? profiles.map((profile) => ({
        id: `profile:${profile.id}`,
        label: profile.label,
        description: profile.description,
        selection: { connectionId, profile: profile.id, privileged: profile.privileged },
      })) : []),
    ].filter((item) => item.label.toLowerCase().includes(query.trim().toLowerCase()));
    if (error && !localAllowed) throw new Error(error);
    if (error) return [...items, { id: "unavailable", label: error, selection: null }];
    return items;
  }, [discover, workspace.host.label]);

  return (
    <Combobox
      title="Execution"
      icon="Server"
      value={value}
      search={search}
      onSelect={async ({ item }) => {
        if (!item.selection) throw new Error(item.label);
        await workspace.setMetadata({ [executionKey]: item.selection });
      }}
    />
  );
}
