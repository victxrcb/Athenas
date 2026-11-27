# Acesso pelo celular

O Athenas serve uma página para o celular a partir do próprio computador. O Tailscale liga os aparelhos do usuário e fornece o endereço HTTPS, sem servidor próprio na nuvem. O recurso vem desligado.

```
Celular (Chrome) ⇄ Tailscale (HTTPS) ⇄ tailscale serve ⇄ 127.0.0.1:47821 (Athenas) ⇄ agentes
Athenas → serviço de notificações do navegador (Google, no Chrome) → celular
```

## Como usar

1. Instale o Tailscale no computador e no celular, com a mesma conta. No painel, em **DNS**, ative **MagicDNS** e **HTTPS Certificates**.
2. No Athenas, abra **Ajustes → Celular** e ligue **Permitir acesso pelo celular**.
3. Toque em **Parear celular** e abra o QR code no Chrome do celular.
4. Dê um nome ao aparelho, confira o número nas duas telas e toque em **Permitir** no computador.
5. No Chrome, use **Instalar app** (ou **Adicionar à tela inicial**).
6. Para abrir conversas, enviar mensagens e aprovar, marque **Pode conversar e aprovar** no aparelho, no computador.
7. No celular, toque em **Ligar notificações** e depois em **Testar**.

A primeira abertura pode demorar enquanto o Tailscale emite o certificado. Se der tempo esgotado, abra de novo. O nome do computador na rede aparece em registros públicos de certificados.

Em aparelhos Xiaomi, deixe o Chrome e o Tailscale com bateria **Sem restrições**, ative o início automático do Tailscale e permita as notificações do app instalado.

## O que o celular faz

| Ação | Sem "Pode conversar e aprovar" | Com |
|---|---|---|
| Listar agentes e status | sim | sim |
| Receber notificações | sim | sim |
| Ler conversas | não | sim |
| Enviar mensagem e interromper | não | sim |
| Permitir uma vez, recusar e responder perguntas (Claude) | não | sim |

Só no computador: "sempre permitir", aprovação de planos, aprovações do Codex, comandos que começam com `/` ou `!`, trocar a conversa de uma sessão do Codex e a primeira mensagem de um agente que ainda não sinalizou que está pronto.

## Notificações

São enviadas quando uma sessão passa a esperar o usuário ou termina um turno, com o nome da sessão, o agente, o projeto e, na espera, o texto do aviso. Elas aparecem na tela bloqueada conforme a configuração do celular. O conteúdo é cifrado para o navegador (Web Push, RFC 8291); o serviço no meio vê apenas que houve um envio. São enviadas mesmo com o usuário no computador.

## Código

- `src-tauri/src/mobile/`: `auth.rs` (pareamento e aparelhos), `server.rs` (rotas HTTP), `control.rs` (o que um celular pode fazer e quando), `push.rs` e `notices.rs` (notificações), `app.rs` (ligação com terminais, chat e registro), `tailscale.rs`, `mod.rs` (comandos e ciclo de vida).
- `src/mobile/`: bloco **Celular** das configurações e envio do status das sessões ao backend.
- `src/phone/`, `mobile.html` e `public/sw.js`: página do celular. Ela não usa Tauri e reaproveita os adaptadores de conversa de `src/chat/`.

O status e o projeto de cada sessão vêm da interface (`mobile_publish`), para o celular mostrar o mesmo que o computador. As notificações saem das mudanças nesse status.

## Segurança

Quem controla um aparelho liberado consegue executar comandos neste computador, pedindo ao agente e aprovando.

- O servidor escuta só em `127.0.0.1` e recusa nomes (`Host`) e origens que não sejam os dele.
- Pareamento: código de 256 bits no fragmento do endereço, de uso único, válido por 2 minutos, mais confirmação no computador.
- Cada aparelho recebe um token em cookie `HttpOnly`, `Secure`, `SameSite=Strict`. Em `mobile.json` fica apenas o hash. Há no máximo 10 aparelhos.
- Controle é liberado por aparelho, no computador, e vem desligado.
- Só há ações específicas; não existe escrita livre no terminal.
- Enviar digita no terminal e aperta Enter. Por isso o envio é recusado com pedido pendente, com a sessão esperando resposta ou sem sinal de que o agente está pronto, e o Enter é retido se um pedido surgir durante a digitação.
- Mensagens que começam com `/` ou `!` são recusadas, também quando precedidas de caracteres invisíveis.
- O mesmo envio repetido (conexão ruim) não é digitado duas vezes.
- Aprovações mostram o pedido inteiro, valem uma vez e só para a sessão que o fez.
- Tudo o que o celular faz vai para `mobile-actions.jsonl` e aparece nas configurações.
- Notificações só são enviadas a serviços de push conhecidos.
- A publicação nunca usa Funnel (internet aberta) e não substitui nem remove outra configuração do `tailscale serve` na porta 443.
- Ao fechar o app a publicação é removida; ao abrir, volta se o acesso estava ligado.
- Um programa rodando com o mesmo usuário do computador poderia alterar `mobile.json` (aparelhos e chave das notificações). Isso não amplia o que ele já consegue: as decisões de permissão passam por um arquivo local com a mesma proteção (veja `chat.md`).

## Etapas

| Etapa | Entrega | Situação |
|---|---|---|
| 1 | Servidor, pareamento, revogação e lista de agentes | feita |
| 2 | Chat: ler, enviar e interromper | feita |
| 3 | Aprovações e perguntas do Claude | feita |
| 4 | Notificações push | feita |
| 4 | Bandeja e PC acordado | pendente |
| 5 | Terminal com botões de tecla (aprovações do Codex e planos) | pendente |

## Limitações

- O computador precisa estar ligado, sem suspender, com o Athenas aberto.
- Menus abertos à mão no terminal (por exemplo `/model`) não são detectados, e texto já digitado no terminal é enviado junto com a mensagem do celular.
- O pedido de aprovação do Codex é percebido pela notificação que ele emite; um aviso do Codex sem notificação não bloqueia o envio.
- O texto do Claude aparece no celular quando é gravado na conversa, sem digitação em tempo real.
- Se o app for encerrado à força, a publicação no Tailscale permanece até a próxima abertura.
- Com o Tailscale fora do ar na abertura, o app tenta publicar por cerca de 2 minutos; depois, use **Tentar publicar**.
- Duas instâncias do Athenas com o acesso ligado disputam a mesma porta.

## Desenvolvimento

- Em `npm run app`, a página do celular vem de `dist/`: rode `npm run build` antes.
- Em builds de depuração, `ATHENAS_MOBILE_LOCAL=1` serve a página só para o próprio computador, sem Tailscale.
