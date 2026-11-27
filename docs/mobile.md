# Acesso pelo celular

O Athenas serve uma página para o celular a partir do próprio computador. Não há servidor na nuvem: o Tailscale liga os aparelhos do usuário e fornece o endereço HTTPS. O recurso vem desligado.

```
Celular (Chrome) ⇄ Tailscale (HTTPS) ⇄ tailscale serve ⇄ 127.0.0.1:47821 (Athenas) ⇄ agentes
```

## Como usar

1. Instale o Tailscale no computador e no celular, com a mesma conta. No painel, em **DNS**, ative **MagicDNS** e **HTTPS Certificates**.
2. No Athenas, abra **Ajustes → Celular** e ligue **Permitir acesso pelo celular**.
3. Toque em **Parear celular** e abra o QR code no Chrome do celular.
4. Dê um nome ao aparelho, confira o número nas duas telas e toque em **Permitir** no computador.
5. No Chrome, use **Instalar app** (ou **Adicionar à tela inicial**).

A primeira abertura pode demorar enquanto o Tailscale emite o certificado. Se der tempo esgotado, abra de novo. O nome do computador na rede aparece em registros públicos de certificados.

## Código

- `src-tauri/src/mobile/`: `auth.rs` (pareamento e aparelhos), `server.rs` (rotas HTTP), `tailscale.rs` (status e publicação), `mod.rs` (comandos e ciclo de vida).
- `src/mobile/`: bloco **Celular** das configurações e envio do status das sessões ao backend.
- `src/phone/` e `mobile.html`: página do celular. Ela não usa Tauri.

O status e o projeto de cada sessão vêm da interface (`mobile_publish`), para o celular mostrar o mesmo que o computador. A lista de sessões em execução vem do backend dos terminais.

## Segurança

- O servidor escuta só em `127.0.0.1` e recusa nomes (`Host`) e origens que não sejam os dele.
- Pareamento: código de 256 bits no fragmento do endereço, de uso único, válido por 2 minutos, mais confirmação no computador.
- Cada aparelho recebe um token em cookie `HttpOnly`, `Secure`, `SameSite=Strict`. Em `mobile.json` fica apenas o hash. Há no máximo 10 aparelhos.
- A publicação nunca usa Funnel (internet aberta) e não substitui nem remove outra configuração do `tailscale serve` na porta 443.
- Ao fechar o app a publicação é removida; ao abrir, volta se o acesso estava ligado.
- O celular recebe nome da sessão, agente, projeto, nome da pasta e status, mais o texto do aviso quando há pendência. Não recebe caminhos completos nem a conversa. O nome da sessão (tirado da primeira mensagem) e o aviso do Codex podem conter trechos dela ou de um comando.
- Um programa rodando com o mesmo usuário do computador poderia alterar `mobile.json` e incluir um aparelho. Antes de liberar aprovações pelo celular (etapa 3), isso precisa ser reavaliado.

## Etapas

| Etapa | Entrega | Situação |
|---|---|---|
| 1 | Servidor, pareamento, revogação e lista de agentes (só leitura) | feita |
| 2 | Chat: ler, enviar e interromper | pendente |
| 3 | Aprovações e perguntas do Claude | pendente |
| 4 | Notificações push, bandeja e PC acordado | pendente |
| 5 | Terminal com botões de tecla (aprovações do Codex e planos) | pendente |

Cuidados para as próximas etapas:

- Expor ações específicas, nunca escrita livre no terminal.
- Testar se uma mensagem começando com `!`, colada no Claude Code, executa um comando; se executar, bloquear no envio pelo celular.
- Nunca usar envio forçado sem confirmação do usuário.
- Mostrar o comando completo antes de aprovar e registrar o que foi feito pelo celular.

## Limitações

- O computador precisa estar ligado, sem suspender, com o Athenas aberto.
- Se o app for encerrado à força, a publicação no Tailscale permanece até a próxima abertura.
- Com o Tailscale fora do ar na abertura, o app tenta publicar por cerca de 2 minutos; depois, use **Tentar publicar**.
- Duas instâncias do Athenas com o acesso ligado disputam a mesma porta.
- Em `npm run app`, a página do celular vem de `dist/`: rode `npm run build` antes.
