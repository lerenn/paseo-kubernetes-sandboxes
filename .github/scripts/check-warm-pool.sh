#!/usr/bin/env bash
set -euo pipefail

chart=charts/paseo-sandbox-controller
values=$1
dir=$(mktemp -d)
trap 'rm -rf -- "$dir"' EXIT
render() {
  helm template standard "$chart" -f "$values" "$@"
}

yq 'del(.controller.profiles.standard.warmPoolCount)' "$values" > "$dir/omitted-values"
helm template standard "$chart" -f "$dir/omitted-values" > "$dir/default"
render --is-upgrade --set controller.profiles.standard.warmPoolCount=2 > "$dir/upgrade"
render --is-upgrade --set controller.profiles.standard.warmPoolCount=0 > "$dir/disabled"
render --set-json 'controller.profiles.standard.warmPoolCount=1' \
  --set-json 'controller.profiles.standard.podSpec={"nodeSelector":{"pool":"standard"},"tolerations":[{"key":"team"}],"runtimeClassName":"sandbox","serviceAccountName":"workspace","volumes":[{"name":"credentials","secret":{"secretName":"workspace"}}],"imagePullSecrets":[{"name":"registry"}]}' \
  --set-json 'controller.profiles.standard.container.envFrom=[{"secretRef":{"name":"workspace"}}]' > "$dir/isolation"

warm='select(.kind == "Deployment" and .metadata.annotations."paseo.dev/profile" == "standard")'
test -z "$(yq "$warm" "$dir/default")"
cmp "$dir/default" "$dir/disabled"
test "$(yq "$warm | .spec.replicas" "$dir/upgrade")" = 2
yq 'select(.metadata.annotations."paseo.dev/profile" != "standard")' "$dir/upgrade" > "$dir/upgrade-base"
yq '.' "$dir/default" > "$dir/default-base"
cmp "$dir/default-base" "$dir/upgrade-base"
yq "$warm | .spec.template.spec" "$dir/isolation" > "$dir/pod"
yq -e '
  .automountServiceAccountToken == false and .nodeSelector.pool == "standard" and
  .tolerations[0].key == "team" and .runtimeClassName == "sandbox" and
  .imagePullSecrets[0].name == "registry" and
  .volumes == null and .serviceAccountName == null and .initContainers == null and
  (.containers | length) == 1 and
  .containers[0].image == "ghcr.io/your-org/paseo-sandbox:stable" and
  .containers[0].envFrom == null and .containers[0].volumeMounts == null and
  .containers[0].securityContext.privileged == false and
  .containers[0].securityContext.runAsNonRoot == true
' "$dir/pod" > /dev/null

docker='select(.kind == "Deployment" and .metadata.annotations."paseo.dev/profile" == "docker")'
scripts/helm-installation config/installation-values.example.yaml docker template docker "$chart" > "$dir/docker-default"
test -z "$(yq "$docker" "$dir/docker-default")"
scripts/helm-installation config/installation-values.example.yaml docker template docker "$chart" \
  --set controller.profiles.docker.warmPoolCount=1 > "$dir/docker-opt-in"
yq "$docker | .spec.template.spec" "$dir/docker-opt-in" > "$dir/docker-pod"
yq -e '
  (.containers | length) == 1 and
  .containers[0].securityContext.privileged == false and
  .containers[0].image == "ghcr.io/your-org/paseo-sandbox-with-docker-cli:stable"
' "$dir/docker-pod" > /dev/null

for invalid in -1 1.5 2147483648 true null '"1"'; do
  if render --set-json "controller.profiles.standard.warmPoolCount=$invalid" > "$dir/invalid" 2>&1; then
    echo "Unexpectedly accepted warmPoolCount=$invalid" >&2
    exit 1
  fi
  grep -Fq 'warmPoolCount must be an integer' "$dir/invalid"
done
