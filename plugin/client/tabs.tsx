import { Text, View } from "react-native";
import { ExternalLink, Icon } from "@getpaseo/plugin/client/ui";
import { z } from "zod";
import { Badge, Button, Card, Choice, Disclosure, Field, JsonField, type Theme } from "./components.js";
import type { clusterCheck, podsList, sshInfo, workspacesList } from "../shared/contracts.js";
import type { Configuration } from "../shared/settings.js";
import { modeOf, podOverridesSchema, sidecarNamesOf, sidecarProblems, sidecarSchema, type Mode } from "../shared/settings.js";
import { ADVANCED_FIELDS, DEFAULTS, INDICATORS, age, draftProblems, durationLabel, problemOf, phaseTone, plural, requirementRows, resourceIssue, setWorkspaceMode, setupSteps, toggleWorkspace, toggleWorkspaceSidecar } from "./view.js";

export type Body = { color: string; fontSize: number; lineHeight: number };
export type SshStatus = z.output<typeof sshInfo>;
export type ClusterStatus = z.output<typeof clusterCheck.output>;
export type PodRows = z.output<typeof podsList.output>["pods"];
export type WorkspaceRows = z.output<typeof workspacesList.output>["workspaces"];
export type TabId = "overview" | "cluster" | "workspaces" | "pods" | "settings";

const DOCS = "https://github.com/lerenn/paseo-kubernetes-sandboxes/blob/main/docs/setup.md";
const MODE_LABEL: Record<Mode, string> = { shared: "Shared worktree", clone: "Pod-local clone" };
const mono = { fontFamily: "monospace" } as const;

function Notice({ theme, text, children, danger = false }: { theme: Theme; text: Body; children: string; danger?: boolean }) {
  return (
    <View style={{ backgroundColor: theme.colors.surface2, borderRadius: 8, padding: 12 }}>
      <Text style={{ ...text, color: danger ? theme.colors.statusWarning : theme.colors.foregroundMuted }}>{children}</Text>
    </View>
  );
}

function SaveBar(p: { theme: Theme; text: Body; busy: boolean; saved: boolean; ready: boolean; problem: string | null; onSave(): void }) {
  return (
    <View style={{ gap: 10 }}>
      <View style={{ flexDirection: "row", gap: 10, flexWrap: "wrap" }}>
        <Button theme={p.theme} label={p.busy ? "Working…" : "Save changes"} primary disabled={p.busy || !p.ready || p.saved || !!p.problem} onPress={p.onSave} />
      </View>
      {p.problem && (
        <Text accessibilityRole="alert" style={{ ...p.text, color: p.theme.colors.statusDanger }}>
          Cannot save yet: {p.problem}
        </Text>
      )}
      {!p.saved && <Text style={p.text}>You have unsaved changes.</Text>}
    </View>
  );
}

// `problem`: the first thing preventing a save (null when the draft is valid).
type Common = { theme: Theme; text: Body; busy: boolean; saved: boolean; ready: boolean; problem: string | null; onSave(): void };

export function OverviewTab(p: Common & { saved_: Configuration; status: ClusterStatus | null; pods: PodRows | null; go(tab: TabId): void }) {
  const { theme, text } = p;
  const steps = setupSteps(p.saved_, p.status?.checks ?? null);
  const requirements = requirementRows(p.saved_, p.status?.checks ?? null);
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
      {p.saved_.workspaces.length > 0 && (
        <Card theme={theme} title="Opted-in workspaces" icon="FolderGit2" description="Storage mode of each workspace that runs in a pod.">
          {p.saved_.workspaces.map((w) => (
            <Text key={w.id} style={{ ...text, ...mono }}>
              {w.id} · {MODE_LABEL[modeOf(p.saved_, w.id)]}
            </Text>
          ))}
        </Card>
      )}
      <Card theme={theme} title="Requirements" icon="ClipboardCheck" description="What the daemon host needs.">
        {requirements.map((r) => {
          const ind = INDICATORS[r.indicator];
          const color = ind.color === "success" ? theme.colors.statusSuccess : ind.color === "danger" ? theme.colors.statusDanger : theme.colors.foregroundMuted;
          return (
            <View key={r.id} style={{ flexDirection: "row", alignItems: "flex-start", gap: 12, paddingVertical: 4 }}>
              <View accessible accessibilityRole="image" accessibilityLabel={ind.label} style={{ paddingTop: 1 }}>
                <Icon name={ind.icon} size={18} color={color} />
              </View>
              <View style={{ flex: 1, minWidth: 180, gap: 2 }}>
                <Text style={{ ...text, color: theme.colors.foreground, fontWeight: "600" }}>{r.label}</Text>
                <Text style={text}>{r.description}</Text>
                <Text style={{ ...text, color: r.indicator === "failed" ? theme.colors.statusDanger : theme.colors.foregroundMuted }}>{r.detail}</Text>
              </View>
            </View>
          );
        })}
        <Text style={text}>Shared worktree mode needs the daemon's worktree volume (and the repositories' .git directories) mountable by the pods. For private repositories, use Git over SSH (Cluster tab), which the plugin keeps in one managed Secret, or a Git Secret you create yourself (Settings) for HTTPS or other git configuration.</Text>
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
            {pod.name} · {MODE_LABEL[pod.mode]} · {pod.ready ? "Ready" : pod.phase} · {age(pod.createdAt)}
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
        <Notice theme={theme} text={text}>Resource and process isolation, not a security boundary. In shared mode the pod can read and write the whole repository (all branches, history, config, hooks).</Notice>
        <ExternalLink href={DOCS}>Setup guide</ExternalLink>
      </Card>
    </>
  );
}

export function ClusterTab(p: Common & { contexts: string[] | null; onContexts(): void; draft: Configuration; patch<K extends keyof Configuration>(k: K, v: Configuration[K]): void; status: ClusterStatus | null; onCheck(): void; ssh: SshStatus | null; onSshRefresh(): void; onSshSync(): void; onSshRemove(): void }) {
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
      <Field theme={theme} label="Kubeconfig file" value={draft.kubeconfigFile} onChange={(v) => p.patch("kubeconfigFile", v)} placeholder="Optional, absolute path on the daemon host" error={problemOf(draftProblems(draft), "kubeconfigFile")} hint="A narrow identity limited to the sandbox namespace is best; the file is read on the daemon host (by kubectl, never by the plugin). Default: empty, kubectl's own configuration (KUBECONFIG, ~/.kube/config or the in-cluster identity)." disabled={p.busy} />
      <Field theme={theme} label="Kubernetes context" value={draft.context} onChange={(v) => p.patch("context", v)} placeholder="Use current context" hint="Leave empty to use the current context of the kubeconfig." disabled={p.busy} />
      <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <Button theme={theme} label="List contexts of the saved kubeconfig" icon="List" disabled={p.busy || !p.saved} onPress={p.onContexts} />
        {p.contexts?.map((name) => (
          <Button key={name} theme={theme} label={name} primary={draft.context === name} disabled={p.busy} onPress={() => p.patch("context", name)} />
        ))}
        {p.contexts && !p.contexts.length && <Text style={text}>No context found: the file is missing, unreadable or empty.</Text>}
      </View>
      <Field theme={theme} label="Namespace" value={draft.namespace} onChange={(v) => p.patch("namespace", v)} hint="Must already exist. Apply config/plugin-rbac.yaml in it." disabled={p.busy} />
      {p.status && (
        <View style={{ gap: 10 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <Icon name="Network" size={15} color={theme.colors.foregroundMuted} />
            <Text style={text}>{p.status.context} · {p.status.namespace}{p.status.kubeconfigFile ? ` · kubeconfig ${p.status.kubeconfigFile}` : ""}</Text>
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
      <Text style={{ ...text, color: theme.colors.foreground, fontWeight: "600" }}>Git over SSH</Text>
      <Field theme={theme} label="SSH key file" value={draft.ssh.keyFile} onChange={(v) => p.patch("ssh", { ...draft.ssh, keyFile: v })} placeholder="Optional, absolute path on the daemon host" hint="A DEDICATED deploy key or machine-user key, never a personal key. The plugin copies it into one Secret in the namespace." disabled={p.busy} />
      <Field theme={theme} label="known_hosts file" value={draft.ssh.knownHostsFile} onChange={(v) => p.patch("ssh", { ...draft.ssh, knownHostsFile: v })} placeholder="Absolute path on the daemon host" hint="Pins the git hosts' keys (for example github.com). Required with a key; host keys are never fetched automatically." disabled={p.busy} />
      <Notice theme={theme} text={text} danger>The key is readable by every process in the pod, and by anyone who can read Secrets in the namespace or use the daemon's cluster identity. Use a deploy key limited to the repositories agents work on.</Notice>
      {p.ssh && (
        <Text style={text}>
          {!p.ssh.configured ? "Not configured." : p.ssh.problem ?? (p.ssh.present ? `Secret present · ${p.ssh.hashPrefix} · ${p.ssh.inSync ? "matches the files" : "differs from the files (sync it)"} · synced ${p.ssh.syncedAt ?? "unknown"}` : "Secret absent. It is created with the next pod, or press Sync.")}
          {!p.ssh.configured && p.ssh.present ? ` A Secret (${p.ssh.hashPrefix}) is still in the namespace: remove it.` : ""}
        </Text>
      )}
      <View style={{ flexDirection: "row", gap: 10, flexWrap: "wrap" }}>
        <Button theme={theme} label="SSH status" icon="RefreshCw" disabled={p.busy || !p.saved} onPress={p.onSshRefresh} />
        <Button theme={theme} label="Sync Secret" disabled={p.busy || !p.saved || !draft.ssh.keyFile} onPress={p.onSshSync} />
        <Button theme={theme} label="Remove Secret" icon="Trash2" disabled={p.busy || !p.saved} onPress={p.onSshRemove} />
      </View>
      <Disclosure theme={theme} title="RBAC setup" summary="The Role the plugin needs">
        <Text style={text}>Apply the Role in your namespace and bind it to the identity kubectl uses on the daemon host:</Text>
        <View style={{ padding: 12, borderRadius: 8, backgroundColor: theme.colors.surface0 }}>
          <Text selectable style={{ ...text, ...mono }}>
            kubectl apply -n {draft.namespace} -f config/plugin-rbac.yaml{"\n"}
            kubectl create rolebinding paseo-sandboxes -n {draft.namespace} --role=paseo-sandboxes --user=YOU
          </Text>
        </View>
        <ExternalLink href={DOCS}>Full setup guide</ExternalLink>
      </Disclosure>
      <View style={{ flexDirection: "row", gap: 10, flexWrap: "wrap" }}>
        <Button theme={theme} label="Save changes" primary disabled={p.busy || !p.ready || p.saved || !!p.problem} onPress={p.onSave} />
        <Button theme={theme} label="Check cluster" icon="RefreshCw" disabled={p.busy || !p.saved} onPress={p.onCheck} />
      </View>
      {!p.saved && <Text style={text}>Save your changes before checking the cluster.</Text>}
    </Card>
  );
}

export function WorkspacesTab(p: Common & { draft: Configuration; patch<K extends keyof Configuration>(k: K, v: Configuration[K]): void; rows: WorkspaceRows | null; onRefresh(): void }) {
  const { theme, text, draft } = p;
  const known = new Set(p.rows?.map((r) => r.id));
  const stale = draft.workspaces.filter((w) => p.rows && !known.has(w.id));
  const entry = (id: string) => draft.workspaces.find((w) => w.id === id);
  return (
    <Card
      theme={theme}
      title="Workspaces"
      icon="FolderGit2"
      description="Pick the workspaces whose agents, terminals and commands run in a pod, and how each one stores its files. The others keep running on the daemon host."
      badge={<Badge theme={theme} label={`${draft.workspaces.length} opted in`} />}
    >
      {p.rows === null && <Text style={text}>Loading workspaces…</Text>}
      {p.rows?.length === 0 && <Text style={text}>No workspace found.</Text>}
      {p.rows?.map((w) => {
        const e = entry(w.id);
        const mode = modeOf(draft, w.id);
        return (
          <View key={w.id} style={{ gap: 4 }}>
            <Choice
              theme={theme}
              label={w.name || w.id}
              description={`${w.directory}${e ? ` · ${MODE_LABEL[mode]} · pod ${w.pod}` : ""}`}
              checked={!!e}
              onChange={(on) => p.patch("workspaces", toggleWorkspace(draft.workspaces, w.id, on))}
              disabled={p.busy}
            />
            {e && (
              <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap", paddingLeft: 31 }}>
                {(["shared", "clone"] as const).map((m) => (
                  <Button key={m} theme={theme} label={MODE_LABEL[m]} primary={mode === m} disabled={p.busy} onPress={() => p.patch("workspaces", setWorkspaceMode(draft.workspaces, w.id, m === draft.defaultMode ? undefined : m))} />
                ))}
                {draft.sidecars.map((s) => {
                  const current = sidecarNamesOf(draft, w.id);
                  const on = current.includes(s.name);
                  return <Button key={s.name} theme={theme} label={`Sidecar ${s.name}: ${on ? "on" : "off"}`} primary={on} disabled={p.busy} onPress={() => p.patch("workspaces", toggleWorkspaceSidecar(draft.workspaces, w.id, current, s.name, !on))} />;
                })}
              </View>
            )}
          </View>
        );
      })}
      {stale.length > 0 && (
        <View style={{ alignSelf: "flex-start" }}>
          <Button theme={theme} label={`Forget ${plural(stale.length, "missing workspace")}`} disabled={p.busy} onPress={() => p.patch("workspaces", draft.workspaces.filter((w) => !stale.includes(w)))} />
        </View>
      )}
      <Notice theme={theme} text={text}>Shared worktree: the pod works on the daemon's files. Pod-local clone: the pod works on its own clone; Paseo's file tree, diffs and git status do not show it, and unpushed work is lost with the pod unless a volume is used. Sidecars follow the default selection until toggled here. Switching mode needs the pod deleted first. Changes apply to the next launch.</Notice>
      <View style={{ flexDirection: "row", gap: 10, flexWrap: "wrap" }}>
        <Button theme={theme} label="Save changes" primary disabled={p.busy || !p.ready || p.saved || !!p.problem} onPress={p.onSave} />
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
            {MODE_LABEL[pod.mode]} · workspace {pod.workspaceId || "unknown"} · age {age(pod.createdAt)} · last used {pod.lastUsed ? `${age(pod.lastUsed)} ago` : "unknown"}
          </Text>
          {pod.sidecars.length > 0 && (
            <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
              {pod.sidecars.map((s) => (
                <Badge key={s.name} theme={theme} label={`${s.name}: ${s.ready ? "Ready" : "Not ready"}`} tone={s.ready ? "success" : "warning"} />
              ))}
            </View>
          )}
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
  const D = DEFAULTS;
  const problems = draftProblems(draft);
  const err = (field: string) => problemOf(problems, field);
  const r = draft.resources;
  const wt = draft.worktree;
  const rp = draft.repo;
  const cl = draft.clone;
  const title = { ...text, color: theme.colors.foreground, fontWeight: "600" as const };
  const res = (key: keyof Configuration["resources"], label: string, what: string) => (
    <View style={{ flex: 1, minWidth: 220 }}>
      <Field theme={theme} label={label} value={r[key]} onChange={(v) => p.patch("resources", { ...r, [key]: v })} placeholder={D.resources[key]} error={err(`resources.${key}`)} hint={`${what} Default: ${D.resources[key]}. Empty is not allowed.`} disabled={p.busy} />
    </View>
  );
  const advancedProblems = problems.filter((x) => ADVANCED_FIELDS.includes(x.field));
  return (
    <>
      <Card theme={theme} title="Image and resources" icon="Cpu" description="The container image of every sandbox pod and how much CPU and memory it may use. Changes apply to pods created after saving.">
        <Field theme={theme} label="Image" value={draft.image} onChange={(v) => p.patch("image", v)} placeholder="registry.example.com/dev-tools:latest" hint="The container image the pod runs. It needs a shell and every program agents and terminals will run (git, the agent CLI, build tools). Default: none; while empty, no pod can start." disabled={p.busy} />
        <Text style={title}>CPU</Text>
        <View style={{ flexDirection: "row", gap: 12, flexWrap: "wrap" }}>
          {res("cpuRequest", "CPU request", "CPU the cluster reserves for the pod. Example: 250m (a quarter core).")}
          {res("cpuLimit", "CPU limit", "The most CPU the pod may use. Example: 2.")}
        </View>
        <Text style={title}>Memory</Text>
        <View style={{ flexDirection: "row", gap: 12, flexWrap: "wrap" }}>
          {res("memoryRequest", "Memory request", "Memory the cluster reserves. Example: 512Mi.")}
          {res("memoryLimit", "Memory limit", "The pod is killed above this. Example: 4Gi.")}
        </View>
      </Card>
      <Card theme={theme} title="Storage" icon="HardDrive" description="Where a sandbox finds the code. Each workspace can override the default mode on the Workspaces tab.">
        <Text style={title}>Default storage mode</Text>
        <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
          {(["shared", "clone"] as const).map((m) => (
            <Button key={m} theme={theme} label={`${MODE_LABEL[m]}${m === D.defaultMode ? " (default)" : ""}`} primary={draft.defaultMode === m} disabled={p.busy} onPress={() => p.patch("defaultMode", m)} />
          ))}
        </View>
        <Text style={text}>Shared worktree: the pod mounts the daemon's worktree volume, so files are the same as on the daemon. Pod-local clone: the pod clones the repository into its own storage (see Advanced).</Text>
        <Text style={title}>Worktree volume (Shared worktree mode)</Text>
        <Field theme={theme} label="Worktree claim" value={wt.claimName} onChange={(v) => p.patch("worktree", { ...wt, claimName: v })} placeholder="paseo-worktrees" error={err("worktree.claimName")} hint="Name of the PersistentVolumeClaim, in the sandbox namespace, that holds the daemon's worktrees (ReadWriteMany, or one node for ReadWriteOnce). Default: none; Shared worktree mode needs it." disabled={p.busy} />
        <Field theme={theme} label="Worktree mount path" value={wt.basePath} onChange={(v) => p.patch("worktree", { ...wt, basePath: v })} placeholder="/home/paseo/.paseo/worktrees" error={err("worktree.basePath")} hint="The absolute path where the daemon sees that volume. The pod mounts each workspace's folder at its own path under it. Default: none; Shared worktree mode needs it." disabled={p.busy} />
        <Field theme={theme} label="Worktree sub path" value={wt.subPath} onChange={(v) => p.patch("worktree", { ...wt, subPath: v })} placeholder="Optional, for example worktrees" hint="Directory of the claim that the mount path maps to. Default: empty, the root of the claim." disabled={p.busy} />
        <Field theme={theme} label="Repository base path" value={rp.basePath} onChange={(v) => p.patch("repo", { ...rp, basePath: v })} placeholder="/workspace/src" error={err("repo.basePath")} hint="The absolute path where the daemon sees the main repositories. The pod mounts only each repository's .git directory from there. Default: empty." disabled={p.busy} />
        <Notice theme={theme} text={text} danger>In shared mode the pod can read and write the whole repository: all branches and history, the repository config (remotes, possibly credentials), other worktrees' metadata and .git/hooks. Do not store credentials in the repository config.</Notice>
      </Card>
      <Card theme={theme} title="Advanced" icon="Wrench" description="Rarely needed. Every field has a working default.">
        <Disclosure theme={theme} title="Show advanced settings" label="Advanced settings" summary={advancedProblems.length ? `${plural(advancedProblems.length, "problem")} inside: ${advancedProblems[0].message}` : "Cleanup, run-as user, Secrets, pod-local clone, repository volume, sidecars, pod overrides."}>
          <Text style={title}>Cleanup</Text>
          <Field theme={theme} label="Idle timeout (minutes)" value={String(draft.ttlMinutes)} onChange={(v) => p.patch("ttlMinutes", Math.max(0, Math.min(10080, Math.floor(Number(v) || 0))))} placeholder={String(D.ttlMinutes)} hint={`Delete a pod that ran nothing for this long (0 to 10080). Example: 60. Default: ${durationLabel(D.ttlMinutes)}. 0 keeps pods until the workspace is archived.`} disabled={p.busy} />
          <Text style={title}>Identity</Text>
          <Field theme={theme} label="Run as user ID" value={String(draft.runAsUser)} onChange={(v) => p.patch("runAsUser", Math.max(0, Math.min(65535, Math.floor(Number(v) || 0))))} placeholder={String(D.runAsUser)} hint={`The numeric user the pod runs as. Match the owner of the daemon's files. Default: ${D.runAsUser}. 0 keeps the image's own user.`} disabled={p.busy} />
          <Text style={title}>Credentials</Text>
          <Field theme={theme} label="Environment Secret" value={draft.envSecret} onChange={(v) => p.patch("envSecret", v)} placeholder="my-agent-env" error={err("envSecret")} hint="Name of a Secret in the sandbox namespace. Each key becomes an environment variable in the pod; use it for credentials instead of variables forwarded by Paseo. Default: empty, no Secret." disabled={p.busy} />
          <Text style={text}>Git over SSH (key file and known_hosts) is on the Cluster tab.</Text>
          <Text style={title}>Pod-local clone</Text>
          <Text style={text}>Used by workspaces in Pod-local clone mode.</Text>
          <Field theme={theme} label="Clone path" value={cl.path} onChange={(v) => p.patch("clone", { ...cl, path: v })} placeholder={D.clone.path} error={err("clone.path")} hint={`Absolute path in the pod where the repository is cloned; launches start here. Default: ${D.clone.path}.`} disabled={p.busy} />
          <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
            {(["emptyDir", "pvc"] as const).map((m) => (
              <Button key={m} theme={theme} label={`${m === "pvc" ? "Per-sandbox volume" : "Pod storage (lost with the pod)"}${m === D.clone.storage ? " (default)" : ""}`} primary={cl.storage === m} disabled={p.busy} onPress={() => p.patch("clone", { ...cl, storage: m })} />
            ))}
          </View>
          {cl.storage === "pvc" && (
            <>
              <Field theme={theme} label="Volume size" value={cl.size} onChange={(v) => p.patch("clone", { ...cl, size: v })} placeholder={D.clone.size} error={err("clone.size")} hint={`Size of the per-sandbox volume. Kept when the pod is deleted; removed when the workspace is archived. Default: ${D.clone.size}.`} disabled={p.busy} />
              <Field theme={theme} label="Storage class" value={cl.storageClass} onChange={(v) => p.patch("clone", { ...cl, storageClass: v })} placeholder="Cluster default" hint="Default: empty, the cluster's default storage class." disabled={p.busy} />
            </>
          )}
          <Field theme={theme} label="Git Secret" value={cl.gitSecret} onChange={(v) => p.patch("clone", { ...cl, gitSecret: v })} placeholder="my-git-config" error={err("clone.gitSecret")} hint="Name of a Secret you manage, mounted at /etc/sandbox-git; its gitconfig key becomes the global git config (for example a credential helper for HTTPS). Default: empty, none. For SSH, use Git over SSH on the Cluster tab." disabled={p.busy} />
          <Notice theme={theme} text={text}>Pod-local clone: Paseo's file tree, diffs and git status read the daemon's disk and do not show what agents did in the pod. Results come back through git (commit, push, PR). Deleting the pod loses unpushed work unless a per-sandbox volume is used.</Notice>
          <Text style={title}>Repository volume</Text>
          <Field theme={theme} label="Repository claim" value={rp.claimName} onChange={(v) => p.patch("repo", { ...rp, claimName: v })} placeholder="Same as the worktree claim" error={err("repo.claimName")} hint="Only if the main repositories are on a different PersistentVolumeClaim than the worktrees. Default: empty, the worktree claim is reused." disabled={p.busy} />
          <Field theme={theme} label="Repository sub path" value={rp.subPath} onChange={(v) => p.patch("repo", { ...rp, subPath: v })} placeholder="Optional" hint="Directory of the repository claim that the repository base path maps to. Default: empty." disabled={p.busy} />
          <Text style={title}>Sidecars</Text>
          <JsonField theme={theme} label="Sidecar templates (JSON)" value={draft.sidecars} disabled={p.busy} hint="A list of extra containers (for example docker). Default: [] (none). See docs/setup.md, Sidecars. Applies to pods created afterwards." check={(v) => { const r = z.array(sidecarSchema).max(8).safeParse(v); return r.success ? sidecarProblems({ sidecars: r.data, defaultSidecars: [], workspaces: [] }) : r.error.issues[0]?.message ?? "Invalid sidecars."; }} onChange={(v) => p.patch("sidecars", z.array(sidecarSchema).parse(v))} />
          {err("sidecars") && <Text style={{ ...text, color: theme.colors.statusDanger }} accessibilityRole="alert">{err("sidecars")}</Text>}
          {draft.sidecars.map((s) => (
            <Choice key={s.name} theme={theme} label={`Sidecar ${s.name} by default`} description="Enabled for opted-in workspaces that do not choose their own sidecars (Workspaces tab). Default: off." checked={draft.defaultSidecars.includes(s.name)} onChange={(on) => p.patch("defaultSidecars", on ? [...draft.defaultSidecars, s.name] : draft.defaultSidecars.filter((n) => n !== s.name))} disabled={p.busy} />
          ))}
          <Notice theme={theme} text={text} danger>A privileged sidecar is root-equivalent on the node: weaker isolation than the base pod. The namespace's Pod Security level must allow it.</Notice>
          <Text style={title}>Pod overrides</Text>
          <JsonField theme={theme} label="Pod overrides (JSON)" value={draft.podOverrides} disabled={p.busy} hint="Only runtimeClassName, tolerations, nodeSelector, priorityClassName and imagePullSecrets, applied to every sandbox pod. Default: none set." check={(v) => { const r = podOverridesSchema.safeParse(v); return r.success ? null : r.error.issues[0]?.message ?? "Invalid pod overrides."; }} onChange={(v) => p.patch("podOverrides", podOverridesSchema.parse(v))} />
        </Disclosure>
      </Card>
      <SaveBar theme={theme} text={text} busy={p.busy} saved={p.saved} ready={p.ready} problem={p.problem} onSave={p.onSave} />
    </>
  );
}
