import { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { ExternalLink, Icon, Loading, ScrollView } from "@getpaseo/plugin/client/ui";
import { useRpc, useSettings, type PluginScreenProps } from "@getpaseo/plugin/client";
import { controllerCheck, sandboxStop, workspacesList } from "../shared/contracts.js";
import { isConfigured, sandboxSettings, settingsSchema, type Configuration } from "../shared/settings.js";
import { Badge, Button, Card, Choice, Field } from "./components.js";

const TABS = [
  { id: "connection", label: "Controller connection", icon: "Server" },
  { id: "workspaces", label: "Workspaces", icon: "FolderGit2" },
] as const;

type TabId = (typeof TABS)[number]["id"];

const connectionFields = [
  { key: "controllerUrl", label: "Controller URL", placeholder: "https://sandbox.example.internal" },
  { key: "tokenFile", label: "Token file on the daemon", placeholder: "/path/to/controller.token" },
  { key: "caFile", label: "CA file on the daemon (optional)", placeholder: "/path/to/controller-ca.crt" },
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
  const [tab, setTab] = useState<TabId>("connection");
  const [draft, setDraft] = useState(() => settingsSchema.parse({}));
  const [checks, setChecks] = useState<Awaited<ReturnType<typeof check>> | null>(null);
  const [rows, setRows] = useState<Awaited<ReturnType<typeof list>>["workspaces"] | null>(null);
  const [selection, setSelection] = useState<{ workspace: string; profile: string | undefined } | null>(null);
  const [confirmation, setConfirmation] = useState<{ workspace: string; disable: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const revision = settings.status === "ready" ? settings.revision : null;

  useEffect(() => {
    if (settings.status !== "ready") return;
    setDraft(settings.values);
    setSelection(null);
    setConfirmation(null);
    let current = true;
    void list({}).then(({ workspaces }) => {
      if (current) setRows(workspaces);
    }, () => {
      if (current) setError("The workspace list could not be read.");
    });
    if (isConfigured(settings.values)) {
      const { controllerUrl, tokenFile, caFile } = settings.values;
      void check({ controllerUrl, tokenFile, caFile }).then((result) => {
        if (current) setChecks(result);
      }, () => {
        if (current) setChecks(null);
      });
    }
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

  const removeWorkspace = (id: string) => save({ ...draft, workspaces: draft.workspaces.filter((w) => w.id !== id) });

  if (settings.status === "loading") return <Loading />;
  const ready = settings.status === "ready";
  const dirty = !ready || connectionFields.some(({ key }) => draft[key] !== settings.values[key]);
  const validated = settingsSchema.safeParse(draft);
  const profiles = checks?.profiles ?? [];
  const standard = profiles.find(({ id, privileged }) => id === "standard" && !privileged);
  const text = { color: theme.colors.foregroundMuted, fontSize: 14, lineHeight: 21 };
  const pad = layout.compact ? 16 : 28;

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.surface0 }}>
      <View style={{ paddingHorizontal: pad, paddingTop: pad, gap: 14, borderBottomWidth: 1, borderBottomColor: theme.colors.border }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 14 }}>
          <View style={{ width: 44, height: 44, borderRadius: 12, backgroundColor: theme.colors.accent, alignItems: "center", justifyContent: "center" }}>
            <Icon name="Boxes" size={26} color={theme.colors.accentForeground} />
          </View>
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={{ color: theme.colors.foreground, fontSize: layout.compact ? 20 : 24, fontWeight: "700" }}>Kubernetes Sandbox</Text>
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13 }}>Run a workspace's agents, terminals and commands in a Kubernetes pod.</Text>
          </View>
          <ExternalLink href="https://github.com/lerenn/paseo-kubernetes-sandbox/blob/main/docs/setup.md">Setup guide</ExternalLink>
        </View>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 4 }}>
          {TABS.map((t) => {
            const active = tab === t.id;
            return (
              <Pressable
                key={t.id}
                accessibilityRole="tab"
                accessibilityState={{ selected: active }}
                accessibilityLabel={t.label}
                onPress={() => setTab(t.id)}
                style={{ flexDirection: "row", alignItems: "center", gap: 7, paddingHorizontal: 14, paddingVertical: 10, borderBottomWidth: 2, borderBottomColor: active ? theme.colors.accent : "transparent" }}
              >
                <Icon name={t.icon} size={15} color={active ? theme.colors.accent : theme.colors.foregroundMuted} />
                <Text style={{ color: active ? theme.colors.foreground : theme.colors.foregroundMuted, fontSize: 14, fontWeight: "600" }}>{t.label}</Text>
              </Pressable>
            );
          })}
        </ScrollView>
      </View>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: pad }}>
        <View style={{ width: "100%", maxWidth: 820, marginHorizontal: "auto", gap: 20 }}>
          {(error || settings.saveError) && <Text accessibilityRole="alert" style={{ ...text, color: theme.colors.statusDanger }}>{error ?? settings.saveError}</Text>}
          {tab === "connection" && <Card theme={theme} icon="Server" title="Controller connection" description="Use the private endpoint and credential files provided by your administrator.">
            {connectionFields.map(({ key, label, placeholder }) => (
              <Field key={key} theme={theme} label={label} placeholder={placeholder} value={draft[key]} disabled={busy}
                error={validated.error?.issues.find(({ path }) => path[0] === key)?.message}
                onChange={(value) => { setDraft((d) => ({ ...d, [key]: value })); setChecks(null); setSelection(null); setConfirmation(null); }} />
            ))}
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
              <Button theme={theme} label="Save connection" primary disabled={busy || !dirty || !validated.success}
                onPress={() => void action(() => save(draft))} />
              <Button theme={theme} label="Check connection" disabled={busy || !validated.success}
                onPress={() => void action(async () => setChecks(await check({
                  controllerUrl: draft.controllerUrl, tokenFile: draft.tokenFile, caFile: draft.caFile,
                })))} />
            </View>
            {checks?.checks.map(({ id, label, status, detail }) => (
              <View key={id} style={{ gap: 4 }}>
                <Badge theme={theme} label={label + " · " + (status === "ok" ? "Verified" : status === "fail" ? "Failed" : "Skipped")}
                  tone={status === "ok" ? "success" : status === "fail" ? "warning" : "muted"} />
                <Text style={text}>{detail}</Text>
              </View>
            ))}
          </Card>}

          {tab === "workspaces" && <Card theme={theme} icon="FolderGit2" title="Workspaces" description="Choose a sandbox profile for each workspace you want to run in Kubernetes.">
            <Button theme={theme} label="Refresh status" disabled={busy || !ready}
              onPress={() => void action(async () => setRows((await list({})).workspaces))} />
            {rows?.length === 0 && <Text style={text}>No workspaces on this host.</Text>}
            {!profiles.length && rows?.length ? <Text style={text}>Check and save the connection to load available profiles.</Text> : null}
            {rows?.map((row) => {
              const workspace = draft.workspaces.find(({ id }) => row.id === id);
              const chosen = profiles.find(({ id }) => id === workspace?.profile);
              const choosing = selection?.workspace === row.id ? selection : null;
              const confirming = confirmation?.workspace === row.id ? confirmation : null;
              const hasSandbox = row.sandbox !== "absent";
              const selected = profiles.find(({ id }) => id === choosing?.profile);
              return (
                <View key={row.id} style={{ borderTopWidth: 1, borderColor: theme.colors.border, paddingVertical: 12, gap: 8 }}>
                  <Text style={{ color: theme.colors.foreground, fontWeight: "600", fontSize: 16 }}>{row.name}</Text>
                  <Text style={text}>{row.directory}</Text>
                  <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
                    <Badge theme={theme} label={workspace ? statusLabels[row.sandbox] : "Runs on daemon"}
                      tone={row.sandbox === "running" ? "success" : "muted"} />
                    {chosen && <Badge theme={theme} label={chosen.label} tone={chosen.privileged ? "warning" : "muted"} />}
                    {workspace && !chosen && <Text style={text}>{workspace.profile ? "Saved profile unavailable" : "Choose a profile"}</Text>}
                  </View>
                  <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                    {(!workspace || !hasSandbox) && !choosing && (
                      <Button theme={theme} label={workspace?.profile ? "Change profile" : workspace ? "Choose profile" : "Enable sandbox"}
                        disabled={busy || dirty || !profiles.length}
                        onPress={() => {
                          setConfirmation(null);
                          setSelection({ workspace: row.id, profile: chosen?.id ?? standard?.id });
                        }} />
                    )}
                    {workspace && row.sandbox !== "absent" && row.sandbox !== "stopping" && !confirming && (
                      <Button theme={theme} label="Stop sandbox" disabled={busy || dirty || !isConfigured(draft)}
                        onPress={() => { setSelection(null); setConfirmation({ workspace: row.id, disable: false }); }} />
                    )}
                    {workspace && !confirming && (
                      <Button theme={theme} label="Disable sandbox" disabled={busy || dirty}
                        onPress={() => {
                          setSelection(null);
                          if (hasSandbox && isConfigured(draft)) setConfirmation({ workspace: row.id, disable: true });
                          else void action(() => removeWorkspace(row.id));
                        }} />
                    )}
                  </View>
                  {workspace && hasSandbox && !confirming && (
                    <Text style={text}>Stop the sandbox and refresh its status before changing profiles.</Text>
                  )}
                  {confirming && (
                    <View style={{ gap: 8 }}>
                      <Text style={text}>Stopping deletes this sandbox. Running processes and ephemeral state are lost. Shared worktree files are kept.</Text>
                      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                        <Button theme={theme} label="Cancel" disabled={busy} onPress={() => setConfirmation(null)} />
                        <Button theme={theme} label={confirming.disable ? "Stop and disable" : "Stop and delete sandbox"} danger disabled={busy || dirty}
                          onPress={() => void action(async () => {
                            await stop({ workspaceId: row.id });
                            if (confirming.disable) await removeWorkspace(row.id);
                            setRows((await list({})).workspaces);
                            setConfirmation(null);
                          })} />
                      </View>
                    </View>
                  )}
                  {choosing && (
                    <View style={{ gap: 8 }} accessibilityRole="radiogroup">
                      {profiles.map((profile) => (
                        <Choice key={profile.id} theme={theme} role="radio" label={profile.label} checked={profile.id === choosing.profile}
                          description={profile.privileged ? "For trusted workspaces only." : undefined} disabled={busy || dirty}
                          onChange={() => setSelection({ ...choosing, profile: profile.id })} />
                      ))}
                      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                        <Button theme={theme} label="Cancel" disabled={busy} onPress={() => setSelection(null)} />
                        <Button theme={theme} label={workspace ? "Save profile" : "Enable with profile"} primary
                          disabled={busy || dirty || !selected || (Boolean(workspace) && hasSandbox)}
                          onPress={() => void action(async () => {
                            if (!selected) return;
                            await save({ ...draft, workspaces: [
                              ...draft.workspaces.filter((w) => w.id !== row.id), { id: row.id, profile: selected.id },
                            ] });
                            setSelection(null);
                          })} />
                      </View>
                    </View>
                  )}
                </View>
              );
            })}
          </Card>}
        </View>
      </ScrollView>
    </View>
  );
}
