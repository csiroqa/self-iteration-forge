/**
 * DSH 宿主已有工具名清单。
 *
 * 用途：forge 产出的插件若注册与宿主已有工具同名的工具，跨 scope 注册
 * 不报错（dsh-tools 只拦截同 scope 重名），但模型侧按 agent 视角解析时
 * 会发生遮蔽（机制确认：dsh-tools ToolLayer 的 per-agent 提示分支）。
 *
 * 来源：当前 DSH base bundle + self-iteration-forge 注册的工具名（agent 可见
 * 工具列表）。随 DSH 版本更新需同步：新增内置工具时在此追加。
 * 注意：只列宿主真实工具，不含 forge 产物（如验证用的 probe-echo）。
 */
export const BUILTIN_TOOL_NAMES: ReadonlySet<string> = new Set([
  'ask_user_question',
  'create_goal',
  'edit',
  'exit_plan_mode',
  'forge_capability',
  'get_goal',
  'glob',
  'grep',
  'interrupt_agent',
  'job_kill',
  'job_list',
  'job_output',
  'list_agents',
  'pwsh',
  'ralph',
  'read',
  'read_image',
  'send_message',
  'skill',
  'subagent',
  'subagent_fork',
  'todo_write',
  'update_goal',
  'web_search',
  'workflow',
  'write',
])
