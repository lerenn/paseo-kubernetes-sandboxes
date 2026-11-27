import { useEffect, useState } from "react";
import type { z } from "zod";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { ExternalLink, Icon, Loading, ScrollView, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { useRpc, useSettings, type PluginScreenProps } from "@getpaseo/plugin/client";
import { controllerCheck, prepareSettingsSave, sandboxStop, workspacesList, type SandboxProfile } from "../shared/contracts.js";
import {
  isConfigured, needsGatewayMigration, namedConnectionSchema, sandboxSettings, settingsSchema, standardConnectionId,
  workspaceRoute, type Configuration, type NamedConnection,
} from "../shared/settings.js";
import { Badge, Button, Card, Choice, Field } from "./components.js";

const controllerIcon = "Server";

const TABS = [
  { id: "workspaces", label: "Workspaces", icon: "FolderGit2" },
  { id: "profiles", label: "Profiles", icon: "Layers" },
  { id: "connection", label: "Gateway", icon: controllerIcon },
] as const;

type TabId = (typeof TABS)[number]["id"];

const setupGuide = "https://kubernetes-sandboxes.paseo.lerenn.dev/getting-started.html";

const connectionFields = [
  {
    key: "controllerUrl",
    label: "Gateway HTTPS URL",
    placeholder: "https://sandbox.example.internal",
    help: "Ask your administrator for the private Gateway HTTPS endpoint. The Paseo daemon must be able to reach it over HTTP/2. After entering the URL and file paths, select Check connection, then Save Gateway.",
  },
  {
    key: "tokenFile",
    label: "Token file on the daemon",
    placeholder: "/path/to/gateway.token",
    help: "Ask your administrator to issue an Gateway token and provide the absolute path to its file on the Paseo daemon. If the daemon runs in a container, use the path inside that container. From the daemon environment, run test -r /path/to/gateway.token to check readability without printing the token.",
  },
  {
    key: "caFile",
    label: "CA file on the daemon (optional)",
    placeholder: "/path/to/gateway-ca.crt",
    help: "If the endpoint uses a private CA that the daemon does not already trust, ask your administrator for its PEM certificate and the absolute path to the mounted file inside the daemon environment. Run test -r /path/to/gateway-ca.crt there to check readability. Leave this field blank if the daemon already trusts the CA.",
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

type ControllerCheck = z.infer<typeof controllerCheck.output>;

function profileAvailability(connection: NamedConnection, result: ControllerCheck | null | undefined) {
  if (!isConfigured(connection)) return "Set the HTTPS URL and token file in Gateway.";
  if (result === undefined) return "Checking for authorized profiles…";
  if (result === null) return "Profile discovery failed.";
  const reach = result.checks.find(({ id }) => id === "reach");
  const auth = result.checks.find(({ id }) => id === "auth");
  if (reach?.status === "fail") return "Endpoint unreachable.";
  if (auth?.status === "fail") return auth.detail;
  if (auth?.status !== "ok") return "Check the endpoint and credential files in Gateway.";
  return result.profiles.length === 0 ? "No profiles authorized for this token." : null;
}

const resourceLabels = [
  ["cpu", "CPU"],
  ["memory", "RAM"],
  ["ephemeral-storage", "Ephemeral storage"],
] as const;

function ProfileResources({ resources, theme, compact }: {
  resources: SandboxProfile["resources"];
  theme: PluginScreenProps["theme"];
  compact: boolean;
}) {
  const text = { color: theme.colors.foregroundMuted, fontSize: 13 };
  const heading = [text, table.heading];
  return (
    <View role="cell" style={[profileTable.resources, compact && profileTable.compactResources]}>
      {compact && <Text style={heading}>Container resources</Text>}
      {resources === undefined ? <Text style={text}>Unavailable from controller</Text> : (
        <>
          <View style={profileTable.resourceLine}>
            <View style={profileTable.resourceName} />
            <Text style={[heading, profileTable.quantity]}>Request</Text>
            <Text style={[heading, profileTable.quantity]}>Limit</Text>
          </View>
          {resources.map(({ kind, name, requests, limits }) => (
            <View key={JSON.stringify([kind, name])} style={{ gap: 2 }}>
              <Text style={[heading, { color: theme.colors.foreground }]}>
                {kind === "main" ? "Main container" : kind === "init" ? `Init container (${name})` : `Sidecar (${name})`}
              </Text>
              {resourceLabels.map(([key, label]) => (
                <View key={key} style={profileTable.resourceLine}>
                  <Text style={[text, profileTable.resourceName]}>{label}</Text>
                  <Text accessibilityLabel={`${label} request: ${requests[key] ?? "Unset"}`} style={[text, profileTable.quantity]}>
                    {requests[key] ?? "Unset"}
                  </Text>
                  <Text accessibilityLabel={`${label} limit: ${limits[key] ?? "Unset"}`} style={[text, profileTable.quantity]}>
                    {limits[key] ?? "Unset"}
                  </Text>
                </View>
              ))}
            </View>
          ))}
        </>
      )}
    </View>
  );
}

function blankConnection(id: string, name = ""): NamedConnection {
  return { id, name, gateway: true, controllerUrl: "", tokenFile: "", caFile: "" };
}

export function SandboxScreen({ theme, layout }: PluginScreenProps) {
  const settings = useSettings(sandboxSettings);
  const check = useRpc(controllerCheck);
  const list = useRpc(workspacesList);
  const stop = useRpc(sandboxStop);
  const prepareSave = useRpc(prepareSettingsSave);
  const [tab, setTab] = useState<TabId>(TABS[0].id);
  const [editor, setEditor] = useState<{ connection: NamedConnection; existing: boolean } | null>(null);
  const [editorCheck, setEditorCheck] = useState<Awaited<ReturnType<typeof check>> | null>(null);
  const [discovery, setDiscovery] = useState<{
    revision: string;
    checks: Map<string, ControllerCheck | null>;
  } | null>(null);
  const [rows, setRows] = useState<Awaited<ReturnType<typeof list>>["workspaces"] | null>(null);
  const [selection, setSelection] = useState<{ workspace: string; connectionId: string; profile?: string } | null>(null);
  const [confirmation, setConfirmation] = useState<{ id: string; revision: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const revision = settings.status === "ready" ? settings.revision : null;
  const checks = discovery?.revision === revision ? discovery.checks : undefined;

  useEffect(() => {
    if (settings.status !== "ready") return;
    let current = true;
    const { revision } = settings;
    setDiscovery({ revision, checks: new Map() });
    setRows(null);
    setSelection(null);
    setConfirmation(null);
    void list({}).then(({ workspaces }) => {
      if (current) setRows(workspaces);
    }, () => {
      if (current) setError("The workspace list could not be read.");
    });
    for (const connection of settings.values.connections.filter(isConfigured)) {
      function record(result: ControllerCheck | null) {
        if (current) {
          setDiscovery((previous) => previous?.revision === revision
            ? { revision, checks: new Map(previous.checks).set(connection.id, result) }
            : previous);
        }
      }
      void check(connection).then(record, () => record(null));
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
  const migrating = needsGatewayMigration(config);
  const gateway = migrating ? undefined : config.connections[0];
  const validated = editor && namedConnectionSchema.safeParse(editor.connection);
  const available = config.connections.filter(({ id }) => checks?.get(id)?.profiles.length);
  const text = { color: theme.colors.foregroundMuted, fontSize: 14, lineHeight: 21 };
  const pad = layout.compact ? 16 : 28;

  function choose(workspace: string, connectionId: string, profile?: string) {
    const standard = checks?.get(connectionId)?.profiles.find(({ id, privileged }) => id === "standard" && !privileged);
    setSelection({ workspace, connectionId, profile: profile ?? standard?.id });
  }

  const tableFrame = [table.frame, { borderColor: theme.colors.border }];
  const tableHeader = [table.row, table.header, { backgroundColor: theme.colors.surface2 }];
  const tableRow = [table.row, table.divider, { borderColor: theme.colors.border }];
  const profileRow = layout.compact ? table.compact : undefined;
  const profileSources = tab === "profiles" ? config.connections.map((connection) => {
    const result = checks?.get(connection.id);
    return { connection, result, status: profileAvailability(connection, result) };
  }) : [];
  const profileRows = profileSources.flatMap(({ connection, result, status }) =>
    status ? [] : (result?.profiles ?? []).map((profile) => ({ connection, profile })),
  );

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
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          <View role="tablist" style={{ flexDirection: "row", gap: layout.compact ? 0 : 4 }}>
            {TABS.map((t) => {
              const active = tab === t.id;
              return (
                <Pressable
                  key={t.id}
                  accessibilityRole="tab"
                  aria-selected={active}
                  accessibilityLabel={t.label}
                  onPress={() => setTab(t.id)}
                  style={{ flexDirection: "row", alignItems: "center", gap: layout.compact ? 4 : 7, paddingHorizontal: layout.compact ? 2 : 14, paddingVertical: 10, borderBottomWidth: 2, borderBottomColor: active ? theme.colors.accent : "transparent" }}
                >
                  <Icon name={t.icon} size={15} color={active ? theme.colors.accent : theme.colors.foregroundMuted} />
                  <Text style={{ color: active ? theme.colors.foreground : theme.colors.foregroundMuted, fontSize: 14, fontWeight: "600" }}>{t.label}</Text>
                </Pressable>
              );
            })}
          </View>
        </ScrollView>
      </View>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: pad }}>
        <View style={{ width: "100%", maxWidth: 820, marginHorizontal: "auto", gap: 20 }}>
          {(error || settings.saveError) && <Text accessibilityRole="alert" style={{ ...text, color: theme.colors.statusDanger }}>{error ?? settings.saveError}</Text>}
          {tab === "connection" && <Card theme={theme} icon="Shield" title="Execution policy" description="Applies to new launches on this Paseo host.">
            <SettingsSwitch label="Require a sandbox profile"
              hint="Require an authorized profile for workspace agent sessions, terminals and setup commands. Existing sessions and unassigned workspace history and teardown stay available."
              value={config.requireSandboxProfile} disabled={busy || migrating || settings.status !== "ready"}
              onValueChange={(required) => void action(() => save({ ...config, requireSandboxProfile: required }))} />
          </Card>}
          {migrating && <Text accessibilityRole="alert" style={text}>
            Saved workspace assignments are waiting for Gateway migration. Ask your administrator to confirm that the Gateway is ready and old sandboxes have stopped, then open Gateway to migrate.
          </Text>}
          {tab === "connection" && <Card theme={theme} icon={controllerIcon} title="Gateway" description="Use the Gateway URL and one credential provided by your administrator.">
            {gateway && <Text style={text}>{gateway.controllerUrl}</Text>}
            {!editor && (
              <Button theme={theme} label={migrating ? "Migrate to Gateway" : gateway ? "Edit or check Gateway" : "Set up Gateway"}
                disabled={busy}
                onPress={() => {
                  setEditor({ connection: gateway ?? blankConnection(standardConnectionId, "Gateway"), existing: Boolean(gateway) });
                  setEditorCheck(null);
                }} />
            )}
            {editor && (
              <View style={{ gap: 12 }}>
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
                  <Button theme={theme} label={migrating ? "Migrate saved assignments" : "Save Gateway"} primary disabled={busy || !validated?.success}
                    onPress={() => void action(async () => {
                      if (!validated?.success) return;
                      const connection = validated.data;
                      await save({
                        ...config,
                        connections: [connection],
                        workspaces: migrating ? config.workspaces.map((workspace) => ({
                          ...workspace,
                          connectionId: connection.id,
                          privileged: workspace.profile ? workspace.privileged ?? (workspace.profile === "docker") : workspace.privileged,
                        })) : config.workspaces,
                      });
                      setEditor(null);
                    })} />
                  {editor.existing && !config.workspaces.some(({ connectionId }) => connectionId === editor.connection.id) && (
                    <Button theme={theme} label="Remove Gateway" disabled={busy} onPress={() => void action(async () => {
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

          {tab === "profiles" && <Card theme={theme} icon="Layers" title="Profiles" description="Profiles authorized by your Gateway credential. Resource values come from the profile configuration. Persistent workspace storage uses shared volumes.">
            {config.connections.length === 0 && <Text style={text}>Set up the Gateway to see available profiles.</Text>}
            {profileRows.length > 0 && (
              <View role="table" accessibilityLabel="Available profiles" style={tableFrame}>
                <View role="row" style={[tableHeader, profileRow]}>
                  <Text role="columnheader" style={[text, table.heading, profileTable.profile]}>Profile</Text>
                  <Text role="columnheader" style={[text, table.heading, profileTable.id]}>ID</Text>
                  <Text role="columnheader" style={[text, table.heading, profileTable.controller]}>Controller</Text>
                  <Text role="columnheader" style={[text, table.heading, profileTable.privilege]}>Privilege</Text>
                  {!layout.compact && <Text role="columnheader" style={[text, table.heading, profileTable.resources]}>Container resources</Text>}
                </View>
                {profileRows.map(({ connection, profile }) => (
                  <View key={JSON.stringify([connection.id, profile.id])} role="row" style={[tableRow, profileRow, profileTable.bodyRow, layout.compact && profileTable.compactRow]}>
                    <Text role="cell" style={[text, profileTable.profile, { color: theme.colors.foreground }]}>{profile.label}</Text>
                    <Text role="cell" style={[text, profileTable.id]}>{profile.id}</Text>
                    <View role="cell" style={[profileTable.controller, profileTable.controllerCell]}>
                      <Icon name={controllerIcon} size={14} color={theme.colors.foregroundMuted} />
                      <View style={profileTable.controllerLabel}>
                        <Text style={[text, { color: theme.colors.foreground }]}>{profile.controller ?? connection.name}</Text>
                        <Text style={text}>{profile.controller ? `via ${connection.name} (${connection.id})` : connection.id}</Text>
                      </View>
                    </View>
                    <View role="cell" style={profileTable.privilege}>
                      {profile.privileged && <Badge theme={theme} label="Privileged" tone="warning" />}
                    </View>
                    <ProfileResources resources={profile.resources} theme={theme} compact={layout.compact} />
                  </View>
                ))}
              </View>
            )}
            {profileSources.map(({ connection, status }) => status && (
              <View key={connection.id} style={[table.divider, { borderColor: theme.colors.border, paddingTop: 12, gap: 4 }]}>
                <Text role="heading" style={[text, table.heading, { color: theme.colors.foreground }]}>
                  {connection.name} <Text style={text}>{connection.id}</Text>
                </Text>
                <Text style={text}>{status}</Text>
              </View>
            ))}
          </Card>}

          {tab === "workspaces" && <Card theme={theme} icon="FolderGit2" title="Workspaces" description="Choose a sandbox profile for each workspace.">
            <Button theme={theme} label="Refresh status" disabled={busy || settings.status !== "ready"}
              onPress={() => void action(async () => setRows((await list({})).workspaces))} />
            {rows?.length === 0 && <Text style={text}>No workspaces on this host.</Text>}
            {!available.length && rows?.length ? <Text style={text}>Save a Gateway credential that grants access to at least one profile.</Text> : null}
            {rows?.map((row) => {
              const route = workspaceRoute(config, row.id);
              const chosen = route && checks?.get(route.connection.id)?.profiles.find(({ id, privileged }) =>
                id === route.workspace.profile && (route.workspace.privileged === undefined || privileged === route.workspace.privileged));
              const choosing = selection?.workspace === row.id ? selection : null;
              const confirming = confirmation?.id === row.id && confirmation.revision === revision;
              const hasSandbox = row.sandbox !== "absent";
              const choices = choosing ? checks?.get(choosing.connectionId)?.profiles ?? [] : [];
              const selected = choices.find(({ id }) => id === choosing?.profile);
              return (
                <View key={row.id} style={{ borderTopWidth: 1, borderColor: theme.colors.border, paddingVertical: 12, gap: 8 }}>
                  <Text style={{ color: theme.colors.foreground, fontWeight: "600", fontSize: 16 }}>{row.name}</Text>
                  <Text style={text}>{row.directory}</Text>
                  <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
                    <Badge theme={theme} label={route ? statusLabels[row.sandbox] : config.requireSandboxProfile ? "Profile required" : "Runs on daemon"}
                      tone={row.sandbox === "running" ? "success" : "muted"} />
                    {chosen && <Badge theme={theme} label={chosen.label} tone={chosen.privileged ? "warning" : "muted"} />}
                    {route && !chosen && <Text style={text}>{route.workspace.profile ? `Saved profile: ${route.workspace.profile}` : "Choose a profile"}</Text>}
                  </View>
                  <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                    {!hasSandbox && !choosing && (
                      <Button theme={theme} label={route ? "Change profile" : "Enable sandbox"}
                        disabled={busy || !available.length}
                        onPress={() => {
                          setConfirmation(null);
                          choose(row.id, route?.connection.id ?? gateway?.id ?? standardConnectionId, chosen?.id);
                        }} />
                    )}
                    {route && hasSandbox && row.sandbox !== "stopping" && !confirming && (
                      <Button theme={theme} label="Stop sandbox" disabled={busy || !isConfigured(route.connection)}
                        onPress={() => { setSelection(null); if (revision) setConfirmation({ id: row.id, revision }); }} />
                    )}
                    {route && !hasSandbox && !choosing && !config.requireSandboxProfile && (
                      <Button theme={theme} label="Disable sandbox" disabled={busy}
                        onPress={() => void action(() => save({ ...config, workspaces: config.workspaces.filter(({ id }) => id !== row.id) }))} />
                    )}
                  </View>
                  {route && hasSandbox && !confirming && (
                    <Text style={text}>Stop the sandbox and wait for No sandbox before changing its profile.</Text>
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

const table = StyleSheet.create({
  frame: { borderWidth: 1, borderRadius: 8 },
  header: { borderTopLeftRadius: 7, borderTopRightRadius: 7 },
  divider: { borderTopWidth: 1 },
  heading: { fontWeight: "600" },
  compact: { gap: 4, paddingHorizontal: 5 },

  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
});

const profileTable = StyleSheet.create({
  profile: { flex: 3, minWidth: 0 },
  id: { flex: 2.5, minWidth: 0 },
  controller: { flex: 3.5, minWidth: 0 },
  controllerCell: { flexDirection: "row", alignItems: "center", gap: 4 },
  controllerLabel: { flex: 1, minWidth: 0 },
  privilege: { width: 80 },
  bodyRow: { alignItems: "flex-start", paddingVertical: 8 },
  compactRow: { flexWrap: "wrap" },
  resources: { flex: 6, minWidth: 0, gap: 6 },
  compactResources: { flexBasis: "100%", flexGrow: 0, paddingTop: 4 },
  resourceLine: { flexDirection: "row", gap: 4 },
  resourceName: { flex: 2, minWidth: 0 },
  quantity: { flex: 1, minWidth: 0 },
});
