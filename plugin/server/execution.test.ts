import assert from "node:assert/strict";
import { test } from "node:test";
import { sandboxProfile } from "../shared/contracts.js";
import { executionProfiles } from "../shared/execution.js";

test("Execution uses each backend's cluster display name and preserves privilege", () => {
  const profiles = [
    { id: "standard", label: "Standard", privileged: false, clusterDisplayName: "Standard Lab" },
    { id: "docker", label: "Docker (privileged)", privileged: true, clusterDisplayName: "Docker Lab" },
  ].map((profile) => sandboxProfile.parse(profile));
  assert.deepEqual(executionProfiles(profiles), [
    { id: "standard", label: "Standard", privileged: false, description: "Runs on Standard Lab Kubernetes cluster" },
    { id: "docker", label: "Docker", privileged: true, description: "Runs on Docker Lab Kubernetes cluster" },
  ]);
  assert.equal(profiles[1].label, "Docker (privileged)");
});

test("Execution falls back to generic copy with older Gateways or invalid display metadata", () => {
  for (const clusterDisplayName of [undefined, "https://private.example.test"]) {
    const profile = sandboxProfile.parse({ id: "standard", label: "Standard", privileged: false, clusterDisplayName });
    assert.equal(executionProfiles([profile])[0].description, "Runs on a Kubernetes cluster");
  }
});
