# Arquitetura

F0: React renderiza a Home em um WebView Tauri. O plugin de diálogo escolhe pastas locais e a API da janela controla a barra personalizada. Assets são gerados no build e distribuídos com o app.

F1: `terminal_start` abre um ConPTY pelo `portable-pty`; uma thread lê a saída e um canal limitado aplica backpressure. Outra thread grava lotes de até 64 KB em disco e emite eventos Tauri a cada ~16 ms. A UI só monta xterm para a sessão visível. Ao voltar, lê o scrollback de até 5 MB e recebe os eventos novos. `sessions.json` guarda metadados e o UUID criado para Claude; após reiniciar o app, Claude usa `--resume <uuid>` e Codex abre seu seletor com `codex resume`. A F2 migra esses metadados para SQLite.

F4: um sidecar MCP local receberá delegações do líder, criará workers em worktrees e devolverá apenas artefatos resumidos ao líder.
