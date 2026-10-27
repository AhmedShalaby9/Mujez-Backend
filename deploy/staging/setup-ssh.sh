#!/usr/bin/env bash
set -euo pipefail
umask 077
: "${SSH_HOST:?SSH_HOST secret is missing}"
: "${SSH_USER:?SSH_USER secret is missing}"
: "${SSH_PRIVATE_KEY:?SSH_PRIVATE_KEY secret is missing}"
: "${SSH_KNOWN_HOSTS:?SSH_KNOWN_HOSTS secret is missing}"
SSH_PORT=${SSH_PORT:-22}
[[ "$SSH_HOST" =~ ^[a-zA-Z0-9][a-zA-Z0-9.-]*$ ]] || exit 2
[[ "$SSH_USER" =~ ^[a-zA-Z0-9_-]+$ ]] || exit 2
[[ "$SSH_PORT" =~ ^[0-9]+$ ]] && (( SSH_PORT > 0 && SSH_PORT < 65536 )) || exit 2
install -d -m 700 "$HOME/.ssh"
printf '%s\n' "$SSH_PRIVATE_KEY" > "$HOME/.ssh/staging_key"
printf '%s\n' "$SSH_KNOWN_HOSTS" > "$HOME/.ssh/staging_known_hosts"
cat > "$HOME/.ssh/config" <<EOF
Host staging-actions
    HostName $SSH_HOST
    User $SSH_USER
    Port $SSH_PORT
    IdentityFile ~/.ssh/staging_key
    UserKnownHostsFile ~/.ssh/staging_known_hosts
    IdentitiesOnly yes
    BatchMode yes
    StrictHostKeyChecking yes
    ConnectTimeout 15
    ServerAliveInterval 30
    ServerAliveCountMax 10
EOF
chmod 600 "$HOME/.ssh/config" "$HOME/.ssh/staging_key" "$HOME/.ssh/staging_known_hosts"
ssh staging-actions 'true'
