# Arquitetura

F0: React renderiza a Home em um WebView Tauri. O plugin de diálogo escolhe pastas locais e a API da janela controla a barra personalizada. Assets são gerados no build e distribuídos com o app.

F1: comandos Tauri criarão PTYs Rust; eventos em lotes (~16 ms) alimentarão xterm.js. O buffer ficará em arquivo por sessão.

F4: um sidecar MCP local receberá delegações do líder, criará workers em worktrees e devolverá apenas artefatos resumidos ao líder.
