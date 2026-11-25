# Athenas Agent

## Temas da interface

- Centralize as paletas em `src/themes.css` e use os tokens semânticos de `src/tokens.css` nas telas. Superfícies, texto, bordas, botões, ícones, foco e seleção seguem o tema ativo. Derive efeitos e gradientes desses mesmos tokens.
- O tema **Preto e Branco** usa branco para os destaques dos controles e seleção neutra. Use tokens de estado, como `--st-running` e `--st-error`, para comunicar atividade e erros. Preserve as cores originais dos ícones de provedores.
- Ao alterar cores, valide os controles nos temas **Preto e Branco** e em pelo menos um tema colorido. O teste de cores do Mapeamento em `e2e/mapping.spec.ts` verifica essa troca.
