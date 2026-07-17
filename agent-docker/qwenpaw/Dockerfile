FROM agentscope-registry.ap-southeast-1.cr.aliyuncs.com/agentscope/qwenpaw:latest

ARG COMPUTENEST_CLI_VERSION=1.9.16

# Switch to root for any customization
USER root

# Install supervisor (for supervisorctl) + tini + procps/psmisc/lsof.
# 镜像已内置 supervisord 主进程，只需 supervisorctl 客户端用于优雅重启。
# procps(pgrep)/psmisc(fuser)/lsof 为 restart_app 的按端口反查 pid 兑底路径提供
# 必需工具——官方镜像缺少这些，run-cmd.sh 在 supervisorctl 失败时会按端口 8088
# 反查 app pid 并 SIGTERM，由 qwenpaw 内置 supervisord 的 autorestart 自动拉起。
# 注意：apt 装的 supervisorctl 默认连 /var/run/supervisor.sock，但 qwenpaw 内置
# supervisord 可能用不同 socket 路径，run-cmd.sh 会动态查找实际 socket。
RUN apt-get update && \
    apt-get install -y supervisor tini procps psmisc lsof && \
    rm -rf /var/cache/apt/*

RUN UV_PYTHON_DOWNLOADS=never uv venv --python python3 /opt/agent-manager/computenest-venv && \
    uv pip install --python /opt/agent-manager/computenest-venv/bin/python --no-cache \
      "computenest-cli==${COMPUTENEST_CLI_VERSION}"

RUN su -s /bin/sh node -c 'HOME=/home/node /opt/agent-manager/computenest-venv/bin/computenest-cli skillhub install --help >/dev/null'

# Ensure qwenpaw data directories exist (will be overlaid by emptyDir volumes at runtime)
RUN mkdir -p /app/working /app/working.secret /app/working.secret/providers/custom /app/working.backups

# Seed 3 个平台默认 provider 模板。
#   - /app/working.secret 在 SandboxSet 里是 emptyDir 挂载，镜像里预置的
#     /app/working.secret/providers/** 运行时会被空卷盖掉，因此 COPY
#     到 不被挂载的 /opt/qwenpaw-providers/ 做为“seed 模板”。
#   - run-cmd.sh 在 modify-model 时会把该目录的模板拷到
#     /app/working.secret/providers/{builtin,custom}/，仅当目标文件不存在
#     时拷——保留用户文档进去的任何改动。
#   - 3 个默认提供商：
#     builtin/dashscope.json         ← 百炼 (平台 name: bailian)
#     custom/aliyun-ai-gateway.json  ← 阿里云 AI 网关 (平台 name: api_gateway)
#     custom/litellm.json            ← LiteLLM 网关 (平台 name: litellm)
COPY agent-docker/qwenpaw/providers /opt/qwenpaw-providers
RUN chmod -R a+r /opt/qwenpaw-providers

# Copy run-cmd.sh - selective model config modifier.
# qwenpaw 不支持在线修改渠道，因此 run-cmd.sh 只实现 modify-model 与 init-providers：
#   1. init-providers：将 /opt/qwenpaw-providers/ 里的 3 个模板 seed 到
#      /app/working.secret/providers/ 对应子目录（幂等，目标已存在则跳过）。
#   2. modify-model：按映射表把平台传入的 MODEL_PROVIDER 解析为 (target_rel_path,
#      qwenpaw_id, override_base_url) 三元组，合并写回目标 provider JSON，并
#      写 /app/working.secret/providers/active_model.json，最后 supervisorctl
#      restart app 让 qwenpaw 重新加载。
COPY agent-docker/qwenpaw/run-cmd.sh /usr/local/bin/run-cmd.sh
RUN chmod +x /usr/local/bin/run-cmd.sh

# 说明：
#   qwenpaw 官方镜像已内置完整启动链：
#     ENTRYPOINT ["docker-entrypoint.sh"]
#     CMD        ["/entrypoint.sh"]
#   /entrypoint.sh 会自动完成：
#     1. 检查 /app/working/config.json，缺失则执行 `qwenpaw init --defaults --accept-security`
#     2. 用 QWENPAW_PORT 渲染 /etc/supervisor/conf.d/supervisord.conf.template
#     3. exec 镜像自带 supervisord，启动 dbus / xvfb / xfce4 / app 四个进程
#   不覆盖 ENTRYPOINT/CMD，由平台 startup_command (run-cmd.sh modify-model) 在实例
#   创建后完成 seed + 写入 + supervisorctl restart app，qwenpaw 重启后加载完整 providers。

# ── Pre-install loongsuite observability packages (offline-ready) ──
# 计算巢运行环境可能无公网出口，必须在构建阶段预装，不依赖运行时 pip install。
RUN /app/venv/bin/pip install --no-cache \
    loongsuite-site-bootstrap \
    loongsuite-distro \
    loongsuite-instrumentation-qwenpaw \
    loongsuite-instrumentation-agentscope

# ── Create toggle-observability.sh for hot-switching collection on/off ──
COPY agent-docker/qwenpaw/toggle-observability.sh /usr/local/bin/toggle-observability.sh
RUN chmod +x /usr/local/bin/toggle-observability.sh

# ── Write entrypoint.sh (ARMS observability + graceful degradation) ──
# QwenPaw uses the official qwenpaw-cms-plugin for CMS 2.0 integration.
# ARMS connection parameters are injected at runtime via SandboxSet env vars.
# If not set, the entrypoint starts QwenPaw without monitoring (graceful degradation).
COPY agent-docker/qwenpaw/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
