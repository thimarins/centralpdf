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

## Rollback (reverter uma versão com problema)

Se uma versão distribuída apresentar um bug crítico (perda de dados, crash
recorrente, falha de segurança), o procedimento é reinstalar a última versão
estável conhecida — não existe atualização automática que reverta sozinha.

### 1. Identificar a última versão estável

- Verificar `docs/CHANGELOG.md` para saber qual versão anterior foi validada
  em produção sem incidentes.
- Confirmar que os artefatos dessa versão ainda existem em
  `releases/<versão-anterior>/` (por isso a boa prática de nunca apagar
  releases antigas — ver "Boas Práticas" acima).

Se os artefatos da versão anterior **não** existirem mais localmente (ex.:
pasta `releases/<versão-anterior>/` foi removida), é necessário rebuildar
essa versão a partir da tag/commit correspondente no Git:

```bash
git checkout <tag-ou-commit-da-versao-anterior>
npm ci
npm run build:win
git checkout main
```

### 2. Desinstalar a versão com problema

Via MSI (instalação corporativa):

```powershell
msiexec /x "Central PDF <versão-com-problema>.msi" /quiet /norestart
```

Ou, se o MSI original não estiver mais disponível, remover pelo Painel de
Controle / `Apps e recursos` do Windows.

Para instalação Portable, basta descartar a pasta/execução atual — não há
estado de instalação para desfazer.

### 3. Reinstalar a versão anterior estável

```powershell
msiexec /i "Central PDF <versão-anterior>.msi" /quiet /norestart
```

### 4. Redistribuir via GPO/Intune

- Apontar o pacote publicado no GPO/Intune de volta para o MSI da versão
  anterior.
- Manter a versão com problema fora de qualquer política de distribuição
  ativa até a correção ser validada.

### 5. Registrar o incidente

- Adicionar uma entrada em `docs/CHANGELOG.md` documentando: qual versão foi
  revertida, o motivo (resumo do bug), e a versão para a qual se reverteu.
- Isso evita que a mesma versão problemática seja redistribuída por engano
  no futuro.

### Retenção mínima recomendada

Para que o rollback acima seja sempre possível, mantenha em `releases/` os
artefatos de, no mínimo, as **duas últimas versões estáveis** distribuídas
em produção — não apenas a `latest`.

## Observação sobre `win-unpacked`

O projeto não depende mais de publicar `win-unpacked` como parte do fluxo operacional.

Motivo:

- durante o desenvolvimento, o workspace pode manter lock em `app.asar`
- isso torna a reutilização direta da pasta interna de unpack menos previsível
- os artefatos oficiais de distribuição são o MSI e o Portable copiados para as pastas finais de release
