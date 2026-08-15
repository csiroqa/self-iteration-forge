/**
 * DSH 宿主内置工具名清单。
 *
 * 用途：forge 产出的插件若注册与内置工具同名的工具，跨 scope 注册不报错
 * （dsh-tools 只拦截同 scope 重名），但模型侧按 agent 视角解析时会发生
 * 遮蔽——真实事故：probe_echo 与内置 probe_echo 同名，热挂载"成功"，
 * 实际调用命中的是内置版本。
 *
 * 来源：当前 DSH base bundle 注册的工具名（agent 可见工具列表）。
 * 随 DSH 版本更新需同步：新增内置工具时在此追加；同步义务见 prompt.ts
 * 与 verify-load.ts 的引用处。
 */
export const BUILTIN_TOOL_NAMES: ReadonlySet<string> = new Set([
  'ask_user_question',
  'code_review',
  'create_goal',
  'edit',
  'exit_plan_mode',
  'forge_plugin',
  'get_goal',
  'glob',
  'grep',
  'hotprobe_ping',
  'interrupt_agent',
  'job_kill',
  'job_list',
  'job_output',
  'list_agents',
  'probe_echo',
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
