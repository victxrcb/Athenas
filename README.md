# Athenas Agent

App desktop local para organizar agentes de código. A Home e o núcleo de PTY estão implementados. A organização em grupos e projetos está em desenvolvimento; veja [docs/F1.md](docs/F1.md) e [docs/F2.md](docs/F2.md).

## Rodar

Requer Node.js, Rust estável e as dependências do Tauri 2 para Windows (WebView2 e ferramentas C++).

```powershell
npm.cmd install
npm.cmd run app
```

`npm.cmd run build` compila o frontend. `npm.cmd test` e `npm.cmd run e2e` executam os testes. Para gerar os assets novamente: `node scripts/generate-brand.mjs`. Use o modal **Nova sessão** para iniciar Claude Code, Codex ou PowerShell numa pasta existente. Sessões Claude encerradas podem ser retomadas pelo UUID; `codex resume` abre o seletor do Codex.

A arte de origem é de um item de terceiros do Steam Workshop. Revise os direitos antes de distribuir publicamente.
