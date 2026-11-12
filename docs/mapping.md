# Mapeamento de agentes

O Mapeamento é uma camada visual sobre as sessões de terminal existentes. Ele não inicia, retoma nem encerra processos por conta própria.

## Ciclo de vida do terminal

- Cada sessão continua pertencendo ao `TerminalState` do backend Tauri.
- Em Modo Terminal, uma única instância de `TerminalView` é montada para cada janela visível.
- Ao minimizar, ocultar, trocar de modo ou navegar para outra tela, a instância xterm é desmontada, mas o PTY permanece ativo.
- Uma nova montagem usa `terminal_scrollback` e depois continua pelos eventos `terminal-output`, preservando histórico e tempo real sem duplicar o processo.
- O Modo Arquitetura usa os mesmos objetos `SessionInfo` e não monta terminais.

## Canvas e persistência

O canvas usa pointer events e uma transformação CSS única para pan e zoom. Janelas usam coordenadas do mundo, portanto o redimensionamento e o movimento são independentes do zoom atual. O scroll do terminal tem prioridade dentro da janela; zoom do mapa exige Ctrl/Cmd fora do terminal.

Layouts são persistidos na tabela `mapping_layouts` do `workspace.sqlite3`, separados pelo escopo `all` ou pelo ID do projeto. Posição, tamanho, minimização, ocultação, modo e viewport são validados no backend antes de serem gravados. Sessões removidas deixam de ser materializadas quando o layout é reconciliado; sessões novas recebem apenas uma posição inicial e não reposicionam as existentes.

## Relações entre agentes

A camada SVG de conexões existe no canvas, mas permanece vazia enquanto as sessões não fornecerem relações reais de delegação ou dependência. Conexões não são inferidas por pasta, painel ou ordem visual.
