#!/usr/bin/env bash
#
# sync-github.sh — 将本地分支以「无内网历史的公开快照」方式同步到 GitHub 公开仓库，
# 并在推送前自动剔除不应公开的内网文件 / 密钥 / 内部设计文档。
#
# 首次同步使用孤儿分支产出不含内网历史的干净基线；后续同步基于 GitHub
# 目标分支追加一个新的公开快照提交。这样既不会推送内网提交历史，也能保留
# GitHub 公开仓库自身的版本演进记录。
#
# 工作原理：
#   1. 基于 GitHub 目标分支创建临时分支；首次同步时创建孤儿分支
#   2. 用当前（或指定）分支内容替换临时分支，并删除 EXCLUDES 列表中的路径
#   3. 将剩余内容作为单个全新 commit 提交
#   4. 将临时分支以 fast-forward 方式推送到 GitHub 目标分支
#   5. 切回原分支并删除临时分支
#
# 本地分支与 GitLab origin 完全不受影响。
#
# 用法：
#   ./sync-github.sh                  # 同步当前分支到 GitHub master（每次一个公开提交）
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
log "源分支：$SOURCE_BRANCH  ->  GitHub $GITHUB_REMOTE/${TARGET_BRANCH}（公开快照提交）"

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

# 1. 基于 GitHub 目标分支创建临时分支；目标分支不存在时创建孤儿分支
if git ls-remote --exit-code --heads "$GITHUB_REMOTE" "$TARGET_BRANCH" >/dev/null 2>&1; then
  git fetch --quiet "$GITHUB_REMOTE" "$TARGET_BRANCH:refs/remotes/$GITHUB_REMOTE/$TARGET_BRANCH"
  git checkout -b "$TMP_BRANCH" "$GITHUB_REMOTE/$TARGET_BRANCH" >/dev/null
  git rm -r --quiet .
  git checkout "$SOURCE_BRANCH" -- .
  log "已基于 $GITHUB_REMOTE/${TARGET_BRANCH} 创建临时分支：$TMP_BRANCH"
else
  git checkout --orphan "$TMP_BRANCH" "$SOURCE_BRANCH" >/dev/null
  log "GitHub 目标分支不存在，已创建孤儿分支：${TMP_BRANCH}（无父提交）"
fi

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

# 3. 作为一个公开快照 commit 提交
if git diff --cached --quiet; then
  log "公开快照没有变化，无需生成提交"
  SNAPSHOT_CHANGED="false"
else
  git commit -q -m "$COMMIT_MESSAGE"
  SNAPSHOT_CHANGED="true"
  log "已生成公开快照提交：$(git rev-parse --short HEAD)"
fi

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

# 4. fast-forward 推送到 GitHub，保留公开仓库自身历史
if [ "$SNAPSHOT_CHANGED" = "false" ]; then
  log "GitHub 目标分支已是最新公开快照"
elif [ "$DRY_RUN" = "true" ]; then
  log "[dry-run] 将执行：git push $GITHUB_REMOTE $TMP_BRANCH:$TARGET_BRANCH"
  log "[dry-run] 本次快照包含 $(git ls-files | wc -l | tr -d ' ') 个文件"
else
  log "推送到 GitHub..."
  git push "$GITHUB_REMOTE" "$TMP_BRANCH:$TARGET_BRANCH"
  log "推送完成"
fi

# 5. cleanup 由 trap 处理
log "完成：本地 $ORIGINAL_BRANCH 与 GitLab origin 未受影响"
