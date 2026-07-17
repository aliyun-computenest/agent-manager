-- =====================================================
-- Migration: 新增内置 Agent 类型 qwenpaw
-- Version: 1.0.2
-- =====================================================
-- 背景：
--   接入第三个内置 Agent —— AgentScope QwenPaw（桌面型 Agent，
--   内置 Xvfb / xfce4 / Playwright Chromium / qwenpaw app 四个 supervisord
--   子进程，主服务监听 8088）。
-- =====================================================

INSERT INTO agent_types (
  code, name, description, icon, category,
  sandbox_template_id, sandbox_timeout,
  config_template, config_write_path,
  startup_command, readiness_check,
  upgrade_metadata,
  supports_channels, sandbox_user,
  is_enabled, sort_order,
  modify_model_command, modify_channel_command
) VALUES (
  'qwenpaw',
  'QwenPaw',
  '基于 AgentScope QwenPaw 的桌面型 AI Agent，内置 Xvfb 桌面 + Chromium + 多工具能力',
  'bot',
  'builtin',
  'agent-manager-qwenpaw',
  300,
  -- config_template：仅注入平台必须托管的字段。
  -- ⚠️ 当前激活的 provider+model 由 run-cmd.sh 写到
  --   /app/working.secret/providers/active_model.json（qwenpaw 权威读取源），
  -- config.json 的 llm_routing.local 保留为空对象仅作示例，赋值不生效。
  -- channels 默认只开 console（本期不暴露外部渠道凭证）。
  '{
  "mcp": {
    "clients": {
      "tavily_search": {
        "cwd": "",
        "env": {
          "TAVILY_API_KEY": ""
        },
        "url": "",
        "args": [
          "-y",
          "tavily-mcp@latest"
        ],
        "name": "tavily_mcp",
        "command": "npx",
        "enabled": false,
        "headers": {},
        "transport": "stdio",
        "description": ""
      }
    }
  },
  "tools": {
    "builtin_tools": {
      "edit_file": {
        "icon": "🖊️",
        "name": "edit_file",
        "enabled": true,
        "description": "Edit file using find-and-replace",
        "async_execution": false,
        "display_to_user": true
      },
      "read_file": {
        "icon": "📄",
        "name": "read_file",
        "enabled": true,
        "description": "Read file contents",
        "async_execution": false,
        "display_to_user": true
      },
      "view_image": {
        "icon": "🖼️",
        "name": "view_image",
        "enabled": true,
        "description": "Load an image into LLM context for visual analysis",
        "async_execution": false,
        "display_to_user": false
      },
      "view_video": {
        "icon": "🎥",
        "name": "view_video",
        "enabled": true,
        "description": "Load a video into LLM context for visual analysis",
        "async_execution": false,
        "display_to_user": false
      },
      "write_file": {
        "icon": "✍️",
        "name": "write_file",
        "enabled": true,
        "description": "Write content to file",
        "async_execution": false,
        "display_to_user": true
      },
      "browser_use": {
        "icon": "🌐",
        "name": "browser_use",
        "enabled": true,
        "description": "Browser automation and web interaction",
        "async_execution": false,
        "display_to_user": true
      },
      "glob_search": {
        "icon": "📁",
        "name": "glob_search",
        "enabled": true,
        "description": "Find files matching a glob pattern",
        "async_execution": false,
        "display_to_user": true
      },
      "grep_search": {
        "icon": "🔍",
        "name": "grep_search",
        "enabled": true,
        "description": "Search file contents by pattern",
        "async_execution": false,
        "display_to_user": true
      },
      "list_agents": {
        "icon": "🤖",
        "name": "list_agents",
        "enabled": true,
        "description": "List configured agents from the local API",
        "async_execution": false,
        "display_to_user": true
      },
      "chat_with_agent": {
        "icon": "💬",
        "name": "chat_with_agent",
        "enabled": true,
        "description": "Send a message to another configured agent",
        "async_execution": false,
        "display_to_user": true
      },
      "get_token_usage": {
        "icon": "📊",
        "name": "get_token_usage",
        "enabled": true,
        "description": "Get llm token usage",
        "async_execution": false,
        "display_to_user": true
      },
      "get_current_time": {
        "icon": "🕐",
        "name": "get_current_time",
        "enabled": true,
        "description": "Get current date and time",
        "async_execution": false,
        "display_to_user": true
      },
      "send_file_to_user": {
        "icon": "📤",
        "name": "send_file_to_user",
        "enabled": true,
        "description": "Send files to user",
        "async_execution": false,
        "display_to_user": true
      },
      "set_user_timezone": {
        "icon": "🌍",
        "name": "set_user_timezone",
        "enabled": true,
        "description": "Set user timezone",
        "async_execution": false,
        "display_to_user": true
      },
      "desktop_screenshot": {
        "icon": "📸",
        "name": "desktop_screenshot",
        "enabled": true,
        "description": "Capture desktop screenshots",
        "async_execution": false,
        "display_to_user": true
      },
      "execute_shell_command": {
        "icon": "💻",
        "name": "execute_shell_command",
        "enabled": true,
        "description": "Execute shell commands",
        "async_execution": false,
        "display_to_user": true
      }
    }
  },
  "agents": {
    "running": {
      "max_iters": 100,
      "llm_max_qpm": 600,
      "memory_summary": {
        "force_min_score": 0.3,
        "force_max_results": 1,
        "force_memory_search": false,
        "memory_prompt_enabled": true,
        "memory_summary_enabled": true,
        "force_memory_search_timeout": 10,
        "rebuild_memory_index_on_start": false
      },
      "context_compact": {
        "token_count_model": "default",
        "memory_compact_ratio": 0.75,
        "memory_reserve_ratio": 0.1,
        "token_count_use_mirror": false,
        "context_compact_enabled": true,
        "compact_with_thinking_block": true,
        "token_count_estimate_divisor": 4
      },
      "llm_backoff_cap": 10,
      "llm_max_retries": 3,
      "embedding_config": {
        "api_key": "",
        "backend": "openai",
        "base_url": "",
        "dimensions": 1024,
        "model_name": "",
        "enable_cache": true,
        "max_batch_size": 10,
        "max_cache_size": 3000,
        "use_dimensions": false,
        "max_input_length": 8192
      },
      "llm_backoff_base": 1,
      "max_input_length": 131072,
      "llm_retry_enabled": true,
      "history_max_length": 10000,
      "llm_max_concurrent": 10,
      "llm_acquire_timeout": 300,
      "tool_result_compact": {
        "enabled": true,
        "recent_n": 2,
        "old_max_bytes": 3000,
        "retention_days": 5,
        "recent_max_bytes": 50000
      },
      "llm_rate_limit_pause": 5,
      "llm_rate_limit_jitter": 1,
      "memory_manager_backend": "remelight"
    },
    "defaults": {
      "heartbeat": {
        "every": "6h",
        "target": "main",
        "enabled": false,
        "activeHours": null
      }
    },
    "language": "zh",
    "profiles": {
      "default": {
        "id": "default",
        "enabled": true,
        "workspace_dir": "/app/working/workspaces/default"
      },
      "QwenPaw_QA_Agent_0.2": {
        "id": "QwenPaw_QA_Agent_0.2",
        "enabled": true,
        "workspace_dir": "/app/working/workspaces/QwenPaw_QA_Agent_0.2"
      }
    },
    "audio_mode": "auto",
    "agent_order": [
      "default"
    ],
    "llm_routing": {
      "mode": "local_first",
      "cloud": null,
      "local": {
        "model": "",
        "provider_id": ""
      },
      "enabled": false
    },
    "active_agent": "default",
    "system_prompt_files": [
      "AGENTS.md",
      "SOUL.md",
      "PROFILE.md"
    ],
    "transcription_model": "whisper-1",
    "transcription_provider_id": "",
    "installed_md_files_language": "zh",
    "transcription_provider_type": "disabled"
  },
  "plugins": {},
  "channels": {
    "qq": {
      "app_id": "",
      "enabled": false,
      "dm_policy": "open",
      "allow_from": [],
      "bot_prefix": "",
      "deny_message": "",
      "group_policy": "open",
      "client_secret": "",
      "filter_thinking": false,
      "require_mention": false,
      "markdown_enabled": true,
      "filter_tool_messages": false,
      "max_reconnect_attempts": 100
    },
    "mqtt": {
      "qos": 2,
      "host": "",
      "port": null,
      "enabled": false,
      "password": null,
      "username": null,
      "dm_policy": "open",
      "transport": "",
      "allow_from": [],
      "bot_prefix": "",
      "tls_enabled": false,
      "tls_keyfile": null,
      "deny_message": "",
      "group_policy": "open",
      "tls_ca_certs": null,
      "tls_certfile": null,
      "clean_session": true,
      "publish_topic": "",
      "filter_thinking": false,
      "require_mention": false,
      "subscribe_topic": "",
      "filter_tool_messages": false
    },
    "voice": {
      "enabled": false,
      "language": "en-US",
      "dm_policy": "open",
      "tts_voice": "en-US-Journey-D",
      "allow_from": [],
      "bot_prefix": "",
      "deny_message": "",
      "group_policy": "open",
      "phone_number": "",
      "stt_provider": "deepgram",
      "tts_provider": "google",
      "filter_thinking": false,
      "require_mention": false,
      "phone_number_sid": "",
      "welcome_greeting": "Hi! This is QwenPaw. How can I help you?",
      "twilio_auth_token": "",
      "twilio_account_sid": "",
      "filter_tool_messages": false
    },
    "wecom": {
      "bot_id": "",
      "secret": "",
      "enabled": false,
      "dm_policy": "open",
      "media_dir": null,
      "allow_from": [],
      "bot_prefix": "",
      "deny_message": "",
      "group_policy": "open",
      "welcome_text": "",
      "filter_thinking": false,
      "require_mention": false,
      "filter_tool_messages": false,
      "max_reconnect_attempts": -1
    },
    "feishu": {
      "app_id": "",
      "domain": "feishu",
      "enabled": false,
      "dm_policy": "open",
      "media_dir": null,
      "allow_from": [],
      "app_secret": "",
      "bot_prefix": "",
      "encrypt_key": "",
      "deny_message": "",
      "group_policy": "open",
      "filter_thinking": false,
      "require_mention": false,
      "verification_token": "",
      "filter_tool_messages": false
    },
    "matrix": {
      "groups": {},
      "enabled": false,
      "user_id": "",
      "password": "",
      "username": "",
      "dm_policy": "open",
      "allow_from": [],
      "bot_prefix": "",
      "encryption": false,
      "homeserver": "",
      "device_name": "qwenpaw-worker",
      "access_token": "",
      "deny_message": "",
      "group_policy": "open",
      "history_limit": 50,
      "vision_enabled": true,
      "filter_thinking": false,
      "require_mention": false,
      "sync_timeout_ms": 30000,
      "group_allow_from": [],
      "filter_tool_messages": false,
      "mention_pill_in_body": false,
      "outbound_structured_mentions": true
    },
    "onebot": {
      "enabled": false,
      "ws_host": "0.0.0.0",
      "ws_port": 6199,
      "dm_policy": "open",
      "allow_from": [],
      "bot_prefix": "",
      "access_token": "",
      "deny_message": "",
      "group_policy": "open",
      "filter_thinking": false,
      "require_mention": false,
      "filter_tool_messages": false,
      "share_session_in_group": false
    },
    "weixin": {
      "enabled": false,
      "base_url": "",
      "bot_token": "",
      "dm_policy": "open",
      "media_dir": null,
      "allow_from": [],
      "bot_prefix": "",
      "deny_message": "",
      "group_policy": "open",
      "bot_token_file": "",
      "filter_thinking": false,
      "require_mention": false,
      "filter_tool_messages": false
    },
    "xiaoyi": {
      "ak": "",
      "sk": "",
      "ws_url": "wss://hag.cloud.huawei.com/openclaw/v1/ws/link",
      "enabled": false,
      "agent_id": "",
      "dm_policy": "open",
      "allow_from": [],
      "bot_prefix": "",
      "deny_message": "",
      "group_policy": "open",
      "filter_thinking": false,
      "require_mention": false,
      "task_timeout_ms": 3600000,
      "filter_tool_messages": false
    },
    "console": {
      "enabled": true,
      "dm_policy": "open",
      "media_dir": null,
      "allow_from": [],
      "bot_prefix": "",
      "deny_message": "",
      "group_policy": "open",
      "filter_thinking": false,
      "require_mention": false,
      "filter_tool_messages": false
    },
    "discord": {
      "enabled": false,
      "bot_token": "",
      "dm_policy": "open",
      "allow_from": [],
      "bot_prefix": "",
      "http_proxy": "",
      "deny_message": "",
      "group_policy": "open",
      "filter_thinking": false,
      "http_proxy_auth": "",
      "require_mention": false,
      "accept_bot_messages": false,
      "filter_tool_messages": false
    },
    "dingtalk": {
      "enabled": false,
      "client_id": "",
      "dm_policy": "open",
      "media_dir": null,
      "allow_from": [],
      "bot_prefix": "",
      "robot_code": "",
      "deny_message": "",
      "group_policy": "open",
      "message_type": "markdown",
      "client_secret": "",
      "filter_thinking": false,
      "require_mention": false,
      "card_auto_layout": false,
      "card_template_id": "",
      "card_template_key": "content",
      "filter_tool_messages": false
    },
    "imessage": {
      "db_path": "~/Library/Messages/chat.db",
      "enabled": false,
      "poll_sec": 1,
      "dm_policy": "open",
      "media_dir": null,
      "allow_from": [],
      "bot_prefix": "",
      "deny_message": "",
      "group_policy": "open",
      "filter_thinking": false,
      "require_mention": false,
      "max_decoded_size": 10485760,
      "filter_tool_messages": false
    },
    "telegram": {
      "enabled": false,
      "bot_token": "",
      "dm_policy": "open",
      "allow_from": [],
      "bot_prefix": "",
      "http_proxy": "",
      "show_typing": null,
      "deny_message": "",
      "group_policy": "open",
      "filter_thinking": false,
      "http_proxy_auth": "",
      "require_mention": false,
      "filter_tool_messages": false
    },
    "mattermost": {
      "url": "",
      "enabled": false,
      "bot_token": "",
      "dm_policy": "open",
      "media_dir": null,
      "allow_from": [],
      "bot_prefix": "",
      "show_typing": null,
      "deny_message": "",
      "group_policy": "open",
      "filter_thinking": false,
      "require_mention": false,
      "filter_tool_messages": false,
      "thread_follow_without_mention": false
    }
  },
  "last_api": {
    "host": "127.0.0.1",
    "port": 8088
  },
  "security": {
    "file_guard": {
      "enabled": true,
      "sensitive_files": []
    },
    "tool_guard": {
      "enabled": true,
      "custom_rules": [],
      "denied_tools": [],
      "guarded_tools": null,
      "disabled_rules": []
    },
    "skill_scanner": {
      "mode": "warn",
      "timeout": 30,
      "whitelist": []
    }
  },
  "last_dispatch": null,
  "user_timezone": "Etc/UTC",
  "show_tool_details": true
}'::jsonb,
  '/app/working/config.json',
  -- startup_command：首次创建实例后由平台 exec 进容器执行。
  '#!/bin/bash
set -e
export _QP_BAILIAN_KEY="${DASHSCOPE_API_KEY}"
export _QP_GATEWAY_KEY="${CONSUMER_API_KEY}"
export _QP_LITELLM_KEY="${LITELLM_API_KEY}"
export _QP_GATEWAY_URL="http://${AI_GATEWAY_DOMAIN}/v1"
export _QP_LITELLM_URL="${LITELLM_PROXY_URL}"

bash /usr/local/bin/run-cmd.sh seed
bash /usr/local/bin/run-cmd.sh write-model "${MODEL_PROVIDER}" "${MODEL_NAME}"
bash /usr/local/bin/run-cmd.sh restart
',
  -- readiness_check：HTTP 探活；qwenpaw 无 /healthz，复用版本接口。
  '{
  "path": "/api/version",
  "port": 8088,
  "type": "http",
  "timeout": 120
}'::jsonb,
  -- upgrade_metadata：Sandbox 备份/恢复 hook，与 SandboxUpdateOps 对齐。
  -- 备份范围：
  --   /app/working         主数据（config.json、profiles、workspaces 等）
  --   /app/working.secret  敏感配置（providers/*、active_model.json）
  -- 两个目录挂载在 emptyDir 上，Pod 重建（升级）后都会丢失；因此 preUpgrade
  -- 必须打包到 /backup，postUpgrade 解压回原位并调用 run-cmd.sh 重启 app。
  -- /app/working.backups 是运行期产生的临时/历史备份，可重建，跳过以缩小归档体积。
  jsonb_build_object(
    'timeoutSeconds', 60,
    'preUpgrade', jsonb_build_object(
      'command', jsonb_build_array(
        '/bin/bash',
        '-c',
$qp_pre$
set -euo pipefail

WORKING_DIR="/app/working"
SECRET_DIR="/app/working.secret"
BACKUP_ROOT="/backup"
BACKUP_ID="$(date -u +%Y%m%dT%H%M%SZ)-$$"
ARCHIVE="$BACKUP_ROOT/qwenpaw-state-$BACKUP_ID.tgz"

test -d "$BACKUP_ROOT"
test -d "$WORKING_DIR"
test -d "$SECRET_DIR"
# /app/working.backups 是 qwenpaw 运行期产生的临时/历史备份，跳过以缩小归档体积。
tar -czf "$ARCHIVE" -C /app working working.secret
test -s "$ARCHIVE"
$qp_pre$
      )
    ),
    'postUpgrade', jsonb_build_object(
      'command', jsonb_build_array(
        '/bin/bash',
        '-c',
$qp_post$
set -euo pipefail

WORKING_DIR="/app/working"
SECRET_DIR="/app/working.secret"
BACKUP_ROOT="/backup"
ARCHIVE="$(ls -1t "$BACKUP_ROOT"/qwenpaw-state-*.tgz 2>/dev/null | head -n 1 || true)"
if [ -z "$ARCHIVE" ] && [ -f "$BACKUP_ROOT/qwenpaw-state.tgz" ]; then
  ARCHIVE="$BACKUP_ROOT/qwenpaw-state.tgz"
fi

test -n "$ARCHIVE"
test -f "$ARCHIVE"
mkdir -p "$WORKING_DIR" "$SECRET_DIR"
# emptyDir 在新 Pod 里是空目录，兜底清理残留再解压避免半旧半新。
find "$WORKING_DIR" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
find "$SECRET_DIR" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
tar -xzf "$ARCHIVE" -C /app
test -f "$WORKING_DIR/config.json"
chown -R "$(id -u):$(id -g)" "$WORKING_DIR" "$SECRET_DIR"

# qwenpaw app 由镜像内置 supervisord 托管，通过 run-cmd.sh 两层兑底重启：
#   1) supervisorctl restart app（自动查找 socket）
#   2) 失败时按端口 8088 反查 pid + SIGTERM，靠 autorestart 拉起
if [ -x /usr/local/bin/run-cmd.sh ]; then
  bash /usr/local/bin/run-cmd.sh restart || true
fi
$qp_post$
      )
    )
  ),
  -- supports_channels=false：本期不支持渠道；前端隐藏渠道 Tab。
  false,
  'root',
  true,
  3,
  -- modify_model_command：用户在平台切换模型时调用。
  '#!/bin/bash
set -e
export _QP_BAILIAN_KEY="${DASHSCOPE_API_KEY}"
export _QP_GATEWAY_KEY="${CONSUMER_API_KEY}"
export _QP_LITELLM_KEY="${LITELLM_API_KEY}"
export _QP_GATEWAY_URL="http://${AI_GATEWAY_DOMAIN}/v1"
export _QP_LITELLM_URL="${LITELLM_PROXY_URL}"

bash /usr/local/bin/run-cmd.sh write-model "${MODEL_PROVIDER}" "${MODEL_NAME}"
bash /usr/local/bin/run-cmd.sh restart
',
  -- modify_channel_command：NULL → 后端拒绝渠道修改请求 / 前端禁用入口。
  NULL
)
ON CONFLICT (code) DO UPDATE SET
  name                   = EXCLUDED.name,
  description            = EXCLUDED.description,
  icon                   = EXCLUDED.icon,
  category               = EXCLUDED.category,
  sandbox_template_id    = EXCLUDED.sandbox_template_id,
  sandbox_timeout        = EXCLUDED.sandbox_timeout,
  config_template        = EXCLUDED.config_template,
  config_write_path      = EXCLUDED.config_write_path,
  startup_command        = EXCLUDED.startup_command,
  readiness_check        = EXCLUDED.readiness_check,
  -- upgrade_metadata 仅在数据库尚未写入有效 hook 或仍为旧版本模板时才覆盖，
  -- 避免覆盖管理员在 UI 中手工维护的自定义 pre/post hook。
  upgrade_metadata       = CASE
    WHEN agent_types.upgrade_metadata IS NULL
      OR agent_types.upgrade_metadata = '{}'::jsonb
      OR agent_types.upgrade_metadata #> '{preUpgrade,command}' IS NULL
      OR agent_types.upgrade_metadata #> '{postUpgrade,command}' IS NULL
      OR agent_types.upgrade_metadata::text LIKE '%/backup/qwenpaw-state.tgz%'
      OR agent_types.upgrade_metadata::text LIKE '%api-upgrade-%'
      OR agent_types.upgrade_metadata::text LIKE '%/tmp/api-%'
    THEN EXCLUDED.upgrade_metadata
    ELSE agent_types.upgrade_metadata
  END,
  supports_channels      = EXCLUDED.supports_channels,
  sandbox_user           = EXCLUDED.sandbox_user,
  is_enabled             = EXCLUDED.is_enabled,
  sort_order             = EXCLUDED.sort_order,
  modify_model_command   = EXCLUDED.modify_model_command,
  modify_channel_command = EXCLUDED.modify_channel_command;

-- =====================================================
-- 迁移完成
-- =====================================================
