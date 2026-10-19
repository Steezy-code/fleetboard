import type { AgentDef } from './types'

// Catalog of terminal coding agents. Each runs as its real interactive CLI in a PTY.
// resumeArgs: the CLI's native "pick up the last conversation" flags.
// session: start a conversation under an id Fleetboard picks, and resume exactly that one later.
// yoloArgs: the CLI's auto-approval flag, only used when the global opt-in is on.
export const AGENTS: AgentDef[] = [
  {
    id: 'claude', name: 'Claude Code', vendor: 'Anthropic', bin: 'claude', color: '#d97757',
    resumeArgs: ['--continue'], yoloArgs: ['--dangerously-skip-permissions'], editsArgs: ['--permission-mode', 'acceptEdits'], configEnv: 'CLAUDE_CONFIG_DIR',
    session: { start: (id) => ['--session-id', id], resume: (id) => ['--resume', id] },
    headless: (p) => ['-p', p], homepage: 'https://claude.com/product/claude-code',
    install: 'npm i -g @anthropic-ai/claude-code'
  },
  {
    id: 'codex', name: 'Codex', vendor: 'OpenAI', bin: 'codex', color: '#6b7cff',
    resumeArgs: ['resume', '--last'], yoloArgs: ['--dangerously-bypass-approvals-and-sandbox'], editsArgs: ['--full-auto'], configEnv: 'CODEX_HOME',
    headless: (p) => ['exec', '--skip-git-repo-check', p], homepage: 'https://openai.com/codex/', install: 'npm i -g @openai/codex'
  },
  {
    id: 'gemini', name: 'Gemini CLI', vendor: 'Google', bin: 'gemini', color: '#4f8df7',
    resumeArgs: ['--resume', 'latest'], yoloArgs: ['--yolo'], editsArgs: ['--approval-mode', 'auto_edit'], headless: (p) => ['-p', p],
    session: { start: (id) => ['--session-id', id], resume: (id) => ['--resume', id] },
    homepage: 'https://github.com/google-gemini/gemini-cli', install: 'npm i -g @google/gemini-cli'
  },
  { id: 'grok', name: 'Grok', vendor: 'xAI', bin: 'grok', color: '#e5e5e5', headless: (p) => ['-p', p], homepage: 'https://x.ai/' },
  {
    id: 'opencode', name: 'OpenCode', vendor: 'sst', bin: 'opencode', color: '#f5b740', resumeArgs: ['--continue'],
    headless: (p) => ['run', p], homepage: 'https://opencode.ai', install: 'curl -fsSL https://opencode.ai/install | bash'
  },
  {
    id: 'aider', name: 'Aider', vendor: 'Aider', bin: 'aider', color: '#3ecf8e', resumeArgs: ['--restore-chat-history'],
    yoloArgs: ['--yes-always'], headless: (p) => ['--message', p, '--yes-always'], homepage: 'https://aider.chat'
  },
  { id: 'amp', name: 'Amp', vendor: 'Sourcegraph', bin: 'amp', color: '#ff5543', resumeArgs: ['threads', 'continue'], yoloArgs: ['--dangerously-allow-all'], headless: (p) => ['-x', p], homepage: 'https://ampcode.com' },
  { id: 'goose', name: 'Goose', vendor: 'Block', bin: 'goose', args: ['session'], color: '#a3a3a3', resumeArgs: ['-r'], headless: (p) => ['run', '-t', p], homepage: 'https://block.github.io/goose/' },
  { id: 'cline', name: 'Cline', vendor: 'Cline', bin: 'cline', color: '#60a5fa', homepage: 'https://cline.bot' },
  { id: 'cursor', name: 'Cursor CLI', vendor: 'Anysphere', bin: 'cursor-agent', color: '#d4d4d4', resumeArgs: ['resume'], yoloArgs: ['--force'], headless: (p) => ['-p', p], homepage: 'https://cursor.com/cli' },
  { id: 'copilot', name: 'Copilot CLI', vendor: 'GitHub', bin: 'copilot', color: '#8b5cf6', resumeArgs: ['--continue'], yoloArgs: ['--allow-all-tools'], headless: (p) => ['-p', p], homepage: 'https://github.com/features/copilot/cli' },
  { id: 'droid', name: 'Droid', vendor: 'Factory', bin: 'droid', color: '#f97316', headless: (p) => ['exec', p], homepage: 'https://factory.ai' },
  { id: 'crush', name: 'Crush', vendor: 'Charm', bin: 'crush', color: '#ec4899', yoloArgs: ['--yolo'], headless: (p) => ['run', p], homepage: 'https://github.com/charmbracelet/crush' },
  { id: 'codebuff', name: 'Codebuff', vendor: 'Codebuff', bin: 'codebuff', color: '#22c55e', homepage: 'https://www.codebuff.com' },
  { id: 'continue', name: 'Continue', vendor: 'Continue', bin: 'cn', color: '#e2e8f0', headless: (p) => ['-p', p], homepage: 'https://continue.dev' },
  { id: 'kilocode', name: 'Kilo Code', vendor: 'Kilo', bin: 'kilocode', color: '#facc15', homepage: 'https://kilocode.ai' },
  { id: 'qwen', name: 'Qwen Code', vendor: 'Alibaba', bin: 'qwen', color: '#7c3aed', yoloArgs: ['--yolo'], headless: (p) => ['-p', p], homepage: 'https://github.com/QwenLM/qwen-code' },
  { id: 'kimi', name: 'Kimi CLI', vendor: 'Moonshot', bin: 'kimi', color: '#38bdf8', homepage: 'https://github.com/MoonshotAI/kimi-cli' },
  { id: 'auggie', name: 'Auggie', vendor: 'Augment', bin: 'auggie', color: '#4ade80', headless: (p) => ['--print', p], homepage: 'https://www.augmentcode.com/product/CLI' },
  { id: 'q', name: 'Amazon Q', vendor: 'AWS', bin: 'q', args: ['chat'], color: '#a855f7', resumeArgs: ['--resume'], yoloArgs: ['--trust-all-tools'] },
  { id: 'kiro', name: 'Kiro CLI', vendor: 'AWS', bin: 'kiro-cli', args: ['chat'], color: '#9d6bff' },
  { id: 'jules', name: 'Jules', vendor: 'Google', bin: 'jules', color: '#818cf8' },
  { id: 'plandex', name: 'Plandex', vendor: 'Plandex', bin: 'plandex', color: '#14b8a6' },
  { id: 'gptme', name: 'gptme', vendor: 'gptme', bin: 'gptme', color: '#84cc16', headless: (p) => ['--non-interactive', p] },
  { id: 'openhands', name: 'OpenHands', vendor: 'All Hands', bin: 'openhands', color: '#fbbf24' },
  { id: 'ra-aid', name: 'RA.Aid', vendor: 'RA.Aid', bin: 'ra-aid', color: '#f87171' },
  { id: 'aichat', name: 'AIChat', vendor: 'sigoden', bin: 'aichat', color: '#2dd4bf', headless: (p) => [p] },
  { id: 'mods', name: 'Mods', vendor: 'Charm', bin: 'mods', color: '#f472b6', headless: (p) => [p] },
  { id: 'llm', name: 'LLM', vendor: 'Simon Willison', bin: 'llm', args: ['chat'], color: '#94a3b8' },
  { id: 'ollama', name: 'Ollama', vendor: 'Ollama', bin: 'ollama', args: ['run', 'llama3.2'], color: '#f5f5f4' },
  { id: 'open-interpreter', name: 'Open Interpreter', vendor: 'OI', bin: 'interpreter', color: '#facc15' },
  { id: 'warp', name: 'Warp Agent', vendor: 'Warp', bin: 'warp-cli', color: '#01a4ff' },
  { id: 'trae', name: 'Trae Agent', vendor: 'ByteDance', bin: 'trae-cli', color: '#ef4444' },
  { id: 'shell', name: 'Shell', vendor: 'Default', bin: '$SHELL', color: '#78716c' }
]

export const agentById = (id: string, custom: AgentDef[] = []): AgentDef | undefined =>
  AGENTS.find((a) => a.id === id) ?? custom.find((a) => a.id === id)

/** Names people say out loud for an agent, used by the voice / command parser. */
export const AGENT_ALIASES: Record<string, string> = {
  claude: 'claude', 'claude code': 'claude', clod: 'claude', cloud: 'claude', 'cloud code': 'claude',
  codex: 'codex', 'codecs': 'codex', 'code x': 'codex', gemini: 'gemini', 'gemini cli': 'gemini', grok: 'grok',
  opencode: 'opencode', 'open code': 'opencode', aider: 'aider', amp: 'amp', goose: 'goose', cline: 'cline',
  cursor: 'cursor', copilot: 'copilot', droid: 'droid', crush: 'crush', codebuff: 'codebuff', qwen: 'qwen',
  kimi: 'kimi', auggie: 'auggie', shell: 'shell', terminal: 'shell', bash: 'shell'
}
