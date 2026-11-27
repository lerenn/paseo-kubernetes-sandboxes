import { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { ExternalLink, Icon, Loading, ScrollView } from "@getpaseo/plugin/client/ui";
import { useRpc, useSettings, type PluginScreenProps } from "@getpaseo/plugin/client";
import { controllerCheck, prepareSettingsSave, sandboxStop, workspacesList } from "../shared/contracts.js";
import {
  isConfigured, namedConnectionSchema, sandboxSettings, settingsSchema, standardConnectionId,
  workspaceRoute, type Configuration, type NamedConnection,
} from "../shared/settings.js";
import { Badge, Button, Card, Choice, Field } from "./components.js";

const TABS = [
  { id: "connection", label: "Controller connections", icon: "Server" },
  { id: "workspaces", label: "Workspaces", icon: "FolderGit2" },
] as const;

type TabId = (typeof TABS)[number]["id"];

const setupGuide = "https://kubernetes-sandboxes.paseo.lerenn.dev/getting-started.html";

const connectionFields = [
  { key: "name", label: "Connection name", placeholder: "Standard", help: undefined },
  {
    key: "controllerUrl",
    label: "Controller URL",
    placeholder: "https://sandbox.example.internal",
    help: "Ask your administrator for the private HTTPS endpoint. The Paseo daemon must be able to reach it over HTTP/2. After entering the URL and file paths, select Save connection, then Check connection.",
  },
  {
    key: "tokenFile",
    label: "Token file on the daemon",
    placeholder: "/path/to/controller.token",
    help: "Ask your administrator to issue a controller token and provide the absolute path to its file on the Paseo daemon. If the daemon runs in a container, use the path inside that container. From the daemon environment, run test -r /path/to/controller.token to check readability without printing the token.",
  },
  {
    key: "caFile",
    label: "CA file on the daemon (optional)",
    placeholder: "/path/to/controller-ca.crt",
    help: "If the endpoint uses a private CA that the daemon does not already trust, ask your administrator for its PEM certificate and the absolute path to the mounted file inside the daemon environment. Run test -r /path/to/controller-ca.crt there to check readability. Leave this field blank if the daemon already trusts the CA.",
  },
] as const;

const statusLabels = {
  running: "Running",
  starting: "Starting",
  stopping: "Stopping",
  failed: "Failed",
  absent: "No sandbox",
  unknown: "Unavailable",
} as const;

function blankConnection(id: string, name = ""): NamedConnection {
  return { id, name, controllerUrl: "", tokenFile: "", caFile: "" };
}

export function SandboxScreen({ theme, layout }: PluginScreenProps) {
  const settings = useSettings(sandboxSettings);
  const check = useRpc(controllerCheck);
  const list = useRpc(workspacesList);
  const stop = useRpc(sandboxStop);
  const prepareSave = useRpc(prepareSettingsSave);
  const [tab, setTab] = useState<TabId>("connection");
  const [editor, setEditor] = useState<{ connection: NamedConnection; existing: boolean } | null>(null);
  const [editorCheck, setEditorCheck] = useState<Awaited<ReturnType<typeof check>> | null>(null);
  const [checks, setChecks] = useState<Record<string, Awaited<ReturnType<typeof check>>>>({});
  const [rows, setRows] = useState<Awaited<ReturnType<typeof list>>["workspaces"] | null>(null);
  const [selection, setSelection] = useState<{ workspace: string; connectionId: string; profile?: string } | null>(null);
  const [confirmation, setConfirmation] = useState<{ id: string; revision: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const revision = settings.status === "ready" ? settings.revision : null;

  useEffect(() => {
    if (settings.status !== "ready") return;
    let current = true;
    setChecks({});
    setRows(null);
    setSelection(null);
    setConfirmation(null);
    void list({}).then(({ workspaces }) => {
      if (current) setRows(workspaces);
    }, () => {
      if (current) setError("The workspace list could not be read.");
    });
    for (const connection of settings.values.connections.filter(isConfigured)) {
      void check(connection).then((result) => {
        if (current) setChecks((previous) => ({ ...previous, [connection.id]: result }));
      }, () => {});
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
    await prepareSave({ revision: settings.revision, values: parsed });
    if (!(await settings.save(parsed, settings.revision))) throw new Error("Settings changed. Try again.");
  }

  if (settings.status === "loading") return <Loading />;
  const config = settings.status === "ready" ? settings.values : settingsSchema.parse({});
  const validated = editor && namedConnectionSchema.safeParse(editor.connection);
  const available = config.connections.filter(({ id }) => checks[id]?.profiles.length);
  const text = { color: theme.colors.foregroundMuted, fontSize: 14, lineHeight: 21 };
  const pad = layout.compact ? 16 : 28;

  function choose(workspace: string, connectionId: string, profile?: string) {
    const standard = checks[connectionId]?.profiles.find(({ id, privileged }) => id === "standard" && !privileged);
    setSelection({ workspace, connectionId, profile: profile ?? standard?.id });
  }

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
          <ExternalLink href={setupGuide}>Setup guide</ExternalLink>
        </View>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 4 }}>
          {TABS.map((t) => {
            const active = tab === t.id;
            return (
              <Pressable
                key={t.id}
                accessibilityRole="tab"
                aria-selected={active}
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
          {tab === "connection" && <Card theme={theme} icon="Server" title="Controller connections" description="Use the private endpoints and credential files provided by your administrator.">
            {config.connections.map((connection) => (
              <View key={connection.id} style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
                <Text style={text}>{connection.name} ({connection.id})</Text>
                <Button theme={theme} label={`Edit ${connection.name}`} disabled={busy}
                  onPress={() => { setEditor({ connection, existing: true }); setEditorCheck(null); }} />
              </View>
            ))}
            {!editor && (
              <Button theme={theme} label="Add connection" disabled={busy || config.connections.length >= 20}
                onPress={() => {
                  const standard = !config.connections.some(({ id }) => id === standardConnectionId);
                  setEditor({ connection: standard ? blankConnection(standardConnectionId, "Standard") : blankConnection(""), existing: false });
                  setEditorCheck(null);
                }} />
            )}
            {editor && (
              <View style={{ gap: 12 }}>
                <Field theme={theme} label="Connection ID" placeholder="docker-lab" value={editor.connection.id}
                  disabled={busy || editor.existing}
                  error={validated ? validated.error?.issues.find(({ path }) => path[0] === "id")?.message : undefined}
                  onChange={(id) => { setEditor({ ...editor, connection: { ...editor.connection, id } }); setEditorCheck(null); }} />
                {connectionFields.map(({ key, label, placeholder, help }) => (
                  <Field key={key} theme={theme} label={label} placeholder={placeholder} value={editor.connection[key]} disabled={busy}
                    help={help && (
                      <View style={{ gap: 4 }}>
                        <Text style={text}>{help}</Text>
                        <ExternalLink href={setupGuide}>Setup guide for administrators</ExternalLink>
                      </View>
                    )}
                    error={validated ? validated.error?.issues.find(({ path }) => path[0] === key)?.message : undefined}
                    onChange={(value) => { setEditor({ ...editor, connection: { ...editor.connection, [key]: value } }); setEditorCheck(null); }} />
                ))}
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                  <Button theme={theme} label="Cancel" disabled={busy} onPress={() => setEditor(null)} />
                  <Button theme={theme} label="Check connection" disabled={busy || !validated?.success}
                    onPress={() => void action(async () => setEditorCheck(await check(editor.connection)))} />
                  <Button theme={theme} label="Save connection" primary disabled={busy || !validated?.success}
                    onPress={() => void action(async () => {
                      if (!validated?.success) return;
                      const connection = validated.data;
                      if (!editor.existing && config.connections.some(({ id }) => id === connection.id)) {
                        throw new Error("Choose a unique connection ID.");
                      }
                      await save({
                        ...config,
                        connections: editor.existing
                          ? config.connections.map((old) => old.id === connection.id ? connection : old)
                          : [...config.connections, connection],
                      });
                      setEditor(null);
                    })} />
                  {editor.existing && !config.workspaces.some(({ connectionId }) => connectionId === editor.connection.id) && (
                    <Button theme={theme} label="Remove connection" disabled={busy} onPress={() => void action(async () => {
                      await save({ ...config, connections: config.connections.filter(({ id }) => id !== editor.connection.id) });
                      setEditor(null);
                    })} />
                  )}
                </View>
                {editorCheck?.checks.map(({ id, label, status, detail }) => (
                  <View key={id} style={{ gap: 4 }}>
                    <Badge theme={theme} label={label + " · " + (status === "ok" ? "Verified" : status === "fail" ? "Failed" : "Skipped")}
                      tone={status === "ok" ? "success" : status === "fail" ? "warning" : "muted"} />
                    <Text style={text}>{detail}</Text>
                  </View>
                ))}
              </View>
            )}
          </Card>}

          {tab === "workspaces" && <Card theme={theme} icon="FolderGit2" title="Workspaces" description="Choose a controller connection and its sandbox profile for each workspace.">
            <Button theme={theme} label="Refresh status" disabled={busy || settings.status !== "ready"}
              onPress={() => void action(async () => setRows((await list({})).workspaces))} />
            {rows?.length === 0 && <Text style={text}>No workspaces on this host.</Text>}
            {!available.length && rows?.length ? <Text style={text}>Save a connection that grants access to at least one profile.</Text> : null}
            {rows?.map((row) => {
              const route = workspaceRoute(config, row.id);
              const chosen = route && checks[route.connection.id]?.profiles.find(({ id, privileged }) =>
                id === route.workspace.profile && (route.workspace.privileged === undefined || privileged === route.workspace.privileged));
              const choosing = selection?.workspace === row.id ? selection : null;
              const confirming = confirmation?.id === row.id && confirmation.revision === revision;
              const hasSandbox = row.sandbox !== "absent";
              const choices = choosing ? checks[choosing.connectionId]?.profiles ?? [] : [];
              const selected = choices.find(({ id }) => id === choosing?.profile);
              return (
                <View key={row.id} style={{ borderTopWidth: 1, borderColor: theme.colors.border, paddingVertical: 12, gap: 8 }}>
                  <Text style={{ color: theme.colors.foreground, fontWeight: "600", fontSize: 16 }}>{row.name}</Text>
                  <Text style={text}>{row.directory}</Text>
                  <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
                    <Badge theme={theme} label={route ? statusLabels[row.sandbox] : "Runs on daemon"}
                      tone={row.sandbox === "running" ? "success" : "muted"} />
                    {route && <Badge theme={theme} label={route.connection.name} />}
                    {chosen && <Badge theme={theme} label={chosen.label} tone={chosen.privileged ? "warning" : "muted"} />}
                    {route && !chosen && <Text style={text}>{route.workspace.profile ? `Saved profile: ${route.workspace.profile}` : "Choose a profile"}</Text>}
                  </View>
                  <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                    {!hasSandbox && !choosing && (
                      <Button theme={theme} label={route ? "Change connection or profile" : "Enable sandbox"}
                        disabled={busy || !available.length}
                        onPress={() => {
                          setConfirmation(null);
                          choose(row.id, route?.connection.id ?? standardConnectionId, chosen?.id);
                        }} />
                    )}
                    {route && hasSandbox && row.sandbox !== "stopping" && !confirming && (
                      <Button theme={theme} label="Stop sandbox" disabled={busy || !isConfigured(route.connection)}
                        onPress={() => { setSelection(null); if (revision) setConfirmation({ id: row.id, revision }); }} />
                    )}
                    {route && !hasSandbox && !choosing && (
                      <Button theme={theme} label="Disable sandbox" disabled={busy}
                        onPress={() => void action(() => save({ ...config, workspaces: config.workspaces.filter(({ id }) => id !== row.id) }))} />
                    )}
                  </View>
                  {route && hasSandbox && !confirming && (
                    <Text style={text}>Stop the sandbox and wait for No sandbox before changing its connection or profile.</Text>
                  )}
                  {confirming && (
                    <View style={{ gap: 8 }}>
                      <Text style={text}>Stopping deletes this sandbox. Running processes and ephemeral state are lost. Shared worktree files are kept.</Text>
                      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                        <Button theme={theme} label="Cancel" disabled={busy} onPress={() => setConfirmation(null)} />
                        <Button theme={theme} label="Stop and delete sandbox" danger disabled={busy}
                          onPress={() => void action(async () => {
                            await stop({ workspaceId: row.id, revision: confirmation.revision });
                            setRows((await list({})).workspaces);
                            setConfirmation(null);
                          })} />
                      </View>
                    </View>
                  )}
                  {choosing && (
                    <View style={{ gap: 8 }}>
                      <View accessibilityRole="radiogroup">
                        {available.map(({ id, name }) => (
                          <Choice key={id} theme={theme} role="radio" label={`${name} (${id})`} checked={id === choosing.connectionId}
                            disabled={busy} onChange={() => choose(row.id, id)} />
                        ))}
                      </View>
                      <View accessibilityRole="radiogroup">
                        {choices.map((profile) => (
                          <Choice key={profile.id} theme={theme} role="radio" label={profile.label} checked={profile.id === choosing.profile}
                            description={profile.privileged ? "For trusted workspaces only." : undefined} disabled={busy}
                            onChange={() => setSelection({ ...choosing, profile: profile.id })} />
                        ))}
                      </View>
                      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                        <Button theme={theme} label="Cancel" disabled={busy} onPress={() => setSelection(null)} />
                        <Button theme={theme} label={route ? "Save workspace route" : "Enable with profile"} primary
                          disabled={busy || !selected || hasSandbox}
                          onPress={() => void action(async () => {
                            if (!selected) return;
                            await save({ ...config, workspaces: [
                              ...config.workspaces.filter((w) => w.id !== row.id),
                              { id: row.id, connectionId: choosing.connectionId, profile: selected.id, privileged: selected.privileged },
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
