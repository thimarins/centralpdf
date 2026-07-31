# Arquitetura do Central PDF

## Filosofia

Central PDF foi desenhado para:

- baixa manutenção
- estabilidade
- simplicidade corporativa
- operação local/offline
- deploy previsível em Windows

O projeto evita arquitetura complexa de frontend, plugins, serviços externos e camadas desnecessárias.

## Estrutura de Pastas

```text
src/
  main/
    index.js
    pdf-service.js
    queue.js
    config-service.js
    logger.js
    utils.js
  preload/
    index.js
  renderer/
    index.html
    app.js
    style.css
docs/
build/
dist/
dist-installer/
releases/
```

## Arquitetura Electron

### Main

Arquivos em `src/main/`.

Responsabilidades:

- bootstrap da aplicação Electron
- criação da janela principal
- hardening do runtime
- validação de payloads IPC
- fila sequencial de processamento
- logs e diagnóstico
- configuração local e modo portátil
- execução das operações PDF

Arquivos principais:

- `index.js`: janela, IPC e orquestração
- `pdf-service.js`: operações PDF
- `queue.js`: fila e progresso
- `config-service.js`: config local e políticas
- `logger.js`: logs rotativos e pacote diagnóstico
- `utils.js`: validações e helpers

### Preload

Arquivo em `src/preload/index.js`.

Responsabilidades:

- expor uma API pequena e controlada para o renderer
- impedir acesso direto do renderer a APIs Node
- manter uma allowlist simples de funções IPC

### Renderer

Arquivos em `src/renderer/`.

Responsabilidades:

- interface do usuário
- fluxo visual das operações
- renderização de previews com `pdfjs-dist`
- organização de páginas
- acompanhamento da fila

O renderer não processa arquivos PDF finais. Ele apenas prepara a UX e delega o trabalho ao `main`.

## Fluxo IPC

Fluxo básico:

1. O usuário interage com a UI no renderer.
2. O renderer chama `window.api.*`.
3. O preload encaminha para `ipcRenderer.invoke(...)`.
4. O main valida o payload.
5. O main enfileira a operação.
6. A fila executa a tarefa e devolve progresso para a UI.

Canais principais:

- `get-config`
- `update-theme`
- `update-output-dir`
- `select-directory`
- `select-files`
- `queue-operation`
- `cancel-operation`
- `get-queue-status`
- `export-diagnostics`

## Módulos PDF

Operações principais em `src/main/pdf-service.js`:

- merge
- split por página
- split por intervalo
- split por tamanho
- organize páginas
- compress
- watermark em lote

Decisão arquitetural:

- `pdf-lib` para escrita/manipulação
- `pdfjs-dist` somente para preview no renderer

Isso separa bem:

- preview visual
- processamento final do arquivo

## Fila

Arquivo: `src/main/queue.js`

A fila foi mantida simples:

- uma operação ativa por vez
- bloqueio de conflitos por arquivo
- cancelamento
- progresso global
- progresso por item em operações de lote

Rationale:

- menor risco de corrupção
- menos consumo simultâneo de RAM
- comportamento previsível para TI

## Configurações e Políticas

Arquivo: `src/main/config-service.js`

Configurações locais:

- tema
- pasta padrão de saída
- retenção de logs
- histórico recente

Política corporativa opcional:

- `C:\ProgramData\Central PDF\policy.json`

Uso esperado:

- forçar tema
- forçar pasta de saída
- desabilitar histórico
- ajustar retenção de logs
- definir limite máximo de tamanho de arquivo

## Logs

Arquivo: `src/main/logger.js`

O projeto usa:

- `operations.log`
- `crashes.log`
- rotação simples
- retenção configurável
- exportação de pacote diagnóstico

Objetivo:

- suporte básico de TI
- troubleshooting rápido
- sem plataforma externa de observabilidade

## Modo Portátil

O app suporta modo portátil quando detecta:

- flag `--portable`
- arquivo `portable.txt`
- pasta `data` ao lado do executável empacotado

No modo portátil:

- configurações ficam em `data/config.json`
- logs ficam em `data/logs`

## Rationale de Design

Decisões intencionais:

- sem Redux
- sem backend remoto
- sem atualizador automático
- sem plugin system
- sem banco externo

Motivo:

- reduzir manutenção
- reduzir superfície de falha
- facilitar deploy corporativo
- manter troubleshooting previsível

## Evolução Futura

O backend atual permite evoluir para automação CLI no futuro porque:

- regras de validação estão no `main`
- operações PDF estão concentradas em `pdf-service.js`
- fila e logs já existem como módulos separados

Isso permite futuras integrações sem refazer a arquitetura atual.
