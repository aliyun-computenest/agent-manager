import { describe, expect, it } from 'vitest'
import { getDefaultUpgradeCommandText, getDefaultUpgradeTimeoutSeconds } from '../../src/lib/upgradeDefaults'

describe('getDefaultUpgradeCommandText', () => {
  it('returns OpenClaw backup hooks for openclaw agent types', () => {
    const pre = getDefaultUpgradeCommandText({ code: 'openclaw' }, 'pre')
    expect(pre).toContain('openclaw-state-$BACKUP_ID.tgz')
    expect(pre).toContain('[openclaw-upgrade][pre]')
    expect(pre).toContain('supervisorctl stop openclaw')
    expect(pre).toContain('restart_on_error')
    expect(pre).toContain('backup failed: status=$status; restarting openclaw on old pod')
    expect(pre).toContain('--warning=no-file-changed')
    expect(pre).toContain('TAR_STATUS')
    expect(pre).toContain("--exclude='.openclaw/devices'")
    expect(pre).toContain("--exclude='.openclaw/identity/device-auth.json'")
    const post = getDefaultUpgradeCommandText({ code: 'openclaw' }, 'post')
    expect(post).toContain('openclaw-state-*.tgz')
    expect(post).toContain('[openclaw-upgrade][post]')
    expect(post).toContain('mktemp -d')
    expect(post).toContain('test -f "$RESTORED_HOME/openclaw.json"')
    expect(post).toContain('test -f "$RESTORED_HOME/.env"')
    expect(post).not.toContain('rm -rf /home/node/.openclaw/devices')
    expect(post).not.toContain('rm -f /home/node/.openclaw/identity/device-auth.json')
    expect(post).toContain('supervisorctl restart openclaw')
    expect(getDefaultUpgradeTimeoutSeconds({ code: 'openclaw' })).toBe(300)
  })

  it('returns Hermes backup hooks for hermes agent types', () => {
    expect(getDefaultUpgradeCommandText({ code: 'hermes' }, 'pre')).toContain('HERMES_DATA_DIR="/opt/data"')
    expect(getDefaultUpgradeCommandText({ code: 'hermes' }, 'pre')).toContain('hermes-state-$BACKUP_ID.tgz')
    expect(getDefaultUpgradeCommandText({ code: 'hermes' }, 'post')).toContain('hermes-state-*.tgz')
    expect(getDefaultUpgradeCommandText({ code: 'hermes' }, 'post')).toContain('supervisorctl restart hermes')
    expect(getDefaultUpgradeCommandText({ code: 'hermes' }, 'post')).not.toContain('mv "$HERMES_DATA_DIR"')
    expect(getDefaultUpgradeTimeoutSeconds({ code: 'hermes' })).toBe(60)
  })

  it('returns QwenPaw backup hooks for qwenpaw agent types', () => {
    const pre = getDefaultUpgradeCommandText({ code: 'qwenpaw' }, 'pre')
    expect(pre).toContain('WORKING_DIR="/app/working"')
    expect(pre).toContain('SECRET_DIR="/app/working.secret"')
    expect(pre).toContain('qwenpaw-state-$BACKUP_ID.tgz')
    expect(pre).toContain('tar -czf "$ARCHIVE" -C /app working working.secret')
    // /app/working.backups 是 qwenpaw 运行期产生的可重建备份，不应被 tar 打进归档。
    // 仅针对实际的 tar 命令做断言，避免误伤注释/文档说明。
    const tarLine = pre.split('\n').find(line => line.trim().startsWith('tar ')) || ''
    expect(tarLine).not.toContain('working.backups')

    const post = getDefaultUpgradeCommandText({ code: 'qwenpaw' }, 'post')
    expect(post).toContain('qwenpaw-state-*.tgz')
    expect(post).toContain('tar -xzf "$ARCHIVE" -C /app')
    expect(post).toContain('test -f "$WORKING_DIR/config.json"')
    expect(post).toContain('bash /usr/local/bin/run-cmd.sh restart')
  })

  it('does not auto-fill hooks for unknown agent types', () => {
    expect(getDefaultUpgradeCommandText({ code: 'custom' }, 'pre')).toBe('')
    expect(getDefaultUpgradeCommandText({ code: 'custom' }, 'post')).toBe('')
  })
})
