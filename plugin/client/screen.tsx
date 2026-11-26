import { useEffect, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useRpc, useSettings, type PluginScreenProps } from "@getpaseo/plugin/client";
import { ExternalLink, Loading, ScrollView, Icon, useToast } from "@getpaseo/plugin/client/ui";
import { sandboxSettings, settingsSchema, type Configuration } from "../shared/settings.js";
import { clusterCheck, clusterContexts, podsDelete, podsList, podsLogs, sshRemove, sshStatus, sshSync, workspacesList } from "../shared/contracts.js";
import { draftProblems } from "./view.js";
import { ClusterTab, OverviewTab, PodsTab, SettingsTab, WorkspacesTab, type ClusterStatus, type SshStatus, type PodRows, type TabId, type WorkspaceRows } from "./tabs.js";

const TABS = [
  { id: "overview", label: "Overview", icon: "Gauge" },
  { id: "cluster", label: "Cluster", icon: "Server" },
  { id: "workspaces", label: "Workspaces", icon: "FolderGit2" },
  { id: "pods", label: "Pods", icon: "Cpu" },
  { id: "settings", label: "Settings", icon: "SlidersHorizontal" },
] as const;

export function SandboxScreen({ theme, layout }: PluginScreenProps) {
  const settings = useSettings(sandboxSettings);
  const toast = useToast();
  const checkRpc = useRpc(clusterCheck),
    contextsRpc = useRpc(clusterContexts),
    listPodsRpc = useRpc(podsList),
    deletePodRpc = useRpc(podsDelete),
    logsRpc = useRpc(podsLogs),
    workspacesRpc = useRpc(workspacesList),
    sshStatusRpc = useRpc(sshStatus),
    sshSyncRpc = useRpc(sshSync),
    sshRemoveRpc = useRpc(sshRemove);
  const [contexts, setContexts] = useState<string[] | null>(null);
  const [ssh, setSsh] = useState<SshStatus | null>(null);
  const [draft, setDraft] = useState<Configuration>(settingsSchema.parse({}));
  const [tab, setTab] = useState<TabId>("overview");
  const [status, setStatus] = useState<ClusterStatus | null>(null);
  const [pods, setPods] = useState<PodRows | null>(null);
  const [rows, setRows] = useState<WorkspaceRows | null>(null);
  const [logs, setLogs] = useState<{ name: string; text: string } | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const revision = settings.status === "ready" ? settings.revision : "";
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  useEffect(() => {
    if (settings.status === "ready") setDraft(settings.values);
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
  const loadPods = async () => setPods((await listPodsRpc({})).pods);
  const loadWorkspaces = async () => setRows((await workspacesRpc({})).workspaces);
  const runCheck = async () => setStatus(await checkRpc({}));

  // Read-only data loads when its tab opens (and after settings change); failures stay on screen as an error.
  useEffect(() => {
    if (settings.status !== "ready") return;
    if (tab === "pods" || tab === "overview") void loadPods().catch(() => setPods(null));
    if (tab === "workspaces") void loadWorkspaces().catch(() => setError("The workspace list could not be read."));
  }, [tab, revision]);

  if (settings.status === "loading") return <Loading />;
  const ready = settings.status === "ready";
  const saved = ready && JSON.stringify(draft) === JSON.stringify(settings.values);
  const patch = <K extends keyof Configuration>(key: K, value: Configuration[K]) => setDraft((d) => ({ ...d, [key]: value }));
  const save = () =>
    action(async () => {
      const current = settingsRef.current;
      if (current.status !== "ready") return;
      if (!(await current.save(settingsSchema.parse(draft), current.revision))) throw new Error("Settings changed. Reload and try again.");
      setStatus(null);
      setContexts(null);
      toast.show("Settings saved.");
    });
  const text = { color: theme.colors.foregroundMuted, fontSize: 14, lineHeight: 21 };
  const pad = layout.compact ? 16 : 28;
  const common = { theme, text, busy, saved, ready, problem: draftProblems(draft)[0]?.message ?? null, onSave: () => void save() };
  const savedValues = ready ? settings.values : draft;

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
          <ExternalLink href="https://github.com/lerenn/paseo-kubernetes-sandboxes/blob/main/docs/setup.md">Setup guide</ExternalLink>
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
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: pad, paddingBottom: pad * 2 }}>
        <View style={{ width: "100%", maxWidth: 1100, minWidth: 0, marginHorizontal: "auto", gap: 24 }}>
          {(error || settings.saveError) && (
            <View accessibilityRole="alert" style={{ padding: 14, borderWidth: 1, borderColor: theme.colors.statusDanger, borderRadius: 10, backgroundColor: theme.colors.surface1 }}>
              <Text style={{ ...text, color: theme.colors.statusDanger }}>{error ?? settings.saveError}</Text>
            </View>
          )}
          {settings.status === "invalid" && <Text style={text}>The saved settings are invalid. Save new values to replace them.</Text>}
          {tab === "overview" && <OverviewTab {...common} saved_={savedValues} status={status} pods={pods} go={setTab} />}
          {tab === "cluster" && <ClusterTab {...common} contexts={contexts} onContexts={() => void action(async () => setContexts((await contextsRpc({})).contexts))} draft={draft} patch={patch} status={status} onCheck={() => void action(runCheck)} ssh={ssh} onSshRefresh={() => void action(async () => setSsh(await sshStatusRpc({})))} onSshSync={() => void action(async () => { setSsh(await sshSyncRpc({})); toast.show("SSH Secret synced."); })} onSshRemove={() => void action(async () => { setSsh(await sshRemoveRpc({})); toast.show("SSH Secret removed."); })} />}
          {tab === "workspaces" && <WorkspacesTab {...common} draft={draft} patch={patch} rows={rows} onRefresh={() => void action(loadWorkspaces)} />}
          {tab === "pods" && (
            <PodsTab
              theme={theme}
              text={text}
              busy={busy}
              pods={pods}
              logs={logs}
              deleting={deleting}
              setDeleting={setDeleting}
              onRefresh={() => void action(loadPods)}
              onLogs={(name) => void action(async () => setLogs({ name, text: (await logsRpc({ name })).text }))}
              onDelete={(name) =>
                void action(async () => {
                  setPods((await deletePodRpc({ name })).pods);
                  setDeleting(null);
                  toast.show("Pod deleted.");
                })
              }
            />
          )}
          {tab === "settings" && <SettingsTab {...common} draft={draft} patch={patch} />}
        </View>
      </ScrollView>
    </View>
  );
}
