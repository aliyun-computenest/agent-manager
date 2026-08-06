#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import { resolveInputPath } from './lib/path-guard.mjs'

const stageOrder = [
  'clarify',
  'dev_orchestration',
  'env_prepare',
  'develop',
  'test_unit',
  'deploy_ephemeral',
  'test_api',
  'test_e2e',
  'integration_live',
  'code_review',
  'deploy',
]

function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--input') {
      args.input = argv[i + 1]
      i += 1
    } else if (arg === '--work-item') {
      args.workItem = argv[i + 1]
      i += 1
    } else if (arg === '--agent') {
      args.agent = argv[i + 1]
      i += 1
    } else if (arg === '--agent-id') {
      args.agentId = argv[i + 1]
      i += 1
    } else if (arg === '--task-id') {
      args.taskId = argv[i + 1]
      i += 1
    } else if (arg === '--report-task-id') {
      args.reportTaskId = argv[i + 1]
      i += 1
    } else if (arg === '--help' || arg === '-h') {
      args.help = true
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }
  return args
}

async function readJson(path) {
  if (!path) throw new Error('JSON path is required')
  return JSON.parse(await readFile(resolveInputPath(path), 'utf8'))
}

function unwrapWorkItem(payload) {
  return payload?.workItem || payload
}

function unwrapAgent(payload) {
  return payload?.agent || payload?.currentAgent || payload
}

function agentIdFrom(agent, explicitAgentId) {
  return explicitAgentId
    || agent?.agentId
    || agent?.id
}

function workItemAssigneeId(workItem) {
  return workItem?.assigneeAgentId || workItem?.assigneeAgent?.id || null
}

function tasksFor(workItem) {
  return Array.isArray(workItem?.tasks) ? workItem.tasks : []
}

function selectedTask(workItem, taskId) {
  const tasks = tasksFor(workItem)
  if (taskId) return tasks.find((task) => task.id === taskId) || null
  return tasks.find((task) => task.status !== 'done') || null
}

function shellArg(value) {
  return `'${String(value).replaceAll("'", "'\"'\"'")}'`
}

function safeIdentifier(value, label) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._:@/-]+$/.test(value)) {
    throw new Error(`${label} contains unsafe characters: ${JSON.stringify(value)}`)
  }
  return value
}

function commandTaskId(task, fallback = '<task_id>') {
  return task?.id || fallback
}

async function loadInputs(args) {
  if (args.input) {
    const input = await readJson(args.input)
    return {
      workItem: unwrapWorkItem(input),
      agent: unwrapAgent(input),
    }
  }

  if (!args.workItem) throw new Error('--work-item is required unless --input is provided')
  return {
    workItem: unwrapWorkItem(await readJson(args.workItem)),
    agent: args.agent ? unwrapAgent(await readJson(args.agent)) : {},
  }
}

function readyResult({ workItem, agentId, task }) {
  const taskId = task?.id ? safeIdentifier(task.id, 'task id') : null
  return {
    schemaVersion: '1.0',
    status: 'ready',
    workItemId: workItem.id,
    taskId,
    currentAgentId: agentId,
    assignedAgentId: workItemAssigneeId(workItem),
    taskAgentId: task?.agentId || null,
    taskUpdateAllowed: true,
    nextCommands: {
      startTask: taskId ? `harness task update ${shellArg(taskId)} in_progress` : null,
      log: taskId ? `harness log ${shellArg(taskId)} ${shellArg('platform readiness passed for current agent')}` : null,
    },
  }
}

function completeResult({ workItem, agentId, task = null }) {
  return {
    schemaVersion: '1.0',
    status: 'already_complete',
    workItemId: workItem.id,
    taskId: task?.id || null,
    currentAgentId: agentId,
    assignedAgentId: workItemAssigneeId(workItem),
    taskAgentId: task?.agentId || null,
    taskUpdateAllowed: false,
    reason: task
      ? `Task ${task.id} is already done and should not be updated again.`
      : 'Work item is already done and has no pending task to update.',
  }
}

function blockedStagesAfter(task) {
  const currentStage = task?.type || task?.stage
  const index = stageOrder.indexOf(currentStage)
  return index >= 0 ? stageOrder.slice(index + 1) : stageOrder
}

function blockedResult({ workItem, agentId, task, reportTaskId, reasons }) {
  const targetTaskId = task?.id ? safeIdentifier(commandTaskId(task), 'task id') : '<task_id>'
  const safeWorkItemId = safeIdentifier(workItem.id, 'work item id')
  const safeReportTaskId = reportTaskId
    ? safeIdentifier(reportTaskId, 'report task id')
    : targetTaskId
  const reason = reasons.join('; ')
  const waitingOutput = {
    state: 'awaiting_human',
    waitType: 'approval',
    reason,
    resumeCriteria: 'Harness owner reassigns the work item to the current agent, grants assign/swap capability, or confirms that the assigned agent will continue the work.',
    blockedNextStages: blockedStagesAfter(task),
  }
  const blockerMessage = `等待平台指派/权限确认：${reason}`
  const askQuestion = '当前 work item 不属于当前 agent，下一步如何处理？'

  return {
    schemaVersion: '1.0',
    status: 'awaiting_human',
    workItemId: workItem.id,
    taskId: task?.id || null,
    currentAgentId: agentId,
    assignedAgentId: workItemAssigneeId(workItem),
    taskAgentId: task?.agentId || null,
    taskUpdateAllowed: false,
    reasons,
    waitingOutput,
    platformAcceptance: {
      status: 'evidence_boundary',
      claimedPlatformComplete: false,
      reason: 'Current agent cannot prove it can update the target Harness work item/task.',
      missingInputs: [
        'work item reassignment',
        'assign/swap capability',
        'assigned agent continuation',
      ],
    },
    reportingCommands: {
      blockerMilestone: `harness milestone blocker ${shellArg(safeReportTaskId)} ${shellArg(blockerMessage)} --require-ack`,
      taskUpdate: `harness task update ${shellArg(safeReportTaskId)} in_progress --output ${shellArg(JSON.stringify(waitingOutput))}`,
      ask: `harness ask ${shellArg(safeWorkItemId)} --task-id ${shellArg(safeReportTaskId)} --question ${shellArg(askQuestion)} --option ${shellArg('id=reassign;label=重新指派给当前 agent;recommended')} --option ${shellArg('id=assigned_agent_continue;label=由已分配 agent 继续')} --option ${shellArg('id=grant_assign;label=授予 assign/swap 权限')}`,
    },
  }
}

function evaluate({ workItem, agentId, task, taskId, reportTaskId }) {
  if (!workItem?.id) throw new Error('work item id is required')
  if (!agentId) throw new Error('current agent id is required; pass --agent-id or --agent')
  safeIdentifier(workItem.id, 'work item id')
  safeIdentifier(agentId, 'current agent id')
  if (taskId) safeIdentifier(taskId, 'task id')

  const reasons = []
  const tasks = tasksFor(workItem)
  if (taskId && !task) {
    reasons.push(`task ${taskId} is not present on work item ${workItem.id}`)
  } else if (task?.status === 'done') {
    return completeResult({ workItem, agentId, task })
  } else if (!task && (workItem.status === 'done' || (tasks.length > 0 && tasks.every((item) => item.status === 'done')))) {
    return completeResult({ workItem, agentId })
  }

  const assignedAgentId = workItemAssigneeId(workItem)
  if (!assignedAgentId) {
    reasons.push(`work item ${workItem.id} has no assigneeAgentId`)
  } else if (assignedAgentId !== agentId) {
    reasons.push(`work item ${workItem.id} is assigned to ${assignedAgentId}, current agent is ${agentId}`)
  }

  if (task?.agentId && task.agentId !== agentId) {
    reasons.push(`task ${task.id} is assigned to ${task.agentId}, current agent is ${agentId}`)
  }

  if (!task && tasks.length === 0) {
    reasons.push(`work item ${workItem.id} has no tasks to update`)
  } else if (!task) {
    reasons.push(`work item ${workItem.id} has no pending task while status is ${workItem.status || 'unknown'}`)
  }

  return reasons.length === 0
    ? readyResult({ workItem, agentId, task })
    : blockedResult({ workItem, agentId, task, reportTaskId, reasons })
}

function printHelp() {
  console.log(`Usage:
  node harness/scripts/check-platform-readiness.mjs --input <combined.json> [--task-id <id>] [--report-task-id <id>]
  node harness/scripts/check-platform-readiness.mjs --work-item <work-item.json> --agent <agent.json> [--agent-id <id>]

Checks whether the current Harness CLI agent can safely update the target work
item/task. The command is read-only and never calls the Harness platform.`)
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    printHelp()
    return
  }

  const { workItem, agent } = await loadInputs(args)
  const agentId = agentIdFrom(agent, args.agentId)
  const task = selectedTask(workItem, args.taskId)
  const result = evaluate({ workItem, agentId, task, taskId: args.taskId, reportTaskId: args.reportTaskId })
  console.log(JSON.stringify(result, null, 2))
  if (result.status === 'awaiting_human') process.exitCode = 2
}

main().catch((error) => {
  console.error(error.message)
  process.exitCode = 1
})
