# Auditoria ampla e release local — 2026-11-09

## Escopo

Revisão da consistência entre módulos e dos contratos de estado, upload, IPC, feedback, segurança, fila, OCR, testes e build. A árvore de trabalho já continha mudanças locais antes desta rodada; nenhuma foi descartada. MSI existente, publicação `releases/latest` e instalador na raiz foram preservados.

## Resultado

- Lint: concluído sem erros; 6 avisos em arquivos já modificados na árvore de trabalho.
- Auditoria entre módulos: 13 verificações aprovadas.
- UI estrutural: 73 verificações aprovadas.
- Upload: 25 verificações aprovadas.
- Segurança: 30 verificações aprovadas.
- Fila: 11 testes aprovados.
- Funcional: 40 testes aprovados.
- Suíte de regressão OCR: 37/37 grupos aprovados.
- Build e contratos: 9 verificações aprovadas; renderer compilou 1.809 módulos.
- Startup empacotado: smoke aprovado em 2.919 ms, até `renderer-bootstrap-complete`.
- Artefatos runtime: modelos `por`/`eng` e avisos de licença presentes no pacote unpacked produzido nesta rodada.
- MSI gerado sem assinatura digital, pois não há certificado configurado.

## Observações de padronização

- Há contratos centrais já úteis: estado do renderer em `createAppState`, guardas IPC no processo principal, catálogo Lucide, mensagens agrupadas, helpers de privacidade e pré-validação comum de uploads.
- `src/renderer/app.js` continua concentrando navegação, histórico recente, dashboard, seleção de arquivos e enfileiramento. Esse é o maior ponto de acoplamento restante; extrações graduais devem preservar um único contrato de estado e serem acompanhadas por testes de comportamento.
- O ESLint apontou variáveis sem uso/atribuições inúteis: limites e lista de diretórios em `src/main/index.js`, variável de rótulo em `src/renderer/app.js`, três variáveis/argumentos em `src/renderer/ui/ocr/ocr-area-extractor.js`. Não bloqueiam build, mas indicam limpeza localizada.
- `run-build-check.js` reconstroi e substitui `dist`; por isso foi usado o build em pasta temporária do empacotador e validado o resultado empacotado, mantendo a auditoria reversível.
- `npm run build:win` publica MSI, portable e unpacked em diretórios compartilhados e substitui `releases/latest`; a saída desta rodada foi isolada para proteger artefatos preexistentes.

## Artefato da auditoria inicial (substituído)

- MSI: `releases/1.2.34/Central-PDF-1.2.34-win-x64-audit-20261109.msi`
- Tamanho: 156.758.016 bytes.
- SHA-256 verificado: `45B052C5D7858A6496AFA2A01DA5E7E05F7A7C4850937F1702213F894728D075`
- MSI produzido a partir da versão `1.2.34`; nenhum número de versão foi alterado.
- Smoke test executado sobre o unpacked da mesma compilação.

## Limites

O smoke test valida inicialização e bootstrap do pacote, não equivale a instalação MSI em Windows limpo nem a revisão manual de cada fluxo visual. A assinatura de código permanece ausente.

## MSI de atualização gerado após instalação sem mudanças

- Nova versão: `1.2.35` (incrementada para o Windows Installer detectar a atualização).
- Renderer recompilado da fonte atual antes do empacotamento; build: 1.809 módulos.
- MSI: `releases/1.2.35/Central-PDF-1.2.35-win-x64.msi`.
- Tamanho: 156.753.920 bytes.
- SHA-256 verificado: `D257F91ACFCFA8DE0F4678607E5F75F78613BC6F91D56BF9501E3789B5A92DA8`.
- Versões `version` e `releaseVersion` conferidas dentro do `app.asar`; `dist/index.html` presente.
- Smoke do executável unpacked desta compilação: aprovado, `renderer-bootstrap-complete` em 3.728 ms.
- Para receber as mudanças, instale este MSI `1.2.35`; o MSI `1.2.34` anterior não foi atualizado/substituído.

## Ajuste do rodapé da fila e translucidez

- Versão preparada: `1.2.36` (`releaseVersion` também incrementada para o Windows Installer detectar a atualização).
- A fonte do renderer compilou novamente com 1.809 módulos; o executável empacotado desta versão passou no smoke de inicialização e chegou a `renderer-bootstrap-complete` em 35.541 ms.
- Ajustes de UI: rodapé da fila elevado na pilha visual, área inferior reservada ampliada em todas as abas que contêm o componente e fundo ajustado para 82% de opacidade com blur.
- O empacotador WiX ficou ativo, mas não concluiu a geração do MSI em tempo razoável; não foi publicado artefato `1.2.36` nesta tentativa.
