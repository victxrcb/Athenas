/** Slash commands offered by the composer. `terminal` ones open a menu that only the terminal can drive. */
export type SlashCommand = { name: string; detail: string; terminal?: boolean };

const CLAUDE: SlashCommand[] = [
  { name: 'clear', detail: 'Começar uma conversa nova' },
  { name: 'compact', detail: 'Resumir a conversa para liberar contexto' },
  { name: 'context', detail: 'Uso da janela de contexto', terminal: true },
  { name: 'cost', detail: 'Custo da sessão', terminal: true },
  { name: 'model', detail: 'Trocar o modelo', terminal: true },
  { name: 'effort', detail: 'Nível de raciocínio', terminal: true },
  { name: 'init', detail: 'Criar o CLAUDE.md do projeto' },
  { name: 'review', detail: 'Revisar um pull request' },
  { name: 'memory', detail: 'Editar a memória', terminal: true },
  { name: 'permissions', detail: 'Regras de permissão', terminal: true },
  { name: 'resume', detail: 'Retomar outra conversa', terminal: true },
  { name: 'status', detail: 'Estado da sessão', terminal: true },
];
const CODEX: SlashCommand[] = [
  { name: 'new', detail: 'Começar uma conversa nova' },
  { name: 'compact', detail: 'Resumir a conversa para liberar contexto' },
  { name: 'model', detail: 'Modelo e nível de raciocínio', terminal: true },
  { name: 'approvals', detail: 'Modo de aprovação', terminal: true },
  { name: 'diff', detail: 'Mostrar o diff atual', terminal: true },
  { name: 'init', detail: 'Criar o AGENTS.md do projeto' },
  { name: 'review', detail: 'Revisar alterações', terminal: true },
  { name: 'status', detail: 'Estado da sessão', terminal: true },
];

export function slashCommands(agent: string, custom: string[] = []): SlashCommand[] {
  if (agent === 'Codex') return CODEX;
  return [...CLAUDE, ...custom.filter((name) => !CLAUDE.some((item) => item.name === name)).map((name) => ({ name, detail: 'Comando personalizado' }))];
}

export const needsTerminal = (agent: string, message: string) => {
  const name = /^\/([\w:-]+)\s*$/.exec(message.trim())?.[1];
  return Boolean(name && slashCommands(agent).find((item) => item.name === name)?.terminal);
};
