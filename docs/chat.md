# Chat dos agentes

O chat é uma segunda leitura da mesma sessão de terminal. Ele não inicia, reinicia nem encerra processos, e alternar entre Chat, Terminal e Dividido só muda o que está na tela. Sessões Shell continuam apenas com terminal.

## De onde vêm os dados

| Informação | Claude Code | Codex |
|---|---|---|
| Histórico (mensagens, ferramentas, resultados, diffs) | `~/.claude/projects/**/<id>.jsonl` | `~/.codex/sessions/**/rollout-*.jsonl` |
| Texto em streaming | hook `MessageDisplay` | não disponível: a mensagem aparece quando é gravada |
| Ferramenta em andamento | hooks `PreToolUse` / `PostToolUse` | aparece quando termina |
| Aprovações e perguntas | hook `PermissionRequest`, respondidas no chat | aviso no chat, resposta no terminal |
| Envio e interrupção | digitados no PTY (colagem delimitada + Enter, Esc) | igual |

- Backend: `src-tauri/src/chat.rs` (vínculo, leitura incremental, envio, arquivos) e `src-tauri/src/live.rs` (fila dos hooks e permissões).
- Frontend: `src/chat/`. `claudeAdapter.ts` e `codexAdapter.ts` convertem cada formato para o modelo de `model.ts`; `store.ts` é a única fonte para chat, vista dividida e Mapeamento.
- Os formatos dos arquivos JSONL são internos dos CLIs e podem mudar. Registros desconhecidos são ignorados e o terminal continua mostrando a saída completa.

Verificado com Claude Code 2.1.332 (hooks reais no TUI) e com arquivos do Codex 0.166 a 0.172.

## Permissões

O diálogo do terminal continua aparecendo enquanto o hook espera. A primeira resposta vale; respondendo pelo terminal, o Claude Code encerra o hook e o cartão some do chat. Sem decisão explícita o hook não imprime nada. "Sempre permitir" só oferece as sugestões que o próprio Claude Code enviou, nunca o modo que ignora permissões. Planos (`ExitPlanMode`) são aprovados no terminal.

As decisões passam por `agent-events.sqlite3` na pasta de dados do app. Um processo do mesmo usuário poderia gravar nesse arquivo, inclusive um comando já autorizado ao agente.

## Envio seguro

Antes do primeiro envio, o app espera um sinal do processo atual (hook ou escrita na conversa). Sem esse sinal, pede confirmação, porque um aviso aberto no TUI receberia as teclas. Com solicitação pendente o envio é bloqueado. Menus abertos manualmente no terminal (por exemplo `/model`) não são detectados.

## Limitações

- Sem Mermaid e sem fórmulas matemáticas: aparecem como código ou texto.
- Imagens remotas não são carregadas; viram um botão que abre o link.
- Diffs mostram só o que as ferramentas de edição registraram. Mudanças feitas por comandos aparecem na aba Git. Não há "desfazer".
- Resumos de testes e build não são deduzidos do texto: a saída aparece no cartão do comando.
- Editar uma mensagem copia o texto para o campo de envio; o histórico do agente não é alterado. Não há ramificação de sessão pelo chat.
- Modelo e raciocínio são trocados pelos menus do próprio agente, no terminal.
- A busca cobre a parte carregada da conversa.
- Codex sem ID de thread: o vínculo é automático só quando há uma única conversa nova possível; caso contrário o chat pergunta. Um Codex externo aberto na mesma pasta e no mesmo momento pode confundir esse vínculo.
- Depois de `/clear`, o chat acompanha a nova conversa, mas "Retomar" usa o ID original da sessão.
- Versões antigas do Claude Code sem os hooks novos funcionam só com o histórico do arquivo.
