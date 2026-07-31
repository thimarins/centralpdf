# Deploy Corporativo

## Visão Geral

Central PDF foi pensado para deploy Windows simples e previsível.
Não há dependência de cloud, não há serviço residente e não há atualização automática.

Formatos atuais de distribuição:

- MSI
- Portable versionado
- Unpacked para uso sem instalação

## Deploy via MSI

Arquivo esperado:

- `Central PDF 1.5.msi`

Instalação interativa:

```powershell
msiexec /i "Central PDF 1.5.msi"
```

Instalação silenciosa:

```powershell
msiexec /i "Central PDF 1.5.msi" /quiet /norestart
```

## Perfil Atual do MSI

Configuração atual:

- `oneClick: false`
- `perMachine: true`
- atalho de desktop habilitado
- sem auto-update
- sem serviço em background

## GPO

Uso recomendado:

- distribuir o MSI para grupos de usuários ou estações
- substituir o pacote quando houver nova versão
- usar política de software ou fluxo equivalente do ambiente

## SCCM

Pode ser usado sem ajuste arquitetural.

Fluxo simples:

- publicar o MSI
- instalar silenciosamente com `msiexec`
- validar abertura do executável após deploy

## Intune

O projeto está apto para empacotamento futuro via Intune porque:

- não depende de serviço local adicional
- não depende de updater
- gera artefatos previsíveis

## Modo Portátil

Arquivo versionado:

- `PDF-Next-1.5-win-x64-portable.exe`

Uso recomendado:

- ambientes restritivos
- suporte técnico
- estações sem permissão de instalação

## Execução Sem Instalação

Caminho recomendado em `latest`:

- `releases/latest/Central-PDF-win-x64.msi`
- `releases/latest/Central-PDF-win-x64-unpacked/Central PDF.exe`

O MSI mais recente fica em `releases/latest/Central-PDF-win-x64.msi`.
Para uso sem instalação, a pasta unpacked segue sendo o caminho mais confiável.

## Caminhos Padrão

### Instalado

- configurações: `%APPDATA%\Central PDF\config.json`
- logs: `%APPDATA%\Central PDF\logs\`

### Portátil / Unpacked local

- configurações: `data\config.json`
- logs: `data\logs\`

## Políticas Corporativas

Arquivo opcional:

- `C:\ProgramData\Central PDF\policy.json`

Pode ser usado para:

- forçar tema
- forçar pasta de saída
- desabilitar histórico
- ajustar retenção de logs
- definir limite máximo de arquivo

## Recomendação de Deploy

1. gerar novo build
2. executar `npm run health-check`
3. executar `npm run release-check`
4. validar visualmente a pasta `releases/latest/PDF-Next-win-x64-unpacked/`
5. distribuir MSI via canal corporativo
6. manter unpacked como contingência operacional

