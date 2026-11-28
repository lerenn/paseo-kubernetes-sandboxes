import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { useSelectedExecution } from "../client/use-selected-execution.js";
import { executionProfiles } from "../shared/execution.js";

test("mount restores the normalized label from profile discovery without changing the saved route", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const saved = { connectionId: "gateway", profile: "docker", privileged: true };
  const profiles = executionProfiles([
    { id: "standard", label: "K8s", privileged: false },
    { id: "docker", label: "K8s + Docker (privileged)", privileged: true },
  ]);
  let finish!: (options: { connectionId: string; profiles: typeof profiles; localAllowed: boolean }) => void;
  const pending = new Promise<Parameters<typeof finish>[0]>((resolve) => { finish = resolve; });
  const load = () => pending;
  function Picker({ host, discover = load, selection = saved }: {
    host: string; discover?: typeof load; selection?: typeof saved;
  }) {
    const { value } = useSelectedExecution(host, selection, discover);
    return createElement("output", null, value?.label);
  }

  let view!: ReactTestRenderer;
  await act(async () => { view = create(createElement(Picker, { host: "lab" })); });
  assert.equal(view.root.findByType("output").children[0], "Docker");
  await act(async () => { finish({ connectionId: "gateway", profiles, localAllowed: true }); });
  assert.equal(view.root.findByType("output").children[0], "K8s + Docker");

  await act(async () => {
    view.update(createElement(Picker, { host: "lab", selection: { ...saved, profile: "standard", privileged: false } }));
  });
  assert.equal(view.root.findByType("output").children[0], "K8s");

  const otherConnection = async () => ({ connectionId: "other", profiles, localAllowed: true });
  await act(async () => { view.update(createElement(Picker, { host: "other", discover: otherConnection })); });
  assert.equal(view.root.findByType("output").children[0], "Docker");
  assert.deepEqual(saved, { connectionId: "gateway", profile: "docker", privileged: true });
  await act(async () => { view.unmount(); });
});
