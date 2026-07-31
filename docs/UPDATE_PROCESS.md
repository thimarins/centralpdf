# Processo de Atualização

## Regra Principal

Central PDF não possui auto-update.

Não existe:

- updater residente
- serviço de atualização
- download automático
- atualização silenciosa pela internet

Toda atualização deve ser conduzida manualmente pela equipe de TI.

## Quando Atualizar

Atualizações devem ser raras e objetivas, normalmente por:

- Electron
- Chromium embarcado
- pdf-lib
- correções de segurança
- compatibilidade com novos PDFs
- correções de bug

## Atualização de Dependências

Opção conservadora:

```bash
npm update
```

Opção de correção de vulnerabilidades de baixo risco:

```bash
npm audit fix
```

Observação:

- qualquer atualização de Electron deve ser validada com mais cuidado
- evitar atualizar muitas dependências ao mesmo tempo sem necessidade

## Processo Recomendado

### 1. Atualizar dependências

```bash
npm update
```

ou:

```bash
npm audit fix
```

### 2. Validar build

```bash
npm run build
```

### 3. Testes obrigatórios

Executar testes manuais mínimos:

- merge
- split
- organize
- watermark
- PDFs grandes
- PDFs corporativos reais
- exportação de diagnóstico
- modo portátil

### 4. Gerar novo pacote

```bash
npm run build:win
```

O fluxo atual:

- gera o frontend em `dist/`
- empacota fora do workspace em `%TEMP%\pdf-next-builder`
- atualiza `dist-installer/` com os artefatos mais recentes
- atualiza `releases/<versão>/` com os arquivos versionados
- atualiza `releases/latest/` com nomes estáveis para distribuição rápida

## Resultado Esperado

Ao final devem existir:

- MSI atualizado
- Portable atualizado
- `dist-installer/` atualizado
- `releases/<versao>/` atualizado
- `releases/latest/` atualizado

## Distribuição

Opções de distribuição:

- substituir MSI no GPO
- substituir pacote no Intune quando adotado
- distribuir manualmente para casos pontuais
- manter Portable para suporte e contingencia

Recomendação prática:

- para histórico e rastreabilidade, arquivar `releases/<versão>/`
- para distribuição interna rápida, usar `releases/latest/`
- `dist-installer/` pode ser usado como saída técnica local de build, mas não precisa ser a pasta oficial de distribuição

## Boas Práticas

- atualizar poucas dependências por vez
- registrar versão liberada no changelog
- manter cópia do build anterior
- validar com PDFs reais antes da distribuição
- priorizar segurança e estabilidade, não volume de mudança

## Observação sobre `win-unpacked`

O projeto não depende mais de publicar `win-unpacked` como parte do fluxo operacional.

Motivo:

- durante o desenvolvimento, o workspace pode manter lock em `app.asar`
- isso torna a reutilização direta da pasta interna de unpack menos previsível
- os artefatos oficiais de distribuição são o MSI e o Portable copiados para as pastas finais de release
