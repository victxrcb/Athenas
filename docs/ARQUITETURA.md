# Arquitetura

F0: React renderiza a Home em um WebView Tauri. O plugin de diálogo escolhe pastas locais e a API da janela controla a barra personalizada. Assets são gerados no build e distribuídos com o app.

F1: `terminal_start` abre um ConPTY pelo `portable-pty`; uma thread lê a saída e um canal limitado aplica backpressure. Outra thread grava lotes de até 64 KB em disco e emite eventos Tauri a cada ~16 ms. A UI só monta xterm para a sessão visível. Ao voltar, lê o scrollback de até 5 MB e recebe os eventos novos. A F2 guarda metadados em SQLite (WAL, migrations versionadas); após reiniciar o app, Claude usa `--resume <uuid>` e Codex abre seu seletor com `codex resume`.

F4: o executável também opera como servidor MCP stdio. Ferramentas `hera_*` gravam solicitações em `orchestrator.sqlite3` (WAL). O gerente do app consome a fila e executa workers em PTYs isolados por git worktree; cada worker grava resultado, diff, outcome e transcript em disco. O board lê o mesmo banco. O líder recebe resultado e resumo do diff pelo MCP, sem transcript. Aterrissagem confere estado da base, faz commit e merge, então remove o worktree.
