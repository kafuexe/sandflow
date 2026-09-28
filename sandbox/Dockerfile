# Sandflow sandbox image — what AI blocks run in when Settings → Sandbox is Docker or Podman.
#
# Built by CI for linux/amd64 and linux/arm64 and published with each release as an offline bundle
# (`docker save`), so air-gapped machines never pull anything. It deliberately contains NO agent CLI:
# Claude Code (or another agent) is supplied by you as a host folder that Sandflow mounts read-only at
# /opt/sandflow/tools (Settings → Agent tools folder), which is on PATH.
#
# Works with any container UID (sandcastle runs it as your host UID so bind-mounted files keep their owner).

FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends git curl jq ca-certificates openssh-client procps less \
  && rm -rf /var/lib/apt/lists/*

# Home + workspace writable by whatever UID the container runs as.
RUN mkdir -p /home/agent/workspace /home/agent/.claude/skills /opt/sandflow/tools \
  && chmod -R a+rwX /home/agent \
  && git config --system --add safe.directory '*'

ENV HOME=/home/agent \
    PATH=/opt/sandflow/tools:/opt/sandflow/tools/bin:/home/agent/.local/bin:$PATH \
    # Air-gapped friendly: no self-updates, telemetry or other non-essential traffic from Claude Code.
    DISABLE_AUTOUPDATER=1 \
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
    DISABLE_TELEMETRY=1 \
    DISABLE_ERROR_REPORTING=1

WORKDIR /home/agent

LABEL org.opencontainers.image.title="sandflow-agent" \
      org.opencontainers.image.source="https://github.com/kafuexe/sandflow"

# sandcastle bind-mounts the git worktree at /home/agent/workspace and execs commands in the container.
ENTRYPOINT ["sleep", "infinity"]
