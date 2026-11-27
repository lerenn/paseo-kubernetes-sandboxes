import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { useRpc, useSettings, type PluginScreenProps } from "@getpaseo/plugin/client";
import { ExternalLink, Loading, ScrollView } from "@getpaseo/plugin/client/ui";
import { controllerCheck, sandboxStop, workspacesList } from "../shared/contracts.js";
import { isConfigured, optedIn, sandboxSettings, settingsSchema, type Configuration } from "../shared/settings.js";
import { Badge, Button, Card, Choice, Field } from "./components.js";

const connectionFields = [
  { key: "controllerUrl", label: "Controller URL", placeholder: "https://sandbox.example.internal" },
  { key: "tokenFile", label: "Token file on the daemon", placeholder: "/path/to/controller.token" },
  { key: "caFile", label: "CA file on the daemon (optional)", placeholder: "/path/to/controller-ca.crt" },
  { key: "profile", label: "Sandbox profile", placeholder: "development" },
] as const;

const statusLabels = {
  running: "Running",
  starting: "Starting",
  stopping: "Stopping",
  failed: "Failed",
  absent: "No sandbox",
  unknown: "Unavailable",
} as const;

export function SandboxScreen({ theme, layout }: PluginScreenProps) {
  const settings = useSettings(sandboxSettings);
  const check = useRpc(controllerCheck);
  const list = useRpc(workspacesList);
  const stop = useRpc(sandboxStop);
  const [draft, setDraft] = useState(() => settingsSchema.parse({}));
  const [checks, setChecks] = useState<Awaited<ReturnType<typeof check>> | null>(null);
  const [rows, setRows] = useState<Awaited<ReturnType<typeof list>>["workspaces"] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const revision = settings.status === "ready" ? settings.revision : null;

  useEffect(() => {
    if (settings.status !== "ready") return;
    setDraft(settings.values);
    let current = true;
    void list({}).then(({ workspaces }) => {
      if (current) setRows(workspaces);
    }, () => {
      if (current) setError("The workspace list could not be read.");
    });
    return () => { current = false; };
  }, [revision]);

  async function action(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : "The operation failed.");
    } finally {
      setBusy(false);
    }
  }

  async function save(values: Configuration) {
    if (settings.status !== "ready" && settings.status !== "invalid") return;
    const parsed = settingsSchema.parse(values);
    if (!(await settings.save(parsed, settings.revision))) throw new Error("Settings changed. Try again.");
    setDraft(parsed);
  }

  if (settings.status === "loading") return <Loading />;
  const ready = settings.status === "ready";
  const dirty = !ready || connectionFields.some(({ key }) => draft[key] !== settings.values[key]);
  const validated = settingsSchema.safeParse(draft);
  const text = { color: theme.colors.foregroundMuted, fontSize: 14, lineHeight: 21 };
  const pad = layout.compact ? 16 : 28;

  return (
    <ScrollView style={{ flex: 1, backgroundColor: theme.colors.surface0 }} contentContainerStyle={{ padding: pad }}>
      <View style={{ width: "100%", maxWidth: 820, marginHorizontal: "auto", gap: 20 }}>
        <Text style={{ color: theme.colors.foreground, fontWeight: "700", fontSize: 24 }}>Kubernetes Sandbox</Text>
        <ExternalLink href="https://github.com/lerenn/paseo-kubernetes-sandboxes/blob/main/docs/setup.md">Setup guide</ExternalLink>
        {(error || settings.saveError) && <Text accessibilityRole="alert" style={{ ...text, color: theme.colors.statusDanger }}>{error ?? settings.saveError}</Text>}
        <Card theme={theme} icon="Server" title="Controller connection" description="Use the private endpoint and profile provided by your administrator.">
          {connectionFields.map(({ key, label, placeholder }) => (
            <Field key={key} theme={theme} label={label} placeholder={placeholder} value={draft[key]} disabled={busy}
              error={validated.error?.issues.find(({ path }) => path[0] === key)?.message}
              onChange={(value) => { setDraft((d) => ({ ...d, [key]: value })); setChecks(null); }} />
          ))}
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            <Button theme={theme} label="Save connection" primary disabled={busy || !dirty || !validated.success}
              onPress={() => void action(() => save(draft))} />
            <Button theme={theme} label="Check connection" disabled={busy || !validated.success}
              onPress={() => void action(async () => setChecks(await check({
                controllerUrl: draft.controllerUrl, tokenFile: draft.tokenFile, caFile: draft.caFile, profile: draft.profile,
              })))} />
          </View>
          {checks?.checks.map(({ id, label, status, detail }) => (
            <View key={id} style={{ gap: 4 }}>
              <Badge theme={theme} label={label + " · " + (status === "ok" ? "Verified" : status === "fail" ? "Failed" : "Skipped")}
                tone={status === "ok" ? "success" : status === "fail" ? "warning" : "muted"} />
              <Text style={text}>{detail}</Text>
            </View>
          ))}
        </Card>
        <Card theme={theme} icon="FolderGit2" title="Workspaces" description="Opt in to run new agents, terminals and commands in the sandbox.">
          <Button theme={theme} label="Refresh status" disabled={busy || !ready}
            onPress={() => void action(async () => setRows((await list({})).workspaces))} />
          {rows?.length === 0 && <Text style={text}>No workspaces on this host.</Text>}
          {rows?.map((row) => {
            const on = optedIn(draft, row.id);
            return (
              <View key={row.id} style={{ borderTopWidth: 1, borderColor: theme.colors.border, paddingTop: 8, gap: 6 }}>
                <Choice theme={theme} label={row.name} description={row.directory} checked={on}
                  disabled={busy || dirty || (!on && !isConfigured(draft))}
                  onChange={(enabled) => void action(async () => {
                    if (!enabled && isConfigured(draft)) await stop({ workspaceId: row.id });
                    await save({ ...draft, workspaces: enabled
                      ? [...draft.workspaces, { id: row.id }]
                      : draft.workspaces.filter(({ id }) => id !== row.id) });
                  })} />
                {on && (
                  <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
                    <Badge theme={theme} label={statusLabels[row.sandbox]} tone={row.sandbox === "running" ? "success" : "muted"} />
                    {row.sandbox !== "absent" && row.sandbox !== "stopping" && (
                      <Button theme={theme} label="Stop sandbox" disabled={busy || dirty}
                        onPress={() => void action(async () => {
                          await stop({ workspaceId: row.id });
                          setRows((await list({})).workspaces);
                        })} />
                    )}
                  </View>
                )}
              </View>
            );
          })}
        </Card>
      </View>
    </ScrollView>
  );
}
