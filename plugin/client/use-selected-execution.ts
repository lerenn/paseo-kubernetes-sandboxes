import { useCallback, useEffect, useRef, useState } from "react";
import type { z } from "zod";
import type { executionOptions } from "../shared/contracts.js";
import type { executionChoice } from "../shared/execution.js";

type Selection = z.infer<typeof executionChoice>;
type Options = z.infer<typeof executionOptions.output>;
type LoadOptions = () => Promise<Options>;

export function useSelectedExecution(hostId: string, selected: Selection | undefined, load: LoadOptions) {
  const [discovery, setDiscovery] = useState<{ hostId: string; load: LoadOptions; data: Options }>();
  const request = useRef(0);
  const connectionId = selected && selected !== "local" ? selected.connectionId : undefined;
  const data = discovery?.hostId === hostId && discovery.load === load ? discovery.data : undefined;

  const discover = useCallback(async () => {
    const version = ++request.current;
    const next = await load();
    if (version === request.current) setDiscovery({ hostId, load, data: next });
    return next;
  }, [hostId, load]);

  useEffect(() => {
    if (connectionId) void discover().catch(() => {});
    return () => { request.current++; };
  }, [connectionId, discover]);

  if (selected === "local") return { value: { id: "local", label: "Local" }, discover };
  if (!selected) return { value: null, discover };
  const profile = data?.connectionId === selected.connectionId
    ? data.profiles.find(({ id }) => id === selected.profile)
    : undefined;
  const label = profile?.label ?? (selected.profile === "docker" ? "Docker" : selected.profile);
  return { value: { id: `profile:${selected.profile}`, label }, discover };
}
