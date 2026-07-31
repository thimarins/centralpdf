# Testing

O Central PDF agora possui uma bateria de validação simples e sustentável para apoiar manutenção de longo prazo, smoke tests de release e revisão corporativa antes da distribuição.

## Comandos principais

- `npm run test:assets`
  - Gera ou atualiza os ativos sintéticos em `test-assets/generated/`.
- `npm run test:functional`
  - Valida merge, split, organize, compress, watermark, exportação de diagnóstico e modos portátil/instalado.
- `npm run test:queue`
  - Valida fila, retry, timeout, cancelamento, overlap guard e recuperação de estado.
- `npm run test:security`
  - Faz auditoria automatizada de hardening Electron e padrões inseguros comuns.
- `npm run test:architecture`
  - Gera `reports/architecture-report.md` com ciclos, arquivos potencialmente órfãos e arquivos grandes.
- `npm run test:repo`
  - Procura `TODO`, `FIXME`, `console.log`, `debugger` e paths hardcoded sensíveis.
- `npm run test:performance`
  - Mede tempos e delta de memória de operações centrais de PDF.
- `npm run test:visual`
  - Faz auditoria estática de tipografia, Fluent UI, reduced motion e consistência visual básica.
- `npm run test:build`
  - Roda `npm run build` e valida `dist/` sem sourcemaps indevidos.
- `npm run health-check`
  - Executa a bateria principal e gera `reports/health-report.md`.
- `npm run release-check`
  - Executa `health-check` + `build:win` e gera `reports/release-check-report.md`.

## Estrutura

- `scripts/testing/`
  - Scripts de validação e auditoria.
- `test-assets/`
  - README, manifest e ativos gerados localmente.
- `reports/`
  - Relatórios Markdown gerados pela suíte.
- `.tmp-test-runs/`
  - Workspace temporário usado pelos testes.

## O que a suíte cobre

### Funcional

- merge PDFs
- converter imagens, documentos Word e planilhas Excel para PDF
- split por páginas, intervalo e tamanho
- organize pages
- watermark por texto e imagem
- compress
- exportação de diagnóstico
- portable mode
- installed mode

### Operacional

- cancelamento de fila
- retry controlado
- timeout
- recuperação de estado persistido
- bloqueio de overlap de arquivos

### Segurança

- `contextIsolation`
- `sandbox`
- `nodeIntegration: false`
- CSP presente
- `requestSingleInstanceLock()`
- bloqueio de novas janelas
- bloqueio de navegação externa
- scan de `eval`, `Function`, `exec`, `shell: true`

### Arquitetura e higiene

- dependências circulares
- arquivos potencialmente órfãos
- arquivos fonte muito grandes
- `TODO` / `FIXME`
- `console.log`
- `debugger`
- paths hardcoded sensíveis

### Performance

- merge
- split
- compressão
- watermark em lote
- delta de RSS por operação

### Visual estático

- Segoe UI Variable
- Fluent UI System Icons
- reduced motion
- títulos com ícones
- botões de ação com ícones
- ausência de emojis decorativos

## Ativos de teste

Os ativos são gerados localmente para evitar versionar binários pesados.

Exemplos:

- PDFs pequenos
- PDFs médios
- PDFs com muitas páginas
- PDFs com imagens pesadas
- PDFs corrompidos
- PDFs renomeados falsos
- PDFs virtuais grandes, enormes e próximos do limite
- imagens PNG, JPG e SVG para watermark

Observação importante:

- os PDFs gigantes gerados pela suíte são esparsos e usados principalmente para validar limites, warnings e comportamento conservador
- eles não pretendem simular com perfeição um documento real de vários GB

## Relatórios gerados

- `reports/functional-report.md`
- `reports/queue-report.md`
- `reports/security-report.md`
- `reports/architecture-report.md`
- `reports/repo-audit.md`
- `reports/performance-report.md`
- `reports/visual-audit.md`
- `reports/build-report.md`
- `reports/health-report.md`
- `reports/release-check-report.md`

## Fluxo recomendado antes de release

1. `npm run health-check`
2. Revisar warnings em `reports/health-report.md`
3. `npm run release-check`
4. Validar manualmente a pasta `releases/latest/PDF-Next-win-x64-unpacked/`
5. Distribuir MSI ou unpacked somente se os relatórios estiverem saudáveis

## Troubleshooting

- Se os ativos estiverem ausentes, rode `npm run test:assets`
- Se um teste funcional falhar após mudança no pipeline de PDF, apague `.tmp-test-runs/` e rode novamente
- Se `release-check` demorar, isso é esperado, porque inclui `build:win`
- Se algum relatório apontar arquivo muito grande ou órfão, trate isso antes da próxima release
- Se os testes de modo portátil falharem, confira `portable.txt` e o comportamento de `PORTABLE_EXECUTABLE_DIR`

## Filosofia

A suíte evita framework pesado e mocks excessivos.

O foco é:

- detectar regressão perigosa
- gerar relatórios legíveis
- manter comandos simples
- apoiar manutenção sustentável do Central PDF no longo prazo
