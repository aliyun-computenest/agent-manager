FROM ghcr.io/openclaw/openclaw:2026.5.19

ARG COMPUTENEST_CLI_VERSION=1.9.16

# Switch to root to install plugins
USER root

# ── 1. Install supervisor + tini ──
RUN apt update && \
    apt install -y supervisor tini python3-venv && \
    python3 -m venv /opt/agent-manager/computenest-venv && \
    /opt/agent-manager/computenest-venv/bin/python -m pip install --disable-pip-version-check --no-cache-dir "computenest-cli==${COMPUTENEST_CLI_VERSION}" && \
    rm -rf /var/cache/apt/*

RUN su -s /bin/sh node -c 'HOME=/home/node /opt/agent-manager/computenest-venv/bin/computenest-cli skillhub install --help >/dev/null'

# Copy run-cmd.sh for config modification
COPY agent-docker/openclaw/run-cmd.sh /usr/local/bin/run-cmd.sh
RUN chmod +x /usr/local/bin/run-cmd.sh

# Append openclaw supervisor program config
COPY agent-docker/openclaw/supervisord.conf /tmp/supervisord.conf
RUN cat /tmp/supervisord.conf >> /etc/supervisor/supervisord.conf && \
    rm /tmp/supervisord.conf

# ── 3. Install channel connector plugins ──
# NOTE: All plugin versions are pinned to ensure compatibility with OpenClaw 2026.3.23
RUN mkdir -p /home/node/.openclaw/extensions && \
    cd /home/node/.openclaw/extensions && \
    npm pack @wecom/wecom-openclaw-plugin@2026.5.14 && \
    npm pack @tencent-connect/openclaw-qqbot@1.7.1 && \
    npm pack @larksuite/openclaw-lark@2026.5.13 && \
    npm pack @dingtalk-real-ai/dingtalk-connector@0.8.21

# Extract and install dependencies for each channel plugin
RUN cd /home/node/.openclaw/extensions && \
    for pkg in *.tgz; do \
        dir=$(echo $pkg | sed 's/-[0-9].*//'); \
        mkdir -p $dir && tar -xzf $pkg -C $dir --strip-components=1 && rm $pkg && \
        if [ -f "$dir/package.json" ]; then cd $dir && npm install --production && cd ..; fi; \
    done

# Expose the OpenClaw host package (/app, name="openclaw") to plugin extensions so that
# ESM bare specifiers like `import "openclaw/plugin-sdk/core"` used by newer plugin
# versions (e.g. dingtalk-connector >= 0.8.21) can be resolved by Node.js. Without this
# symlink the plugin fails to register with: Cannot find module 'openclaw/plugin-sdk/core'.
RUN mkdir -p /home/node/.openclaw/node_modules && \
    ln -sfn /app /home/node/.openclaw/node_modules/openclaw

# ── 4. Install ARMS observability plugin ──
# The opentelemetry-instrumentation-openclaw package is NOT published to npm
# (verified: 404 on registry.npmjs.org / registry.npmmirror.com / registry.anpm.alibaba-inc.com).
# It is distributed as a prebuilt tarball hosted on ARMS OSS bucket in cn-hangzhou
# (the only region where this OSS bucket exists). We download it directly here at
# build time, so the runtime image contains the plugin files + node_modules.
# ARMS connection parameters (endpoint, license key, project, workspace) are
# injected at runtime via environment variables and merged into openclaw.json by
# entrypoint.sh — see step 5 below.
RUN cd /home/node/.openclaw/extensions && \
    mkdir -p opentelemetry-instrumentation-openclaw && \
    cd opentelemetry-instrumentation-openclaw && \
    curl -fsSL "https://arms-apm-cn-hangzhou-pre.oss-cn-hangzhou.aliyuncs.com/opentelemetry-instrumentation-openclaw/opentelemetry-instrumentation-openclaw.tar.gz" -o plugin.tar.gz && \
    tar -xzf plugin.tar.gz --strip-components=1 && rm plugin.tar.gz && \
    npm install --omit=dev --ignore-scripts && \
    ls -la /home/node/.openclaw/extensions/opentelemetry-instrumentation-openclaw/package.json

# ── 4b. Install rejection-guard to prevent plugin async errors from crashing gateway ──
# The observability plugin has 11 async hook handlers without try/catch. Any async
# failure (e.g. network timeout to xtrace endpoint) causes an unhandled promise
# rejection, which crashes the process under Node.js v24's default
# --unhandled-rejections=throw mode. This guard registers a global listener that
# logs the rejection instead of letting it propagate.
COPY agent-docker/openclaw/rejection-guard.js /home/node/.openclaw/extensions/opentelemetry-instrumentation-openclaw/rejection-guard.js

# ── 4c. Create toggle-observability.sh for hot-switching collection on/off ──
COPY agent-docker/openclaw/toggle-observability.sh /usr/local/bin/toggle-observability.sh
RUN chmod +x /usr/local/bin/toggle-observability.sh

# ── 5. Write entrypoint.sh (generates openclaw.json on first boot, no-op on restart) ──
COPY agent-docker/openclaw/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# ── 6. Fix ownership ──
RUN chown -R node:node /home/node/.openclaw

# ── 7. Entrypoint ──
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
