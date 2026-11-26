#!/bin/sh
# Launch wrapper: runs "<command> [args...]" inside a sandbox pod through `kubectl exec`.
# Paseo starts it as `kube-exec.sh <options> -- <command> [args...]`.
#
#   --namespace NS   --pod POD   [--context CTX]   [--container NAME]   [--cwd DIR]
#   [--env NAME]...  names of local environment variables to forward into the pod
#   [--state-dir D]  per-pod directory for pid files (default /tmp/sbx)
#
# Local environment does not reach the pod, so forwarded variables travel as `env NAME=VALUE`
# arguments of kubectl: they are visible to local `ps` and in the pod. Put secrets in the pod's
# envSecret instead.
#
# The command is exec'd in the pod after its pid is recorded. When this launcher gets TERM, INT or
# HUP it kills the recorded process with a second `kubectl exec`. SIGKILL cannot be trapped: the
# remote process then lives until the pod is deleted.
set -u

kubectl_bin=${PASEO_SANDBOX_KUBECTL:-kubectl}
ctx=
ns=
pod=
container=main
cwd=
state=/tmp/sbx
env_names=

die() { echo "kube-exec: $*" >&2; exit 64; }

while [ $# -gt 0 ]; do
  case $1 in
    --context) [ $# -ge 2 ] || die "$1 needs a value"; ctx=$2; shift 2 ;;
    --namespace) [ $# -ge 2 ] || die "$1 needs a value"; ns=$2; shift 2 ;;
    --pod) [ $# -ge 2 ] || die "$1 needs a value"; pod=$2; shift 2 ;;
    --container) [ $# -ge 2 ] || die "$1 needs a value"; container=$2; shift 2 ;;
    --cwd) [ $# -ge 2 ] || die "$1 needs a value"; cwd=$2; shift 2 ;;
    --state-dir) [ $# -ge 2 ] || die "$1 needs a value"; state=$2; shift 2 ;;
    --env) [ $# -ge 2 ] || die "$1 needs a value"; env_names="$env_names $2"; shift 2 ;;
    --) shift; break ;;
    *) die "unknown option $1" ;;
  esac
done
[ -n "$ns" ] && [ -n "$pod" ] || die "--namespace and --pod are required"
[ $# -gt 0 ] || die "no command given"

# Forward the requested variables that are set locally.
set_any=
for name in $env_names; do
  case $name in
    ''|[0-9]*|*[!A-Za-z0-9_]*) die "invalid variable name $name" ;;
  esac
  eval "isset=\${$name+x}"
  if [ -n "$isset" ]; then
    eval "value=\$$name"
    set -- "$name=$value" "$@"
    set_any=1
  fi
done
[ -n "$set_any" ] && set -- env "$@"

id="$$.$(date +%s)"
pidfile="$state/pid.$id"

# $0=sbx $1=state dir $2=pidfile $3=cwd, the rest is the command.
remote='mkdir -p "$1" && echo $$ >"$2" || exit 126; d=$3; shift 3; if [ -n "$d" ]; then cd "$d" || exit 126; fi; exec "$@"'

tty_flags=-i
[ -t 0 ] && tty_flags="-i -t"

# Shared kubectl prefix as a function: positional parameters hold the command.
kc() {
  if [ -n "$ctx" ]; then "$kubectl_bin" --context "$ctx" "$@"; else "$kubectl_bin" "$@"; fi
}

# A background job gets /dev/null as stdin in some shells (dash) unless stdin is re-opened from
# another descriptor, so keep a copy of it on fd 3.
exec 3<&0
kc exec $tty_flags -n "$ns" "$pod" -c "$container" -- sh -c "$remote" sbx "$state" "$pidfile" "$cwd" "$@" <&3 3<&- &
child=$!

stopping=
stop() {
  stopping=1
  kill -TERM "$child" 2>/dev/null
  # Kill the remote process; best effort, bounded by kubectl's own timeouts.
  kc exec -n "$ns" "$pod" -c "$container" -- sh -c \
    'p=$(cat "$1" 2>/dev/null); if [ -n "$p" ]; then kill -TERM -- "-$p" 2>/dev/null || kill -TERM "$p" 2>/dev/null; fi; rm -f "$1"; touch "$2/last"' \
    sbx "$pidfile" "$state" >/dev/null 2>&1 </dev/null
}
trap 'stop' TERM INT HUP

wait "$child"
rc=$?
if [ -n "$stopping" ]; then
  # Interrupted: collect the child's real status once it is gone.
  wait "$child" 2>/dev/null
  exit 143
fi
# Normal end: drop the pid file and mark the pod as used, without delaying the exit.
kc exec -n "$ns" "$pod" -c "$container" -- sh -c 'rm -f "$1"; touch "$2/last"' sbx "$pidfile" "$state" \
  >/dev/null 2>&1 </dev/null &
exit "$rc"
