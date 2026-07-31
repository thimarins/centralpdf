# Central PDF

Utilitário corporativo para processamento **local** de documentos PDF/Office no Windows. Operação 100% offline, previsível, com baixa manutenção e sem dependência de cloud, serviço residente ou backend remoto.

- **App**: Electron 43 + Vite (renderer em JS puro, sem framework)
- **Motor de PDF**: `pdf-lib` (escrita/manipulação), `pdfjs-dist` (preview), QPDF WASM (descriptografia local)
- **Distribuição**: MSI corporativo, executável portátil e pasta "unpacked" sem instalação

Para aprofundar em build/deploy, segurança e troubleshooting, veja a pasta [docs/](./docs/) — o guia de leitura no final deste arquivo aponta o documento certo para cada assunto.

---

## Funcionalidades

| Módulo | O que faz |
|---|---|
| **Mesclar** | Combina múltiplos PDFs (e imagens/documentos convertidos) em um único arquivo |
| **Separar** | Divide um PDF por página, por intervalo ou por tamanho máximo de arquivo |
| **Organizar Páginas** | Reordena, duplica, remove e rotaciona páginas; edita marcadores (bookmarks) |
| **Marca d'água** | Aplica texto ou imagem em lote, com opção de posição, cor, opacidade e rotação |
| **Reduzir tamanho** | Compacta PDFs (reotimização de imagens internas) e imagens avulsas (JPG/PNG) |
| **Converter para PDF** | Converte imagens (`JPG`/`JPEG`/`PNG`), `DOCX` e `XLSX` para PDF, sem LibreOffice |
| **PDF para Word** | Converte PDF textual para `DOCX` ou texto estruturado — sem OCR (não recomendado para digitalizados) |
| **Assinar PDF** | Assinatura visual simples: texto livre, iniciais, data ou selo/imagem |
| **Proteger PDF** | Define senha e restrições de acesso (criptografia local) |
| **Desbloquear PDF** | Remove senha de abertura de um PDF protegido |
| **Ocultar Dados** | Redação permanente de trechos sensíveis (não é apenas cobrir visualmente) |

Todas as operações passam por uma **fila** com cancelamento, timeout, retry automático e progresso por item — só uma operação roda por vez, por design (ver [Arquitetura](#arquitetura-e-módulos)).

---

## ⚠️ Aviso — caminho de rede (UNC)

Se este projeto estiver hospedado em um **caminho de rede** (algo como `\\SEU-SERVIDOR\Central PDF`), `npm install`, `npm run dev` e `npm run build` podem falhar se executados diretamente do UNC — `cmd.exe` e várias ferramentas Node não suportam bem esse tipo de caminho.

**Sempre mapeie a pasta de rede para uma unidade local antes de trabalhar:**

```bash
# Executar no Prompt de Comando / PowerShell
net use Z: "\\SEU-SERVIDOR\Central PDF"

# Depois acesse a unidade Z:
Z:
cd \
```

---

## Execução Rápida

```bash
npm install
npm run dev          # sobe o Vite em modo desenvolvimento (não empacota o Electron)
npm start             # roda o Electron apontando pro build atual
```

Gerar os pacotes Windows (MSI + Portable + unpacked):

```bash
npm run build:win
```

Scripts úteis do dia a dia:

| Comando | O que faz |
|---|---|
| `npm run lint` / `npm run lint:fix` | ESLint no projeto inteiro |
| `npm run format` | Prettier |
| `npm run test:functional` | Testes das operações de PDF (`pdf-service.js` e serviços) |
| `npm run test:queue` | Testes da fila (cancelamento, retry, timeout, recovery) |
| `npm run test:security` | Auditoria estática de hardening do Electron |
| `npm run health-check` | Roda a bateria de auditorias locais (functional + queue + security + arquitetura + repo) |

---

## Arquitetura e Módulos

Três processos/camadas Electron clássicos: **main** (Node.js, sem UI) → **preload** (ponte controlada) → **renderer** (UI, sandboxed, sem acesso direto a Node).

### `src/main/` — processo principal

| Arquivo | Responsabilidade |
|---|---|
| `index.js` | Bootstrap do Electron, janela principal, hardening (`contextIsolation`, `sandbox`, CSP), todos os handlers IPC (`ipcMain.handle`) e validação de payload — é a fronteira real de confiança do app |
| `pdf-service.js` | Operações de PDF de baixo nível: merge, split, organize, compress, protect/unlock, redact, watermark — sempre com escrita atômica (arquivo temporário + rename) |
| `pdf-operation-worker.js` | Entry point do `worker_thread` que executa cada operação da fila fora do processo principal, para não travar a UI |
| `worker-runtime.js` | Ponte entre `queue.js` e o worker thread (mensagens de progresso/cancelamento) |
| `queue.js` | Fila de processamento: concorrência configurável, timeout, retry, cancelamento, persistência de estado e recovery após crash |
| `config-service.js` | Configuração local (`config.json`), políticas corporativas (`policy.json`), detecção de modo portátil |
| `logger.js` | Logs rotativos (`operations.log`, `crashes.log`) e exportação de pacote de diagnóstico sanitizado |
| `utils.js` | Validações de arquivo (magic bytes, tamanho), sanitização de nome de arquivo, resolução de nome único de saída |
| `app-meta.js` | Metadados da versão/build expostos à UI |
| `constants.js` | Limites e valores padrão centralizados (tamanho de arquivo, timeouts, retenção de log) |
| `services/conversion/` | `pdf-to-word.js` (PDF → DOCX/texto), `docx-builder.js`, `text-extractor.js`, `conversion-worker.js` |
| `services/document-conversion/` | `document-to-pdf.js` — DOCX/XLSX → PDF via `BrowserWindow` oculta + `printToPDF` |
| `services/image-conversion/` | `image-to-pdf.js`, `image-validation.js`, `conversion-worker.js` — imagens → PDF |
| `services/signature/` | `signature-service.js`, `signature-renderer.js`, `field-manager.js`, `signature-worker.js` — assinatura visual |

### `src/preload/`

`index.js` expõe uma API mínima e explícita (`window.api.*`) via `contextBridge` — o renderer nunca tem acesso direto a `fs`, `child_process` ou qualquer API Node.

### `src/renderer/` — interface

`app.js` é o ponto de entrada e concentra o estado global (`state`) e as 11 funções `queueX()` que montam o payload de cada operação. As telas de cada ferramenta são módulos isolados em `ui/`:

| Pasta/arquivo | Ferramenta |
|---|---|
| `ui/organize/organize-workspace.js` | Organizar Páginas |
| `ui/redact/redact-workspace.js` | Ocultar Dados |
| `ui/signature/signature-workspace.js` | Assinar PDF |
| `ui/watermark/watermark-workspace.js` | Marca d'água |
| `ui/security/protect-workspace.js` | Proteger PDF |
| `ui/security/unlock-workspace.js` | Desbloquear PDF |
| `ui/image-to-pdf/image-to-pdf-workspace.js` | Converter para PDF |
| `ui/conversion/pdf-to-word-workspace.js` | PDF para Word |
| `ui/queue/queue-status.js` | Fila e histórico de atividades |
| `ui/pdf-preview-utils.js` | Helpers compartilhados de preview/imagem (usado por vários workspaces acima) |
| `ui/notifications/toast-center.js`, `ui/feedback/feedback-center.js` | Toasts e banners de feedback |
| `ui/icons/fluent-icons.js` | Ícones Fluent UI |
| `settings/about/`, `settings/system-info/`, `settings/diagnostics/` | Tela de Configurações (Sobre, ambiente, diagnóstico) |

### Fluxo de uma operação

1. UI monta o payload (`type`, `files`, `options`) e chama `window.api.queueOperation(...)`.
2. Preload repassa via `ipcRenderer.invoke`.
3. `index.js` valida arquivos/opções e enfileira em `queue.js`.
4. `queue.js` sobe um worker (`pdf-operation-worker.js`) que chama `pdf-service.js` ou o serviço específico.
5. Progresso e resultado voltam por IPC; `queue-status.js` atualiza a UI e o histórico.

---

## Requisitos Mínimos

- Windows 10 ou 11 x64
- Node.js 20 LTS ou superior (build local)
- 4 GB de RAM recomendados

## Limites Operacionais

- suporte oficial até aproximadamente **2 GB** por arquivo PDF
- acima de 300 MB o app reduz previews e opera de forma mais conservadora
- acima de 1 GB o modo otimizado é ativado quando aplicável
- conversão para Word funciona melhor com PDFs digitais/textuais — documentos escaneados não são convertidos corretamente sem OCR

## Operação Offline

Sem upload automático, sem auto-update, sem serviço residente, sem telemetria remota. Toda distribuição e atualização é manual, feita por TI (ver [docs/UPDATE_PROCESS.md](./docs/UPDATE_PROCESS.md)).

---

## Guia de Leitura Essencial

| Documento | Quando ler |
|---|---|
| [docs/README.md](./docs/README.md) | Visão geral e stack completa |
| [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) | Arquitetura Electron em detalhe, decisões de design |
| [docs/BUILD.md](./docs/BUILD.md) | Build local, artefatos gerados, empacotamento |
| [docs/DEPLOYMENT.md](./docs/DEPLOYMENT.md) | Deploy corporativo via MSI/GPO/Intune |
| [docs/UPDATE_PROCESS.md](./docs/UPDATE_PROCESS.md) | Como atualizar versões instaladas e como reverter (rollback) |
| [docs/SECURITY.md](./docs/SECURITY.md) | Hardening do Electron, CSP, tratamento de dados sensíveis |
| [docs/TESTING.md](./docs/TESTING.md) | Suítes de teste disponíveis e o que cada uma cobre |
| [docs/TROUBLESHOOTING.md](./docs/TROUBLESHOOTING.md) | Erros comuns de build/execução |
| [docs/CHANGELOG.md](./docs/CHANGELOG.md) | Histórico de versões |
