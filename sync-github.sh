#!/usr/bin/env bash
#
# sync-github.sh — 将本地分支以「单 commit、无历史」的方式同步到 GitHub 公开仓库，
# 并在推送前自动剔除不应公开的内网文件 / 密钥 / 内部设计文档。
#
# 与镜像完整历史不同，本脚本使用孤儿分支（orphan branch）产出一个全新的、
# 不含任何父提交的干净快照。这样即使敏感文件曾出现在历史 commit 中，
# 也不会被推送到公开仓库，从根本上切断历史泄露。
#
# 工作原理：
#   1. 基于当前（或指定）分支创建一个孤儿分支（无父提交）
#   2. 在孤儿分支上删除 EXCLUDES 列表中的路径
#   3. 将剩余内容作为单个全新 commit 提交
#   4. 将该孤儿分支 force push 到 GitHub 的目标分支
#   5. 切回原分支并删除临时孤儿分支
#
# 本地分支与 GitLab origin 完全不受影响。
#
# 用法：
#   ./sync-github.sh                  # 同步当前分支到 GitHub master（单 commit）
#   ./sync-github.sh -b develop       # 同步本地 develop
#   ./sync-github.sh -t main          # 推送到 GitHub 的 main 分支
#   ./sync-github.sh -n               # dry-run，只打印将执行的动作，不实际推送

set -euo pipefail

# ---- 配置区：需要从 GitHub 公开仓库中排除的路径（相对仓库根目录）----
# 包含：真实密钥/证书、内网 CI 配置、内部研发流程与设计文档。
EXCLUDES=(
  "agent-manager/.env.pre"
  "agent-manager/.env.production"
  "agent-manager/.env.test.pre"
  "agent-manager/data/ca-fullchain.pem"
  ".aoneci"
  "docs/design"
  "docs/DEVELOPMENT_GUIDE.md"
  "docs/observability-auto-integration-design.md"
)

# ---- 默认参数 ----
GITHUB_REMOTE="github"
GITHUB_REMOTE_URL="https://github.com/aliyun-computenest/agent-manager.git"
SOURCE_BRANCH=""
TARGET_BRANCH="master"
DRY_RUN="false"
TMP_BRANCH="tmp-github-sync-$$"
COMMIT_MESSAGE="chore: public release snapshot"

usage() {
  awk '
    NR == 1 { next }
    /^#/ {
      sub(/^# ?/, "")
      print
      next
    }
    { exit }
  ' "$0"
  exit 0
}

while getopts "b:t:r:m:nh" opt; do
  case "$opt" in
    b) SOURCE_BRANCH="$OPTARG" ;;
    t) TARGET_BRANCH="$OPTARG" ;;
    r) GITHUB_REMOTE="$OPTARG" ;;
    m) COMMIT_MESSAGE="$OPTARG" ;;
    n) DRY_RUN="true" ;;
    h) usage ;;
    *) usage ;;
  esac
done

log() {
  printf '\033[1;34m[sync-github]\033[0m %s\n' "$*"
}

err() {
  printf '\033[1;31m[sync-github][error]\033[0m %s\n' "$*" >&2
}

# 必须在 git 仓库内执行
if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  err "当前目录不是 git 仓库"
  exit 1
fi

# 工作区必须干净，避免误带未提交改动
if [ -n "$(git status --porcelain)" ]; then
  err "工作区存在未提交的改动，请先提交或清理后再同步"
  git status --short | cat
  exit 1
fi

# 确定要同步的源分支
if [ -z "$SOURCE_BRANCH" ]; then
  SOURCE_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
fi
log "源分支：$SOURCE_BRANCH  ->  GitHub $GITHUB_REMOTE/$TARGET_BRANCH（单 commit、无历史）"

# 确保 GitHub 远程存在
if ! git remote get-url "$GITHUB_REMOTE" >/dev/null 2>&1; then
  log "未找到远程 '$GITHUB_REMOTE'，自动添加：$GITHUB_REMOTE_URL"
  git remote add "$GITHUB_REMOTE" "$GITHUB_REMOTE_URL"
fi

ORIGINAL_BRANCH="$(git rev-parse --abbrev-ref HEAD)"

# 任何退出路径都尽量恢复到原分支并清理临时分支
cleanup() {
  local current
  current="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo '')"
  if [ "$current" = "$TMP_BRANCH" ]; then
    git checkout -f "$ORIGINAL_BRANCH" >/dev/null 2>&1 || true
  fi
  if git show-ref --verify --quiet "refs/heads/$TMP_BRANCH"; then
    git branch -D "$TMP_BRANCH" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

# 1. 基于源分支内容创建孤儿分支（无父提交，从而无历史）
git checkout --orphan "$TMP_BRANCH" "$SOURCE_BRANCH" >/dev/null
log "已创建孤儿分支：$TMP_BRANCH（无父提交）"

# 2. 删除排除路径（从暂存区移除并删除工作区文件）
for path in "${EXCLUDES[@]}"; do
  if git ls-files --error-unmatch -- "$path" >/dev/null 2>&1; then
    git rm -r --cached --quiet -- "$path"
    rm -rf "$path"
    log "已剔除：$path"
  elif [ -e "$path" ]; then
    rm -rf "$path"
    log "已剔除（未跟踪但存在）：$path"
  else
    log "跳过（不存在）：$path"
  fi
done

# 3. 作为单个全新 commit 提交
git commit -q -m "$COMMIT_MESSAGE"
log "已生成单 commit 快照：$(git rev-parse --short HEAD)"

# 推送前自检：确认敏感文件确实不在本次快照中
log "推送前自检（确认敏感路径已剔除）："
self_check_failed="false"
for path in "${EXCLUDES[@]}"; do
  if git ls-files --error-unmatch -- "$path" >/dev/null 2>&1; then
    err "  ✗ 仍存在于快照：$path"
    self_check_failed="true"
  fi
done
if [ "$self_check_failed" = "true" ]; then
  err "自检未通过，已中止推送。请检查 EXCLUDES 配置。"
  exit 1
fi
log "  ✓ 所有排除路径均已不在快照中"

# 4. force push 到 GitHub（孤儿分支覆盖目标分支，目标端也将只有这一个 commit）
if [ "$DRY_RUN" = "true" ]; then
  log "[dry-run] 将执行：git push $GITHUB_REMOTE $TMP_BRANCH:$TARGET_BRANCH --force"
  log "[dry-run] 本次快照包含 $(git ls-files | wc -l | tr -d ' ') 个文件"
else
  log "推送到 GitHub..."
  git push "$GITHUB_REMOTE" "$TMP_BRANCH:$TARGET_BRANCH" --force
  log "推送完成"
fi

# 5. cleanup 由 trap 处理
log "完成：本地 $ORIGINAL_BRANCH 与 GitLab origin 未受影响"
