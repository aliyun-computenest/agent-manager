FROM nousresearch/hermes-agent:v2026.5.16@sha256:b6e41c155d6bfce5ad83c5d0fec670086db8a43250e4511c9474134be5482d33

ARG COMPUTENEST_CLI_VERSION=1.9.16

USER root

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      supervisor tini python3 python3-yaml curl ca-certificates && \
    rm -rf /var/lib/apt/lists/*

RUN UV_PYTHON_DOWNLOADS=never /usr/local/bin/uv venv --python python3 /opt/agent-manager/computenest-venv && \
    /usr/local/bin/uv pip install --python /opt/agent-manager/computenest-venv/bin/python --no-cache \
      "computenest-cli==${COMPUTENEST_CLI_VERSION}"

RUN su -s /bin/sh hermes -c 'HOME=/opt/data /opt/agent-manager/computenest-venv/bin/computenest-cli skillhub install --help >/dev/null'

# Pre-install messaging platform dependencies (DingTalk + Feishu) into hermes venv.
# hermes v0.14.0 lazy_deps installs SDKs on first use, but _IncomingHandler's base
# class is frozen at module import time — if dingtalk_stream is missing then, the
# handler permanently inherits from object and silently drops all messages.
RUN VIRTUAL_ENV=/opt/hermes/.venv /usr/local/bin/uv pip install --no-cache \
        "dingtalk-stream==0.24.3" \
        "alibabacloud-dingtalk==2.2.42" \
        "lark-oapi==1.5.3" \
        "qrcode==7.4.2" \
        "edge-tts==7.2.7"

# Copy run-cmd.sh - selective model/channel config modifier.
# Invoked by the platform when users change model or channel, so that
# user-level customizations in config.yaml / .env are preserved.
COPY agent-docker/hermes/run-cmd.sh /usr/local/bin/run-cmd.sh
RUN chmod +x /usr/local/bin/run-cmd.sh

# Append hermes supervisor program config
COPY agent-docker/hermes/supervisord.conf /tmp/supervisord.conf
RUN cat /tmp/supervisord.conf >> /etc/supervisor/supervisord.conf && \
    rm /tmp/supervisord.conf

# Create hermes data directory
RUN mkdir -p /opt/data

# ── Install ARMS Python agent (CMS 2.0 observability) ──
# The aliyun-python-agent is a prebuilt wheel package hosted on cn-hangzhou OSS.
# It provides automatic LLM call tracing via PYTHONPATH injection.
RUN curl -fsSL https://arms-apm-cn-hangzhou.oss-cn-hangzhou.aliyuncs.com/aliyun-python-agent/aliyun-python-agent.tar.gz \
    -o /tmp/aliyun-python-agent.tar.gz && \
    mkdir -p /tmp/aliyun-python-agent && \
    tar -zxf /tmp/aliyun-python-agent.tar.gz -C /tmp/aliyun-python-agent && \
    uv pip install --python /opt/hermes/.venv/bin/python /tmp/aliyun-python-agent/target/*.whl && \
    rm -rf /tmp/aliyun-python-agent /tmp/aliyun-python-agent.tar.gz && \
    echo "ARMS Python agent installed" && \
    /opt/hermes/.venv/bin/python -c "import aliyun.opentelemetry; print('agent importable')" || echo "WARN: agent import check failed"

# Install dashscope SDK — required for ARMS dashscope instrumentation to load.
# Without this package, the ARMS agent skips dashscope instrumentation with
# "DependencyConflict: dashscope>=1.0.0 not found" and genai spans won't be generated.
RUN uv pip install --python /opt/hermes/.venv/bin/python --no-cache dashscope

# Copy ARMS agent patch script for xtrace (CMS 2.0) compatibility.
# Applied at container startup by entrypoint.sh to fix compression, headers, and endpoint.
COPY agent-docker/hermes/patch-arms-agent.py /usr/local/bin/patch-arms-agent.py
RUN chmod +x /usr/local/bin/patch-arms-agent.py

# ── Create toggle-observability.sh for hot-switching collection on/off ──
COPY agent-docker/hermes/toggle-observability.sh /usr/local/bin/toggle-observability.sh
RUN chmod +x /usr/local/bin/toggle-observability.sh

# ── Write entrypoint.sh (set ARMS env + PYTHONPATH at runtime) ──
# ARMS connection parameters (endpoint, license key, project, workspace) are
# injected at runtime via SandboxSet environment variables. If not set,
# the entrypoint starts hermes without monitoring (graceful degradation).
COPY agent-docker/hermes/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# Disable tirith (Terraform policy checker) — not needed, avoids 12MB download on
# every cold start (~70s delay).
ENV TIRITH_ENABLED=false

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
