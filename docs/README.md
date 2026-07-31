# Central PDF

## Visão Geral

Central PDF é um utilitário corporativo para processamento local de documentos no Windows.
Foi desenhado para operação offline, previsível, com baixa manutenção e sem dependência de cloud, serviços residentes ou backend remoto.

Versão atual de fechamento da V1: `1.5`.

## Objetivos do Projeto

- processamento local e previsível
- interface simples para operação corporativa diária
- deploy direto para TI
- manutenção viável para equipes pequenas
- segurança prática, sem complexidade desnecessária

## Funcionalidades Principais

- converter arquivos para PDF em lote (`JPG`, `JPEG`, `PNG`, `DOCX`, `XLSX`), sem LibreOffice
- assinar PDF com assinatura visual simples, iniciais, data, texto livre e selo
- conversão de PDF textual para Word (`DOCX`) ou texto estruturado, sem OCR
- mescla de múltiplos PDFs
- separação por página, intervalo e tamanho apr?ximado
- organização de páginas com reorder, duplicação, remoção e rotação
- marca d'água em lote com texto ou imagem
- compressão local de PDF
- proteger PDF (criptografia, senha e permissões)
- redigir PDF (remoção permanente e censura de informações confidenciais)
- fila com cancelamento, timeout, progresso e recovery básico
- exportação de pacote de diagnóstico
- modo portátil

## Operação Offline / Local

- todo processamento acontece localmente
- não existe upload automático
- não existe auto-update
- não existe serviço residente
- não existe telemetria remota

## Stack Utilizada

- Electron
- Vite
- Node.js
- pdf-lib
- pdfjs-dist
- docx
- mammoth
- xlsx
- Fluent UI System Icons

## Requisitos Mínimos

- Windows 10 ou Windows 11 x64
- Node.js 20 LTS ou superior para build local
- 4 GB de RAM recomendados
- espaço em disco para build e arquivos temporários locais

## Limites Operacionais Esperados

- suporte oficial até apr?ximadamente `2 GB` por arquivo PDF
- acima de `300 MB` o app pode reduzir previews e operar de forma mais conservadora
- acima de `1 GB` o app ativa modo otimizado quando aplicável
- o projeto prioriza estabilidade e degradação elegante, não edição irrestrita de documentos extremos
- `pdf-lib` continua sendo o principal limitador técnico para documentos muito grandes
- a conversão para Word funciona melhor com PDFs digitais/textuais; documentos escaneados não são convertidos corretamente sem OCR

## Execução Rápida e Restrições de UNC Path

Atualmente o repositório deste projeto pode residir em um servidor de arquivos Windows (via caminho UNC, ex: `\\vm-infra\Central PDF`). Muitas ferramentas subjacentes (incluindo Node.js/npm e `cmd.exe`) **não suportam ou falham silenciosamente** ao rodar em caminhos UNC.

**Sempre mapeie o caminho para um drive local (`net use Z: "\\vm-infra\Central PDF"`) ou faça clone localmente.**

Após mapear (ex: para `Z:`):

```bash
Z:
cd \
npm install
npm run dev
```

Para gerar os pacotes Windows:

```bash
npm run build:win
```
