# Build do Central PDF

## Objetivo

Este documento descreve o processo de build local e geração dos pacotes Windows do Central PDF. Os exemplos abaixo usam a versão `1.2.0` como referência; substitua pela versão atual em `package.json`.

## Pré-requisitos

- Windows 10 ou Windows 11 x64
- Node.js 20 LTS ou superior
- npm

Verificação rápida:

```bash
node -v
npm -v
```

### Problema Crítico com UNC Paths
O script de build pode falhar com erros de localização se você estiver rodando diretamente via caminho UNC (`\\vm-infra\Central PDF`). Muitas ferramentas como o npm e o wix (usado pelo electron-builder) dão erro `ENOENT` porque o prompt de comando do Windows não suporta totalmente o UNC.

**Sempre mapeie a rede antes de iniciar**:
```bash
net use Z: "\\vm-infra\Central PDF"
Z:
cd \
```

## Instalação de Dependências

Na raiz do projeto:

```bash
npm install
```

## Comandos Disponíveis

```bash
npm run dev
npm run build
npm run build:win
npm run dist
npm run dist:win
npm run health-check
npm run release-check
```

## Fluxo Recomendado

### 1. Instalar dependências

```bash
npm install
```

### 2. Validar frontend

```bash
npm run build
```

### 3. Rodar validação de saúde

```bash
npm run health-check
```

### 4. Rodar validação de release

```bash
npm run release-check
```

### 5. Gerar pacotes Windows

```bash
npm run build:win
```

## O que o `build:win` faz

- executa `vite build`
- executa `electron-builder`
- usa staging externo em `%TEMP%` para evitar lock no workspace
- publica artefatos atuais em `dist-installer/`
- publica release versionada em `releases/1.2.0/`
- publica alias estável em `releases/latest/`

## Artefatos Gerados

### `dist-installer/`

- `Central PDF 1.2.0.msi`
- `Central-PDF-Portable-1.2.0.exe`

### `releases/1.2.0/`

- `Central-PDF-1.2.0-win-x64.msi`
- `Central-PDF-1.2.0-win-x64-portable.exe`
- `Central-PDF-win-x64-unpacked/`
- `RELEASE.txt`

### `releases/latest/`

- `Central-PDF-win-x64.msi`
- `Central-PDF-win-x64-unpacked/`
- `RELEASE.txt`
- `NO-INSTALL.txt`

Observação importante:

- o single-file portable não é mais publicado em `latest`
- a forma sem instalação mais confiável é a pasta `Central-PDF-win-x64-unpacked/`

## Electron Builder

Configuração em:

- `electron-builder.json`

Targets atuais:

- MSI x64
- Portable x64
- unpacked x64

## Observações Práticas

- o build depende do frontend gerado em `dist/`
- o MSI está configurado para perfil corporativo (`perMachine: true`)
- o projeto não possui assinatura digital automatizada
- o `win-unpacked` não é tratado como pasta operacional dentro do workspace; a publicação final acontece em `releases/`

## Estrutura Relevante

```text
dist/
  index.html
  assets/

dist-installer/
  Central PDF 1.2.0.msi
  Central-PDF-Portable-1.2.0.exe

releases/
  1.2.0/
    Central-PDF-1.2.0-win-x64.msi
    Central-PDF-1.2.0-win-x64-portable.exe
    Central-PDF-win-x64-unpacked/
    RELEASE.txt
  latest/
    Central-PDF-win-x64.msi
    Central-PDF-win-x64-unpacked/
    RELEASE.txt
    NO-INSTALL.txt
```

## Validação Mínima Antes de Liberar

- abrir o app
- testar Converter para PDF com imagem, Word e Excel
- testar assinar PDF
- testar converter para Word
- testar merge
- testar split
- testar organize
- testar watermark
- testar compress
- testar proteger
- testar redigir
- testar exportação de diagnóstico


