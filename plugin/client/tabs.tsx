import { Text, View } from "react-native";
import { ExternalLink, Icon } from "@getpaseo/plugin/client/ui";
import type { z } from "zod";
import { Badge, Button, Card, Choice, Disclosure, Field, type Theme } from "./components.js";
import type { clusterCheck, podsList, workspacesList } from "../shared/contracts.js";
import type { Configuration } from "../shared/settings.js";
import { MIN_PASEO_VERSION } from "../shared/settings.js";
import { age, phaseTone, plural, resourceIssue, setupSteps, toggleWorkspace, type Tone } from "./view.js";

export type Body = { color: string; fontSize: number; lineHeight: number };
export type ClusterStatus = z.output<typeof clusterCheck.output>;
export type PodRows = z.output<typeof podsList.output>["pods"];
export type WorkspaceRows = z.output<typeof workspacesList.output>["workspaces"];
export type TabId = "overview" | "cluster" | "workspaces" | "pods" | "settings";

const DOCS = "https://github.com/lerenn/paseo-kubernetes-sandbox/blob/main/docs/setup.md";
const checkTone = (s: string): Tone => (s === "ok" ? "success" : s === "warn" ? "warning" : "muted");
const mono = { fontFamily: "monospace" } as const;

function Notice({ theme, text, children, danger = false }: { theme: Theme; text: Body; children: string; danger?: boolean }) {
  return (
    <View style={{ backgroundColor: theme.colors.surface2, borderRadius: 8, padding: 12 }}>
      <Text style={{ ...text, color: danger ? theme.colors.statusWarning : theme.colors.foregroundMuted }}>{children}</Text>
    </View>
  );
}

function SaveBar(p: { theme: Theme; text: Body; busy: boolean; saved: boolean; ready: boolean; onSave(): void }) {
  return (
    <View style={{ gap: 10 }}>
      <View style={{ flexDirection: "row", gap: 10, flexWrap: "wrap" }}>
        <Button theme={p.theme} label={p.busy ? "Working…" : "Save changes"} primary disabled={p.busy || !p.ready || p.saved} onPress={p.onSave} />
      </View>
      {!p.saved && <Text style={p.text}>You have unsaved changes.</Text>}
    </View>
  );
}

type Common = { theme: Theme; text: Body; busy: boolean; saved: boolean; ready: boolean; onSave(): void };

export function OverviewTab(p: Common & { saved_: Configuration; status: ClusterStatus | null; pods: PodRows | null; go(tab: TabId): void }) {
  const { theme, text } = p;
  const steps = setupSteps(p.saved_, p.status?.checks ?? null);
  const kubectl = p.status?.checks.find((c) => c.id === "kubectl");
  const rbac = p.status?.checks.find((c) => c.id === "rbac");
  const requirements: { label: string; tone: Tone; value: string }[] = [
    { label: `Paseo ${MIN_PASEO_VERSION} or later`, tone: "muted", value: "Enforced by the plugin manifest: Paseo refuses to load the plugin on an older host." },
    { label: "kubectl", tone: checkTone(kubectl?.status ?? "unknown"), value: kubectl?.detail ?? "Run the cluster check." },
    { label: "Cluster access (RBAC)", tone: checkTone(rbac?.status ?? "unknown"), value: rbac?.detail ?? "Run the cluster check." },
  ];
  return (
    <>
      <Card theme={theme} title="Setup" icon="ListChecks" description="Three steps before a workspace can run in a pod.">
        {steps.map((s) => (
          <View key={s.id} style={{ flexDirection: "row", alignItems: "center", gap: 12, flexWrap: "wrap", paddingVertical: 6 }}>
            <Icon name={s.done ? "CircleCheck" : "Circle"} size={18} color={s.done ? theme.colors.statusSuccess : theme.colors.foregroundMuted} />
            <View style={{ flex: 1, minWidth: 180, gap: 2 }}>
              <Text style={{ ...text, color: theme.colors.foreground, fontWeight: "600" }}>{s.label}</Text>
              <Text style={text}>{s.detail}</Text>
            </View>
            <Button theme={theme} label={`Go to ${s.label}`} onPress={() => p.go(s.tab)} />
          </View>
        ))}
      </Card>
      <Card theme={theme} title="Requirements" icon="ClipboardCheck" description="What the daemon host needs.">
        {requirements.map((r) => (
          <View key={r.label} style={{ flexDirection: "row", gap: 12, alignItems: "flex-start", flexWrap: "wrap" }}>
            <View style={{ minWidth: 180 }}>
              <Badge theme={theme} label={r.label} tone={r.tone} />
            </View>
            <Text style={{ ...text, flex: 1, minWidth: 200 }}>{r.value}</Text>
          </View>
        ))}
        <Text style={text}>A shared volume must hold the worktrees: the pod mounts the daemon's worktree volume at the same path.</Text>
      </Card>
      <Card
        theme={theme}
        title="Sandboxes"
        icon="Boxes"
        description="One pod per opted-in workspace, created on its first launch."
        badge={<Badge theme={theme} label={plural(p.pods?.length ?? 0, "pod")} />}
      >
        {(p.pods ?? []).slice(0, 5).map((pod) => (
          <Text key={pod.name} style={{ ...text, ...mono }}>
            {pod.name} · {pod.ready ? "Ready" : pod.phase} · {age(pod.createdAt)}
          </Text>
        ))}
        {!p.pods?.length && <Text style={text}>No sandbox pod yet. A pod appears when an opted-in workspace launches an agent, terminal or command.</Text>}
        <View style={{ alignSelf: "flex-start" }}>
          <Button theme={theme} label="Open Pods" icon="Cpu" onPress={() => p.go("pods")} />
        </View>
      </Card>
      <Card theme={theme} title="Good to know" icon="Info" description="Behaviour you should expect.">
        <Notice theme={theme} text={text}>If the plugin is disabled or removed, opted-in workspaces run on the daemon host again, silently.</Notice>
        <Notice theme={theme} text={text}>A shell started in a pod has no Paseo shell integration, so a paseo.json script run there does not report when its command finishes.</Notice>
        <Notice theme={theme} text={text}>The pod isolates CPU, memory and processes. It still shares the worktree volume with the daemon, so it is not a security boundary for that data.</Notice>
        <ExternalLink href={DOCS}>Setup guide</ExternalLink>
      </Card>
    </>
  );
}

export function ClusterTab(p: Common & { draft: Configuration; patch<K extends keyof Configuration>(k: K, v: Configuration[K]): void; status: ClusterStatus | null; onCheck(): void }) {
  const { theme, text, draft } = p;
  const failing = p.status?.checks.some((c) => c.status === "fail");
  return (
    <Card
      theme={theme}
      title="Cluster"
      icon="Server"
      description="Where sandbox pods run. Uses the kubectl of the Paseo daemon host."
      badge={p.status && <Badge theme={theme} label={failing ? "Needs attention" : "Ready"} tone={failing ? "warning" : "success"} />}
    >
      <Field theme={theme} label="Kubernetes context" value={draft.context} onChange={(v) => p.patch("context", v)} placeholder="Use current context" hint="Leave empty to use kubectl's current context." disabled={p.busy} />
      <Field theme={theme} label="Namespace" value={draft.namespace} onChange={(v) => p.patch("namespace", v)} hint="Must already exist. Apply config/plugin-rbac.yaml in it." disabled={p.busy} />
      {p.status && (
        <View style={{ gap: 10 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <Icon name="Network" size={15} color={theme.colors.foregroundMuted} />
            <Text style={text}>{p.status.context} · {p.status.namespace}</Text>
          </View>
          {p.status.checks.map((c) => (
            <View key={c.id} style={{ flexDirection: "row", gap: 10, alignItems: "flex-start" }}>
              <Icon name={c.status === "ok" ? "CircleCheck" : "CircleAlert"} size={18} color={c.status === "ok" ? theme.colors.statusSuccess : theme.colors.statusWarning} />
              <View style={{ flex: 1 }}>
                <Text style={{ ...text, color: theme.colors.foreground, fontWeight: "600" }}>{c.label}</Text>
                <Text style={text}>{c.detail}</Text>
              </View>
            </View>
          ))}
        </View>
      )}
      <Disclosure theme={theme} title="RBAC setup" summary="The Role the plugin needs">
        <Text style={text}>Apply the Role in your namespace and bind it to the identity kubectl uses on the daemon host:</Text>
        <View style={{ padding: 12, borderRadius: 8, backgroundColor: theme.colors.surface0 }}>
          <Text selectable style={{ ...text, ...mono }}>
            kubectl apply -n {draft.namespace} -f config/plugin-rbac.yaml{"\n"}
            kubectl create rolebinding paseo-kubernetes-sandbox -n {draft.namespace} --role=paseo-kubernetes-sandbox --user=YOU
          </Text>
        </View>
        <ExternalLink href={DOCS}>Full setup guide</ExternalLink>
      </Disclosure>
      <View style={{ flexDirection: "row", gap: 10, flexWrap: "wrap" }}>
        <Button theme={theme} label="Save changes" primary disabled={p.busy || !p.ready || p.saved} onPress={p.onSave} />
        <Button theme={theme} label="Check cluster" icon="RefreshCw" disabled={p.busy || !p.saved} onPress={p.onCheck} />
      </View>
      {!p.saved && <Text style={text}>Save your changes before checking the cluster.</Text>}
    </Card>
  );
}

export function WorkspacesTab(p: Common & { draft: Configuration; patch<K extends keyof Configuration>(k: K, v: Configuration[K]): void; rows: WorkspaceRows | null; onRefresh(): void }) {
  const { theme, text, draft } = p;
  const known = new Set(p.rows?.map((r) => r.id));
  const stale = draft.workspaces.filter((id) => p.rows && !known.has(id));
  return (
    <Card
      theme={theme}
      title="Workspaces"
      icon="FolderGit2"
      description="Pick the workspaces whose agents, terminals and commands run in a pod. The others keep running on the daemon host."
      badge={<Badge theme={theme} label={`${draft.workspaces.length} opted in`} />}
    >
      {p.rows === null && <Text style={text}>Loading workspaces…</Text>}
      {p.rows?.length === 0 && <Text style={text}>No workspace found.</Text>}
      {p.rows?.map((w) => (
        <Choice
          key={w.id}
          theme={theme}
          label={w.name || w.id}
          description={`${w.directory}${draft.workspaces.includes(w.id) ? ` · pod ${w.pod}` : ""}`}
          checked={draft.workspaces.includes(w.id)}
          onChange={(on) => p.patch("workspaces", toggleWorkspace(draft.workspaces, w.id, on))}
          disabled={p.busy}
        />
      ))}
      {stale.length > 0 && (
        <View style={{ alignSelf: "flex-start" }}>
          <Button theme={theme} label={`Forget ${plural(stale.length, "missing workspace")}`} disabled={p.busy} onPress={() => p.patch("workspaces", draft.workspaces.filter((id) => !stale.includes(id)))} />
        </View>
      )}
      <Notice theme={theme} text={text}>Changes apply to the next launch. Processes already running keep running where they started.</Notice>
      <View style={{ flexDirection: "row", gap: 10, flexWrap: "wrap" }}>
        <Button theme={theme} label="Save changes" primary disabled={p.busy || !p.ready || p.saved} onPress={p.onSave} />
        <Button theme={theme} label="Refresh" icon="RefreshCw" disabled={p.busy} onPress={p.onRefresh} />
      </View>
      {!p.saved && <Text style={text}>You have unsaved changes.</Text>}
    </Card>
  );
}

export function PodsTab(p: { theme: Theme; text: Body; busy: boolean; pods: PodRows | null; logs: { name: string; text: string } | null; deleting: string | null; setDeleting(n: string | null): void; onRefresh(): void; onDelete(n: string): void; onLogs(n: string): void }) {
  const { theme, text } = p;
  return (
    <Card
      theme={theme}
      title="Sandbox pods"
      icon="Cpu"
      description="Pods created by this plugin, one per workspace. They are removed when the workspace is archived or stays idle."
      badge={<Badge theme={theme} label={plural(p.pods?.length ?? 0, "pod")} />}
    >
      <View style={{ alignSelf: "flex-start" }}>
        <Button theme={theme} label="Refresh" icon="RefreshCw" disabled={p.busy} onPress={p.onRefresh} />
      </View>
      {p.pods?.length === 0 && <Text style={text}>No sandbox pod.</Text>}
      {p.pods?.map((pod) => (
        <View key={pod.name} style={{ gap: 10, paddingVertical: 10, borderTopWidth: 1, borderColor: theme.colors.border }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <Text style={{ ...text, ...mono, color: theme.colors.foreground, flex: 1, minWidth: 180 }}>{pod.name}</Text>
            <Badge theme={theme} label={pod.ready ? "Ready" : pod.phase} tone={phaseTone(pod.phase, pod.ready)} alignSelf="center" />
          </View>
          <Text style={text}>
            Workspace {pod.workspaceId || "unknown"} · age {age(pod.createdAt)} · last used {pod.lastUsed ? `${age(pod.lastUsed)} ago` : "unknown"}
          </Text>
          <View style={{ flexDirection: "row", gap: 10, flexWrap: "wrap" }}>
            <Button theme={theme} label="Logs" icon="ScrollText" disabled={p.busy} onPress={() => p.onLogs(pod.name)} />
            {p.deleting === pod.name ? (
              <>
                <Button theme={theme} label="Confirm delete" icon="Trash2" danger disabled={p.busy} onPress={() => p.onDelete(pod.name)} />
                <Button theme={theme} label="Cancel" onPress={() => p.setDeleting(null)} />
              </>
            ) : (
              <Button theme={theme} label="Delete" icon="Trash2" danger disabled={p.busy} onPress={() => p.setDeleting(pod.name)} />
            )}
          </View>
          {p.deleting === pod.name && <Text style={text}>Deleting stops everything running in this pod. It is recreated on the next launch.</Text>}
          {p.logs?.name === pod.name && (
            <View style={{ padding: 12, borderRadius: 8, backgroundColor: theme.colors.surface0 }}>
              <Text selectable style={{ ...text, ...mono }}>{p.logs.text || "No log output."}</Text>
            </View>
          )}
        </View>
      ))}
    </Card>
  );
}

export function SettingsTab(p: Common & { draft: Configuration; patch<K extends keyof Configuration>(k: K, v: Configuration[K]): void }) {
  const { theme, text, draft } = p;
  const r = draft.resources;
  const res = (key: keyof Configuration["resources"], label: string) => (
    <View style={{ flex: 1, minWidth: 160 }}>
      <Field theme={theme} label={label} value={r[key]} onChange={(v) => p.patch("resources", { ...r, [key]: v })} hint={resourceIssue(label, r[key]) ?? undefined} disabled={p.busy} />
    </View>
  );
  const wt = draft.worktree;
  return (
    <Card theme={theme} title="Settings" icon="SlidersHorizontal" description="How sandbox pods are built. Changes apply to pods created after saving.">
      <Field theme={theme} label="Image" value={draft.image} onChange={(v) => p.patch("image", v)} placeholder="registry.example.com/dev-tools:latest" hint="Needs a shell and every program agents and terminals will run (git, the agent CLI, build tools)." disabled={p.busy} />
      <View style={{ flexDirection: "row", gap: 12, flexWrap: "wrap" }}>
        {res("cpuRequest", "CPU request")}
        {res("cpuLimit", "CPU limit")}
      </View>
      <View style={{ flexDirection: "row", gap: 12, flexWrap: "wrap" }}>
        {res("memoryRequest", "Memory request")}
        {res("memoryLimit", "Memory limit")}
      </View>
      <Text style={{ ...text, color: theme.colors.foreground, fontWeight: "600" }}>Worktree volume</Text>
      <Field theme={theme} label="PersistentVolumeClaim" value={wt.claimName} onChange={(v) => p.patch("worktree", { ...wt, claimName: v })} hint="Holds the daemon's worktrees. It must be mountable by the pod (ReadWriteMany, or the same node)." disabled={p.busy} />
      <Field theme={theme} label="Mount path" value={wt.mountPath} onChange={(v) => p.patch("worktree", { ...wt, mountPath: v })} placeholder="/home/paseo/.paseo/worktrees" hint="Where the daemon sees the volume. The pod mounts it at the same absolute path." disabled={p.busy} />
      <Field theme={theme} label="Sub path" value={wt.subPath} onChange={(v) => p.patch("worktree", { ...wt, subPath: v })} placeholder="Optional" hint="Directory of the volume that the mount path maps to." disabled={p.busy} />
      <Field theme={theme} label="Idle timeout (minutes)" value={String(draft.ttlMinutes)} onChange={(v) => p.patch("ttlMinutes", Math.max(0, Math.min(10080, Math.floor(Number(v) || 0))))} hint="Delete a pod that ran nothing for this long. 0 keeps pods until the workspace is archived." disabled={p.busy} />
      <Field theme={theme} label="Environment Secret" value={draft.envSecret} onChange={(v) => p.patch("envSecret", v)} placeholder="Optional" hint="Name of a Secret in the namespace. Its keys become environment variables in the pod. Use it for credentials instead of environment variables forwarded by Paseo." disabled={p.busy} />
      <Choice theme={theme} label="Docker-in-Docker sidecar" description="Adds a privileged docker:dind container to each pod and sets DOCKER_HOST. Requires a namespace that allows privileged pods." checked={draft.dind} onChange={(v) => p.patch("dind", v)} disabled={p.busy} />
      <SaveBar theme={theme} text={text} busy={p.busy} saved={p.saved} ready={p.ready} onSave={p.onSave} />
    </Card>
  );
}
