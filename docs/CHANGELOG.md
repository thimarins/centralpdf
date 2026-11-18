# Changelog

## 1.3.0

- alinhamento horizontal dos botões de ação à direita no card **Últimos arquivos usados**, reduzindo a altura dos itens
- remoção de bordas redundantes em sub-containers internos de cards (itens de arquivos recentes, lista de arquivos OCR, barras de pesquisa, zoom e navegação de páginas)
- sincronização de dependências de produção (`npm audit --omit=dev` sem vulnerabilidades conhecidas) e limpeza de warnings de lint

## 1.2.47

- adicionado módulo completo de **Reconhecer Texto (OCR)** offline (`tesseract.js` WebAssembly com modelos locais PT/EN e `@napi-rs/canvas`) para PDFs e imagens (JPG, PNG e TIFF multipágina)
- adicionado **OCR Zonal (Extração de Área Selecionada)** com reconhecimento automático ao selecionar, priorização de texto nativo digital (100% de precisão), deduplicação de texto redundante e inversão de polaridade para texto claro em fundo escuro
- adicionada pesquisa textual profunda em PDFs nativos e digitalizados, sugestão automática de pontos de separação por cabeçalhos e detecção de termos sensíveis por OCR no módulo Ocultar Dados
- substituído QPDF WASM por binário nativo (`vendor/qpdf/`) para melhor desempenho e confiabilidade em descriptografia e linearização
- atualizada interface com Lucide Icons, paleta de comandos global (`Ctrl+K`), dock unificado de saída e novos testes automatizados de regressão e auditoria

## 1.2

- adicionado módulo Assinar PDF para assinatura visual simples, iniciais, data, texto livre e selo interno
- adicionado módulo Converter para Word para exportação textual local em `DOCX` ou texto estruturado, sem OCR
- extraída a lógica de marca d'água para módulo próprio do renderer, reduzindo acoplamento do `app.js`
- reorganizados os estilos de workspaces em arquivo dedicado, reduzindo peso do `components.css`
- atualização das auditorias, documentação e painéis técnicos para a nova capacidade de exportação textual

## 1.1

- consolidação final da V1 com revisão de estabilidade, fila e navegação
- correções no fluxo de marca d'água, toasts e progresso de tarefas
- refinamento do ícone do aplicativo e da identidade visual interna
- limpeza de artefatos legados, ativos de teste regeneráveis e documentação

## 1.0.0

- release corporativa final da V1
- conversor de arquivos para PDF em lote (`JPG`, `JPEG`, `PNG`, `DOCX`, `XLSX`), sem LibreOffice
- mescla de múltiplos PDFs
- separação por página, intervalo e tamanho aproximado
- organização de páginas com reorder, duplicação, remoção e rotação
- marca d'água em lote com texto ou imagem
- compressão local de PDF
- fila com cancelamento, timeout, progresso e recovery básico
- exportação de pacote de diagnóstico
- modo portátil e release unpacked para uso sem instalação
- hardening final, limpeza de repositório, validação automatizada e documentação consolidada
