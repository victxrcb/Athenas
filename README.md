# Athenas Agent

App desktop local para organizar agentes de código em grupos e projetos, com terminais reais, ferramentas Git/MCP/Skills e board de orquestração. Veja [docs/F1.md](docs/F1.md), [docs/F2.md](docs/F2.md), [docs/F3.md](docs/F3.md) e [docs/F4.md](docs/F4.md) e [docs/F5.md](docs/F5.md) para as verificações e os limites atuais.

## Rodar

Requer Node.js, Rust estável e os [pré-requisitos do Tauri 2](https://v2.tauri.app/start/prerequisites/) do seu sistema: WebView2 e ferramentas C++ no Windows, Xcode Command Line Tools no macOS, WebKitGTK 4.1 no Linux.

```powershell
npm.cmd install
npm.cmd run app
```

`npm.cmd run build` compila o frontend. `npm.cmd test` e `npm.cmd run e2e` executam os testes. Para gerar os assets novamente: `node scripts/generate-brand.mjs`. Use o modal **Nova sessão** para iniciar Claude Code, Codex ou PowerShell numa pasta existente. Sessões Claude encerradas podem ser retomadas pelo UUID; `codex resume` abre o seletor do Codex.

## Instalador

```powershell
npm.cmd run tauri -- build
```

Gera em `src-tauri/target/release/bundle/`: NSIS e MSI no Windows, `.app` e `.dmg` no macOS, AppImage e `.deb` no Linux. Métricas e metas em [docs/F5.md](docs/F5.md).

A arte de origem é de um item de terceiros do Steam Workshop. Revise os direitos antes de distribuir publicamente.

## Licença

O código do Athenas Agent é distribuído sob a [licença MIT](LICENSE): você pode usar, modificar e redistribuir livremente, mantendo o aviso de copyright.

A licença MIT **não** cobre materiais de terceiros incluídos no projeto, como a arte de origem do Steam Workshop e logos/marcas de outros produtos (Claude, Codex, Spotify etc.), que continuam pertencendo aos respectivos donos.
