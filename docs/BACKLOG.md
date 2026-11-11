# Backlog

Itens explicitamente fora do MVP não entram nesta implementação. Rever os direitos da arte antes de distribuição pública.

## Pendências do MVP

- Validar o orquestrador com Claude e Codex reais: dois workers, um pedido de permissão e um pouso (hoje só há testes automatizados com repositório temporário).
- Confirmar que o Claude aceita `--permission-prompts none` na versão instalada.
- Retomada de worker Codex: usar o ID de thread em vez de reexecutar o brief.
- Fluxo de aprovação do Codex via app-server, equivalente ao do Claude.
- RAM ociosa medida em 200–230 MB (meta 150 MB); investigar o piso do WebView2 e adiar o xterm até o primeiro terminal visível.
- Medir backpressure do PTY com 5+ terminais ativos.
- Testar os instaladores NSIS/MSI em máquina limpa.
- Tema salvo apenas em `localStorage`; mover para `preferences.json` com migração.
- Editor MCP edita o arquivo inteiro; falta formulário por servidor.
- Subagentes nativos do Claude/Codex no board (só se for trivial detectar).

## Fora do escopo (ideias)

Plugins/catálogo, sync em nuvem, controle remoto LAN, Pomodoro/todos, painéis Markdown, outros idiomas, outros agentes, handoff entre agentes, PR review com `gh`, auto-update, contas, telemetria.
