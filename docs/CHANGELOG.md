# Changelog

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
- separação por página, intervalo e tamanho apr?ximado
- organização de páginas com reorder, duplicação, remoção e rotação
- marca d'água em lote com texto ou imagem
- compressão local de PDF
- fila com cancelamento, timeout, progresso e recovery básico
- exportação de pacote de diagnóstico
- modo portátil e release unpacked para uso sem instalação
- hardening final, limpeza de repositório, validação automatizada e documentação consolidada
