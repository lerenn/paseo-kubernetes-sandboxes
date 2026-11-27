import { useState } from "react";
import { useNewWorkspace, useRpc } from "@getpaseo/plugin/client";
import { Combobox } from "@getpaseo/plugin/client/ui";
import { executionOptions } from "../shared/contracts.js";
import { executionChoice, executionKey } from "../shared/execution.js";

export function ExecutionField() {
  const workspace = useNewWorkspace();
  const options = useRpc(executionOptions);
  const [label, setLabel] = useState<string>();
  const saved = executionChoice.safeParse(workspace.metadata[executionKey]);
  const selected = saved.success ? saved.data : undefined;

  return (
    <Combobox
      title="Execution"
      icon="Server"
      value={selected === "local" ? { id: "local", label: "Local" } : selected
        ? { id: `profile:${selected.profile}`, label: label ?? (selected.profile === "docker" ? "Docker" : selected.profile) } : null}
      search={async ({ query }) => {
        const { localAllowed, profiles, connectionId, error } = await options({});
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
      }}
      onSelect={async ({ item }) => {
        if (!item.selection) throw new Error(item.label);
        await workspace.setMetadata({ [executionKey]: item.selection });
        setLabel(item.label);
      }}
    />
  );
}
