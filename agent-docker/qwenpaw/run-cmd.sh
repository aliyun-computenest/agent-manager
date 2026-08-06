#!/bin/bash
# run-cmd.sh — QwenPaw Agent Manager 平台对接脚本
#
# 三个单一职责子命令，可任意组合：
#
#   seed                           幂等：从 /opt/qwenpaw-providers/ 复制默认 provider 模板
#                                  到 /app/working.secret/providers/{builtin,custom}/
#                                  （emptyDir 挂载会盖掉镜像预置，首启必须运行）
#
#   write-model <provider> <model> 只写模型配置（不 seed、不 restart）：
#                                    - providers/<builtin|custom>/<qwenpaw_id>.json 覆写
#                                      platform 托管字段（id / api_key / base_url?）
#                                    - providers/active_model.json 全量覆写为
#                                      {"provider_id": "<qwenpaw_id>", "model": "<model>"}
#
#   restart                        只重启 qwenpaw app 子进程（不改配置）：
#                                    1) 首选 supervisorctl（动态查找 socket）
#                                    2) 失败 fallback：按端口 8088 反查 pid + SIGTERM，
#                                       靠内置 supervisord 的 autorestart 自动拉起
#
# ---------------------------------------------------------------------------
# 平台在 agent_types 里组合这三条命令：
#
#   startup_command      = seed + write-model + restart   （首次初始化）
#   modify_model_command = write-model + restart          （切换模型，无需 seed）
#
# api_key / base_url 通过环境变量注入，映射见 PROVIDER_MAP：
#   _QP_BAILIAN_KEY  ← ${DASHSCOPE_API_KEY}
#   _QP_GATEWAY_KEY  ← ${CONSUMER_API_KEY}
#   _QP_LITELLM_KEY  ← ${LITELLM_API_KEY}
#   _QP_GATEWAY_URL  ← ${AI_GATEWAY_DOMAIN}
#   _QP_LITELLM_URL  ← ${LITELLM_PROXY_URL}
# ---------------------------------------------------------------------------

set -euo pipefail

PROVIDERS_ROOT="${QWENPAW_PROVIDERS_ROOT:-/app/working.secret/providers}"
SEED_DIR="${QWENPAW_SEED_DIR:-/opt/qwenpaw-providers}"
SUPERVISOR_PROGRAM="${QWENPAW_SUPERVISOR_PROGRAM:-app}"
QWENPAW_APP_PORT="${QWENPAW_APP_PORT:-8088}"

# 平台 provider name → (相对路径, qwenpaw id, 是否覆盖 base_url, api_key env, base_url env)
# dashscope 在 qwenpaw 侧 freeze_url=true，端点固定，平台只能注 api_key。
declare -A PROVIDER_MAP=(
    [bailian]="builtin/dashscope.json|dashscope|0|_QP_BAILIAN_KEY|"
    [api_gateway]="custom/aliyun-ai-gateway.json|aliyun-ai-gateway|1|_QP_GATEWAY_KEY|_QP_GATEWAY_URL"
    [litellm]="custom/litellm.json|litellm|1|_QP_LITELLM_KEY|_QP_LITELLM_URL"
)

# ============================================================
# cmd: seed
# ============================================================
cmd_seed() {
    # /app/working 是运行时挂载卷，新实例和旧实例都在 seed 时收敛 Skill 池权限。
    # 仅目录本身由 root 准备，后续 Skill 下载和解包始终以 node 执行。
    local skill_pool="/app/working/skill_pool"
    if [ -L "$skill_pool" ] || { [ -e "$skill_pool" ] && [ ! -d "$skill_pool" ]; }; then
        echo "Error: invalid QwenPaw skill pool" >&2
        return 1
    fi
    install -d -m 0755 -o node -g node "$skill_pool"
    chown -hR node:node "$skill_pool"
    mkdir -p "$PROVIDERS_ROOT/builtin" "$PROVIDERS_ROOT/custom"
    [ -d "$SEED_DIR" ] || { echo "skip seed: $SEED_DIR not found" >&2; return 0; }
    find "$SEED_DIR" -type f -name '*.json' | while read -r src; do
        dst="$PROVIDERS_ROOT/${src#${SEED_DIR}/}"
        [ -e "$dst" ] && continue
        mkdir -p "$(dirname "$dst")"
        cp -f "$src" "$dst"
        echo "seeded: $dst"
    done
}

# ============================================================
# cmd: write-model <platform_provider> <model>
# ============================================================
cmd_write_model() {
    local platform="${1:-}" model="${2:-}"

    [ -n "$platform" ] && [ -n "$model" ] || {
        echo "Usage: run-cmd.sh write-model <platform_provider> <model>" >&2
        exit 1
    }

    local entry="${PROVIDER_MAP[$platform]:-}"
    [ -n "$entry" ] || {
        echo "Error: unknown platform provider '$platform'. Supported: ${!PROVIDER_MAP[*]}" >&2
        exit 2
    }

    local rel_path qwenpaw_id override_url key_env url_env
    IFS='|' read -r rel_path qwenpaw_id override_url key_env url_env <<<"$entry"

    # 按 PROVIDER_MAP 从 env 读 api_key / base_url（indirect expansion）。
    local api_key="" base_url=""
    [ -n "$key_env" ] && api_key="${!key_env:-}"
    [ -n "$url_env" ] && base_url="${!url_env:-}"

    # 敏感值走 env 传给 python，不进 argv。
    _QP_TARGET="$PROVIDERS_ROOT/$rel_path" \
    _QP_ACTIVE="$PROVIDERS_ROOT/active_model.json" \
    _QP_ID="$qwenpaw_id" \
    _QP_MODEL="$model" \
    _QP_BASE_URL="$base_url" \
    _QP_API_KEY="$api_key" \
    _QP_OVERRIDE_URL="$override_url" \
    python3 - <<'PY'
import json, os, sys

target   = os.environ["_QP_TARGET"]
active   = os.environ["_QP_ACTIVE"]
qid      = os.environ["_QP_ID"]
model    = os.environ["_QP_MODEL"]
base_url = os.environ["_QP_BASE_URL"]
api_key  = os.environ["_QP_API_KEY"]
override = os.environ["_QP_OVERRIDE_URL"] == "1"

def sanitize_ascii(s, field):
    # Authorization / base_url 进入 HTTP header 或 URL 后必须是纯 ASCII。
    # 若上游 env 含乱码（如 LANG 缺失导致的 \ufffd 替换字符），这里直接剥除，
    # 让请求时的 401/403 比 httpx 的 UnicodeEncodeError 更清晰。
    if not s:
        return s
    cleaned = s.encode("ascii", "ignore").decode("ascii")
    if cleaned != s:
        print(f"warn: non-ASCII chars stripped from {field} (orig_len={len(s)} clean_len={len(cleaned)})", file=sys.stderr)
    return cleaned

api_key  = sanitize_ascii(api_key,  "api_key")
base_url = sanitize_ascii(base_url, "base_url")

def atomic_write(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=2)
    os.replace(tmp, path)

# Provider 文件：load → 只覆写 platform 字段 → 写回，保留 models / extra_models 等。
cfg = {}
if os.path.isfile(target):
    try:
        with open(target, encoding="utf-8") as f:
            cfg = json.load(f) or {}
        if not isinstance(cfg, dict):
            cfg = {}
    except Exception:
        cfg = {}
cfg["id"] = qid
cfg["api_key"] = api_key or cfg.get("api_key", "")
if override and base_url:
    cfg["base_url"] = base_url
atomic_write(target, cfg)

# 激活态：每次全量覆写。provider_id 必须用 qwenpaw 内部 id。
atomic_write(active, {"provider_id": qid, "model": model})
print(f"updated: {target}; active={qid}/{model}")
PY
}

# ============================================================
# cmd: restart
#   两层兑底重启 qwenpaw app 子进程：
#   1) 首选 supervisorctl（动态查找 socket）
#   2) 失败 fallback：按端口 8088 反查 pid + SIGTERM
# ============================================================
_restart_via_supervisorctl() {
    command -v supervisorctl >/dev/null 2>&1 || return 1

    local sock=""
    for candidate in \
        /var/run/supervisor.sock \
        /var/run/supervisord.sock \
        /tmp/supervisor.sock \
        /tmp/supervisord.sock \
        /run/supervisor.sock \
        /run/supervisord.sock; do
        if [ -S "$candidate" ]; then
            sock="$candidate"
            break
        fi
    done
    if [ -z "$sock" ]; then
        sock=$(find /var/run /tmp /run 2>/dev/null -name "supervisor*.sock" -type s | head -1)
    fi

    local ctl_args=()
    [ -n "$sock" ] && ctl_args=(-s "unix://$sock")

    if supervisorctl "${ctl_args[@]}" restart "$SUPERVISOR_PROGRAM" 2>&1; then
        echo "restarted $SUPERVISOR_PROGRAM via supervisorctl${sock:+ (socket=$sock)}"
        return 0
    fi
    return 1
}

_restart_via_signal() {
    # 按端口找 app pid，最可靠，不依赖进程名关键字。
    local pids=""
    if command -v fuser >/dev/null 2>&1; then
        pids=$(fuser "${QWENPAW_APP_PORT}/tcp" 2>/dev/null | tr -s ' ' '\n' | grep -E '^[0-9]+$' || true)
    fi
    if [ -z "$pids" ] && command -v ss >/dev/null 2>&1; then
        pids=$(ss -tlnpH "sport = :${QWENPAW_APP_PORT}" 2>/dev/null \
            | grep -oE 'pid=[0-9]+' | cut -d= -f2 | sort -u || true)
    fi
    if [ -z "$pids" ] && command -v lsof >/dev/null 2>&1; then
        pids=$(lsof -tiTCP:"${QWENPAW_APP_PORT}" -sTCP:LISTEN 2>/dev/null || true)
    fi
    # 端口反查全不可用时再按关键字兑底
    if [ -z "$pids" ] && command -v pgrep >/dev/null 2>&1; then
        pids=$(pgrep -f 'qwenpaw' 2>/dev/null || true)
    fi

    [ -n "$pids" ] || return 1

    echo "$pids" | while read -r pid; do
        [ -n "$pid" ] && kill -TERM "$pid" 2>/dev/null && \
            echo "sent SIGTERM to pid=$pid (port ${QWENPAW_APP_PORT}); supervisord autorestart will respawn"
    done
    return 0
}

cmd_restart() {
    if _restart_via_supervisorctl; then
        return 0
    fi
    echo "warn: supervisorctl restart failed; falling back to port-based signal" >&2

    if _restart_via_signal; then
        return 0
    fi

    echo "error: cannot restart $SUPERVISOR_PROGRAM — neither supervisorctl nor pid lookup worked" >&2
    return 1
}

# ============================================================
# 主路由
# ============================================================
case "${1:-}" in
    seed)
        cmd_seed
        ;;
    write-model)
        shift
        cmd_write_model "$@"
        ;;
    restart)
        cmd_restart
        ;;
    modify-channel)
        # qwenpaw 不支持平台侧改渠道（agent_types.supports_channels=false）。
        echo "Error: qwenpaw does not support platform-managed channel modification." >&2
        exit 1
        ;;
    help|-h|--help)
        cat <<EOF
Usage:
  run-cmd.sh seed                                     幂等 seed 默认 provider 模板
  run-cmd.sh write-model <platform_provider> <model>  只写模型配置（不 seed、不 restart）
  run-cmd.sh restart                                  只重启 qwenpaw app 子进程

Platform provider: bailian | api_gateway | litellm

Env (由平台 startup_command / modify_model_command 注入)：
  _QP_BAILIAN_KEY  ← DASHSCOPE_API_KEY     (bailian 直连 AK)
  _QP_GATEWAY_KEY  ← CONSUMER_API_KEY      (阿里云 AI 网关 consumer key)
  _QP_LITELLM_KEY  ← LITELLM_API_KEY       (LiteLLM 网关 key)
  _QP_GATEWAY_URL  ← AI_GATEWAY_DOMAIN     (阿里云 AI 网关域名)
  _QP_LITELLM_URL  ← LITELLM_PROXY_URL     (LiteLLM 代理地址)

Env overrides:
  QWENPAW_PROVIDERS_ROOT      default: /app/working.secret/providers
  QWENPAW_SEED_DIR            default: /opt/qwenpaw-providers
  QWENPAW_SUPERVISOR_PROGRAM  default: app
  QWENPAW_APP_PORT            default: 8088
EOF
        ;;
    *)
        echo "Usage: run-cmd.sh {seed|write-model|restart|modify-channel|help}" >&2
        exit 1
        ;;
esac
