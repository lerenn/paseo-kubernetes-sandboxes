import assert from "node:assert/strict";
import { test } from "node:test";
import { isAuthorizationDenial, KubernetesError, sandboxOperationError } from "./kubernetes.mjs";

test("pod authorization and admission failures are actionable without exposing API server details", () => {
  const forbidden = (message) => JSON.stringify({ kind: "Status", reason: "Forbidden", message });
  const rbac = forbidden('pods "private-pod" is forbidden: User "private-user" cannot create resource "pods" in API group "" in the namespace "private-namespace"');
  const admission = forbidden('pods "private-pod" is forbidden: denied by private-policy');
  assert.ok(isAuthorizationDenial(rbac));
  assert.equal(isAuthorizationDenial(admission), false);
  assert.equal(isAuthorizationDenial("malformed"), false);
  const permission = sandboxOperationError(new KubernetesError("POST", 403, isAuthorizationDenial(rbac)));
  const rejected = sandboxOperationError(new KubernetesError("POST", 403, isAuthorizationDenial(admission)));
  assert.equal(permission.status, 403);
  assert.match(permission.error, /Role and RoleBinding/);
  assert.equal(rejected.status, 403);
  assert.match(rejected.error, /admission policy/);
  assert.equal(sandboxOperationError(new KubernetesError("POST", 422)).status, 422);
  assert.equal(sandboxOperationError(new KubernetesError("GET", 500)).status, 503);
  assert.doesNotMatch(JSON.stringify([permission, rejected]), /private-/);
});
