# Hera Agent

App desktop local para organizar agentes de código. A fase F0 contém a Home, a identidade visual e o formulário de nova sessão. PTYs reais começam na F1.

## Rodar

Requer Node.js, Rust estável e as dependências do Tauri 2 para Windows (WebView2 e ferramentas C++).

```powershell
npm.cmd install
npm.cmd run app
```

`npm.cmd run build` compila o frontend. `npm.cmd test` e `npm.cmd run e2e` executam os testes. Para gerar os assets novamente: `node scripts/generate-brand.mjs`.

A arte de origem é de um item de terceiros do Steam Workshop. Revise os direitos antes de distribuir publicamente.
