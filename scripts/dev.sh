#!/usr/bin/env bash
# Development helper. Everything runs inside podman containers:
#   - a Dovecot container as a throw-away IMAP server (any user name, password: secret)
#   - a Node.js container with this repository mounted at /app
#
# Usage:
#   scripts/dev.sh test        install deps, type-check and run the tests
#   scripts/dev.sh npm <args>  run any npm command in the Node container
#   scripts/dev.sh shell       open a shell in the Node container
#   scripts/dev.sh down        remove the pod (and with it all test mail)
set -euo pipefail

POD=pi-imap-dev
NODE_IMAGE=docker.io/library/node:24-bookworm-slim
MAIL_IMAGE=docker.io/dovecot/dovecot:2.4.2
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

start_pod() {
	if ! podman pod exists "$POD"; then
		podman pod create --name "$POD" >/dev/null
		podman run -d --pod "$POD" --name "$POD-mail" -e USER_PASSWORD=secret "$MAIL_IMAGE" >/dev/null
		sleep 2 # give Dovecot a moment to start listening
	fi
}

run_node() {
	podman run --rm -i --pod "$POD" -v "$ROOT:/app:Z" -w /app \
		-e IMAP_HOST=localhost -e IMAP_PORT=31143 -e IMAP_SECURE=false \
		-e IMAP_TLS_REJECT_UNAUTHORIZED=false \
		-e IMAP_USER=test -e IMAP_PASSWORD=secret \
		"$NODE_IMAGE" "$@"
}

case "${1:-test}" in
test)
	start_pod
	run_node sh -c "npm ci && npm run check && npm test"
	;;
npm)
	shift
	start_pod
	run_node npm "$@"
	;;
shell)
	start_pod
	podman run --rm -it --pod "$POD" -v "$ROOT:/app:Z" -w /app "$NODE_IMAGE" bash
	;;
down)
	podman pod rm -f "$POD" >/dev/null 2>&1 || true
	;;
*)
	sed -n '2,11p' "$0"
	exit 1
	;;
esac
