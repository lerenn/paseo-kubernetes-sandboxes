import type { PluginClientContext, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { SandboxScreen } from "./client/screen.js";

function Sidebar(props: PluginSidebarItemProps) {
  return (
    <SidebarRow
      icon="Boxes"
      label="Kubernetes Sandbox"
      active={props.currentScreen?.screenId === "sandbox"}
      onPress={() => props.openScreen({ screenId: "sandbox" })}
    />
  );
}

export default function contribute(client: PluginClientContext) {
  const screen = client.addScreen({ id: "sandbox", title: "Kubernetes Sandbox", Component: SandboxScreen });
  const sidebar = client.addSidebarHeaderItem({ id: "sandbox", title: "Kubernetes Sandbox", Component: Sidebar });
  return () => {
    sidebar();
    screen();
  };
}
