# Relatório de entrega — OCR transversal do Central PDF

## MSI 1.2.34 — estado atual — 04/11/2026

- MSI compacto: [`Central-PDF-1.2.34-win-x64.msi`](../releases/1.2.34/Central-PDF-1.2.34-win-x64.msi), também publicado como [`latest`](../releases/latest/Central-PDF-win-x64.msi); **156.753.920 bytes** (149,46 MiB), SHA-256 `101B0F262293D2831D2FFE7302E25E45DBD3C401E9B95DED94826430D2A882C2`. Os arquivos versionado, `latest` e `dist-installer` conferem. Perfil compacto com compressão máxima; o build é mais lento e não resultou em redução de tamanho.
- Extração administrativa (não instalação) passou; ProductVersion 1.2.34.0 e `app.asar` igual ao unpacked. E2E completo do EXE extraído: **21/21 etapas**; teste de licenças OCR no payload passou (3 mapeamentos + 9 avisos WASM).
- Regressões da fonte: `test:ocr-suite` passou **36/36 grupos em 696.321 ms** após o delta; inclui upload 24, segurança 29, fila 11, privacidade, offline, qpdf, todas as integrações e build/contratos 9/9. Stress 100 páginas: 55.773 ms, pico worker RSS 244 MB; OCR funcional completo 262.237 ms. SmartScan sintético (5 referências): CER 1,82%, WER 11,22%; não representa precisão corporativa.
- A telemetria agora diferencia estados `success`, `partial`, `failed`, `cancelled` e `timeout`; evento terminal não registra dados documentais. MSI continua sem assinatura digital e não foi instalado. Permanecem as pendências de ground truth corporativo autorizado, licenças/proveniência Fontkit/Canvas e inspeção visual/acessibilidade manual.

## MSI 1.2.33 — histórico de artefato — 04/11/2026

- MSI compacto: [`Central-PDF-1.2.33-win-x64.msi`](../releases/1.2.33/Central-PDF-1.2.33-win-x64.msi), também publicado como [`latest`](../releases/latest/Central-PDF-win-x64.msi); **156.745.728 bytes** (~149,45 MiB), SHA-256 `B1CA7B9E66616990475D5355815CC0C93AFA2C53B62026AA080EED7C69B558D6`. Os arquivos versionado, `latest` e `dist-installer` têm hashes iguais. Compressão máxima foi usada; o tamanho não diminuiu em relação à versão anterior.
- Extração administrativa do MSI concluída (código 0; sem instalação). `app.asar` coincide com o pacote desempacotado por SHA-256; ProductVersion 1.2.33.0. E2E do executável extraído: **21/21 etapas**. Testes de licença OCR do pacote passaram (3 mapeamentos + 9 notices WASM). Auditoria runtime estrutural reexecutada na extração do MSI; veja o estado e as pendências abaixo.
- Suíte OCR da fonte: **36/36 grupos**. Stress sintético de 100 páginas: 32.028 ms, pico RSS 264 MB. SmartScan manual sintético de cinco imagens: CER 1,82%, WER 11,22%; esses dados não representam precisão corporativa.
- O MSI não tem assinatura digital e não foi instalado. Continuam pendentes ground truth corporativo autorizado, revisão de proveniência/licenças Fontkit/Canvas, instalação em ambiente limpo e inspeção visual manual/acessibilidade.

## MSI 1.2.32 — histórico de artefato — 04/11/2026

- MSI compacto: [`Central-PDF-1.2.32-win-x64.msi`](../releases/1.2.32/Central-PDF-1.2.32-win-x64.msi), também publicado como [`latest`](../releases/latest/Central-PDF-win-x64.msi); **156.745.728 bytes**, SHA-256 `12E50947E93038F373E7838981CF399F9DECF67312467ED11A605DA6122ABF2C`. O MSI do diretório `dist-installer` é idêntico. Portable 1.2.32: 123.169.573 bytes.
- Payload MSI extraído administrativamente (código 0, sem instalação). Executável, `app.asar`, modelos `por`/`eng` e `runtime-third-party-notices.json` coincidem por SHA-256 com o pacote `win-unpacked`. ProductVersion 1.2.32.0; smoke do executável extraído passou em 2.389 ms e o novo módulo de limpeza de temporários foi localizado no ASAR.
- Validação OCR do payload: modelos e notices OCR passaram (3 mapeamentos e 9 notices WASM); auditoria runtime estrutural passou com 56/71 dependências de produção presentes. Permanecem sem notice verificado Fontkit e componentes da SBOM Canvas; não é aprovação jurídica. MSI sem assinatura e não instalado.
- Após os 34 grupos da suíte completa já aprovados na base 1.2.31, o delta 1.2.32 passou teste dedicado de cleanup, auditoria de segurança 29 checks, lint e build/contratos 14/14. Não se repetiram a suíte completa nem o E2E OCR 21/21 no 1.2.32. Ground truth autorizado, teste de instalação/ciclo de vida, inspeção visual manual e revisão jurídica permanecem parciais.
- O cleanup também foi testado integrado ao executável extraído: com TEMP isolado, o app removeu o fixture `temp-*` antigo e manteve o arquivo recente e o não temporário (2.207 ms). Esse teste e o unitário estão no runner OCR, que passou a 36 grupos; os dois foram executados individualmente, não como suíte completa.

## Revalidação consolidada da fonte 1.2.31 — 04/11/2026

- `npm run test:ocr-suite`: **34/34 grupos aprovados** em 273.628 ms. Inclui regressão de upload, teste de anexos/qpdf para ocultação, CER/WER com fixtures e amostra SmartScan autorizada, operação offline, estresse sintético de 100 páginas e contratos de build. Relatório: [`ocr-regression-suite-report.md`](../reports/ocr-regression-suite-report.md).
- Smoke de desenvolvimento passou em 8,9 s após correção do harness para iniciar Vite isolado. Smoke do `win-unpacked` passou em duas execuções (5,2 s e 3,4 s) depois de uma inicialização fria que excedeu 90 s; a causa desse timeout não foi determinada.
- MSI 1.2.31 versionado e `latest`: 156.762.112 bytes; SHA-256 `303FE5A3477BC18417DA7C01B5409F640D6DA27C97B1AC6DF4FFBE5A57AF5134`. Sem assinatura digital e não instalado, conforme orientação do usuário.
- QA adicional posterior ao MSI: auditoria visual estática 9/9, estrutura UI 73/73, lint sem erros/avisos, build/contratos `--full` 14/14 e `git diff --check` limpo. O lint levou à remoção de uma variável não usada em `action-toolbar.js`; esse delta de manutenção está na fonte, mas não no MSI 1.2.31.
- Endurecimento posterior de privacidade: temporários `temp-*` antigos (>24 h) agora são removidos na inicialização com confinamento ao diretório app-owned, limite de 5.000 entradas, sem seguir symlinks e sem registrar caminhos. Teste dedicado passou; segurança 29 checks, lint e build/contratos 14/14 passaram. A suíte OCR de 35 grupos não foi repetida após inserir esse novo grupo; não atribuir o delta ao MSI 1.2.31.
- Aceite ainda parcial: precisão real CER/WER sem corpus representativo com transcrições autorizadas; avisos/proveniência Fontkit/Canvas sem conclusão suficiente; instalação limpa/ciclo de vida MSI não validado nesta versão; revisão visual manual e falhas reais de sistema de arquivos ainda sem validação independente. Estes limites não são cobertos pelo resultado 34/34.

**MSI 1.2.31 e correção de corrida no visualizador regional (04/11/2026):** a troca de PDF invalida requisições de OCR/busca e cada operação limpa seu próprio listener, evitando resultados antigos no documento atual. MSI em `releases/1.2.31/Central-PDF-1.2.31-win-x64.msi` e `releases/latest/Central-PDF-win-x64.msi`; 156.758.016 bytes, SHA-256 `C99225E81336751A1C0254EF5077CDA0ED21CBA5417E264CA09DD454BC4A2140`. Teste focal UI 6/6, ESLint e build/contratos `--full` 14/14 passaram; notices OCR (3 mapeamentos + 9 WASM) e auditoria runtime estrutural foram executadas contra o unpacked. Startup/bootstrap passou em 8.352 ms e E2E OCR focado empacotado em 20.864 ms. As corridas de resposta atrasada são testadas no harness com APIs simuladas; a suíte agrupada completa não foi repetida após o delta, o E2E amplo não foi repetido e o MSI não foi instalado. O runtime continua com licença Fontkit sem notice verificado e o MSI não tem assinatura.

**Atualização curta — MSI 1.2.30 (04/11/2026):** publicado em `releases/1.2.30/Central-PDF-1.2.30-win-x64.msi` e `releases/latest/Central-PDF-win-x64.msi`; SHA-256 `CCB3B560AE30DEE9158D43B42A913CBA668784E56B4C84A4F77461FBD7D6FBC5`, 156.762.112 bytes. O perfil de compressão mantém o pacote em tamanho próximo de 1.2.29. Inclui sugestões revisáveis de separação por títulos recorrentes. Vite/electron-builder concluíram; startup empacotado bootstrap em 2.653 ms, testes focais de títulos, build 9, UI estrutural 72, OCR license e auditoria de runtime passaram. O E2E filtrado da separação passou em Electron dev (48.151 ms); não é execução empacotada. Não houve instalação, E2E OCR amplo nem repetição da suíte completa; ground truth corporativo CER/WER, revisão jurídica completa e assinatura digital continuam pendentes.

**Registro histórico — instalação MSI 1.2.23 (03/11/2026):** o MSI 1.2.23 foi instalado neste PC via upgrade de 1.2.22.0; o Windows Installer retornou 0. SHA-256 do MSI `6C8C320E62C8D912B73FD659E7354DED978D6287BD2E4CEDCCE7D9FE02CE860D`; sem assinatura. Naquela versão, auditoria instalada 14/14, smoke até bootstrap em 4.957 ms e E2E no executável instalado 21/21. `test:ocr-license` e auditoria runtime passaram estruturalmente; Fontkit/Canvas permaneceram sem aceite legal. OCR sintético de 1.000 páginas passou em 247.952 ms/302 MB, sem ser benchmark representativo. Esses resultados são históricos e não validam o MSI 1.2.27 descrito acima. Revisão legal, instalação limpa/desinstalação em VM e precisão CER/WER representativa continuam pendentes; não é aceite irrestrito para produção.

**Delta 1.2.23 incluído:** mensagens técnicas inesperadas da busca OCR, extração por área e fila passaram a ser traduzidas sem caminhos locais; teste de privacidade OCR, fila, suíte funcional e E2E empacotado passaram.

## Revalidação da instalação 1.2.18 — 2026-11-03

- O MSI 1.2.18 foi extraído administrativamente antes da atualização; código 0 e executável/`app.asar` conferidos com os artefatos E2E. MSI publicado: 156.758.016 bytes, SHA-256 `73A4B144BC04D13BFB30EF6B54FDEBA46F4D44A8A74F4EC3355A8D642C853F48`.
- Com autorização explícita, `msiexec /i ... /passive /norestart` atualizou o PC de 1.2.15 para 1.2.18 e retornou código 0. O registro do Windows informa `DisplayVersion 1.2.18.0`.
- Pós-instalação: `test:installed-startup` aprovou 13 verificações; `test:installed-startup-link` aprovou 3; `test:packaged-startup-smoke` abriu o executável instalado, completou o bootstrap do renderer e encerrou pelo harness em 3.102 ms ([relatório](../reports/packaged-startup-smoke.md)).
- Isto confirma atualização e inicialização neste PC, não instalação limpa em VM, upgrade/desinstalação em máquinas representativas nem assinatura. O MSI não está assinado. A árvore fonte foi posteriormente versionada como 1.2.19; não foi gerado nem instalado MSI 1.2.19.

## Resumo histórico de aceite (base 1.2.15)

O OCR está implementado como capacidade local compartilhada e integrado às operações descritas abaixo, com as limitações deste relatório. A suíte OCR completa passou **28/28 grupos** na base 1.2.15 (350.393 ms); os serviços OCR não tiveram alterações depois dessa execução. A versão 1.2.18 foi instalada neste PC e passou auditoria instalada (13 verificações), validação de atalhos (3) e startup smoke (3.102 ms); o pacote correspondente passou 21/21 E2E. O código-fonte evoluiu depois para 1.2.19, portanto os testes do pacote 1.2.18 não cobrem esse delta de UI. Permanecem lacunas legais de Fontkit/Canvas, precisão corporativa representativa, validação limpa em VM, validação independente de segurança e revisão visual/acessibilidade manual.

## Revalidação atual da 1.2.16 — 2026-11-03

- O MSI `releases/1.2.16/Central-PDF-1.2.16-win-x64.msi` tem 156.745.728 bytes e SHA-256 `3618BDD9C936DC43671583C8C715A623CC3E1CE0686817129F6D92368C399FB7`. A extração administrativa via Windows Installer terminou com código 0 em pasta temporária; não instalou nem atualizou o produto. A instalação do PC continua em 1.2.15.0.
- `npm run test:ui-app` passou **21/21** no `win-unpacked` da versão 1.2.16 em 244,9 s. O MSI extraído continha executável SHA-256 `BB0FB798B5D717365F953229C9486A991922168453F354E84D0EEF87652D7FD8` e `app.asar` SHA-256 `81196EA862E87A1F103ADB914E4F8AEAAAF7D9D796380BB5906157AF8C669E48`, idênticos aos do pacote E2E.
- `test:ocr-license` passou contra a extração do MSI: três mapeamentos de licença e nove avisos de dependências WASM. A auditoria runtime do payload reportou 56/71 dependências de produção presentes, 50 licenças locais, 5 avisos centrais, 15 dependências fora da build/plataforma e `@pdf-lib/fontkit@1.1.1` sem aviso verificado; nove componentes da SBOM Canvas não trazem expressão SPDX e três continuam sem licença upstream verificada. Não converter resultado estrutural em aprovação jurídica.
- Na fonte 1.2.16, `test:build` passou 6 checks, `test:visual` 9 e `test:ui-structure` 71. A suíte OCR 28/28 continua validando a base 1.2.15, pois os serviços OCR não mudaram desde aquela execução.
- O MSI não foi instalado nem assinado. A pasta versionada `releases/1.2.16` foi criada pelo processo de release, sem substituir a instalação 1.2.15. A validação em VM limpa, upgrade/desinstalação, revisão visual manual e evidência jurídica continuam pendentes.

## Histórico de verificação da base 1.2.15 — 2026-11-03

- `npm run test:ocr-suite` na fonte **1.2.15**: 28/28 grupos aprovados em 350.393 ms; inclui uploads (23), auditoria transversal (13), segurança (28), fluxos funcionais (40), fila, cancelamento, memória de renderização, CER/WER, OCR offline, escala 100 páginas, OCR funcional e build.
- `npm run test:ui-app` no executável extraído do MSI 1.2.15: **21/21** numa execução completa, incluindo OCR básico/completo/refazer, cancelamento em lote, OCR em imagens→PDF, Word híbrido, busca, organização, ocultação, segurança e assinatura.
- `npm run test:ocr-license`: passou no payload (modelos e avisos OCR conferidos). `npm run test:runtime-license-audit`: passou como verificador estrutural; 56 dependências de produção no payload, 50 com licença local, 5 com aviso central, 15 fora desta build/plataforma e uma sem aviso verificado (`@pdf-lib/fontkit@1.1.1`). A SBOM Canvas foi conferida quanto ao arquivo/hash, mas três componentes de origem/binário seguem sem licença/proveniência equivalente completa.
- MSI 1.2.15 extraído de forma administrativa: `test:installed-startup` passou 12 verificações aplicáveis, `test:ocr-license` e `test:runtime-license-audit` passaram; `test:packaged-startup-smoke` confirmou `renderer-did-finish-load` e `renderer-bootstrap-complete` em 2.853 ms. O smoke limpa a árvore do processo após observar a inicialização; extração administrativa não equivale à instalação MSI.
- No mesmo executável extraído do MSI 1.2.15, `test:ui-app` filtrado para `ocr-complete,ocr-redo` passou: OCR completo de 2 páginas em 22.269 ms e refazer OCR em 19.026 ms, preservando o original. Os outros 19 cenários foram intencionalmente ignorados; isto não substitui a bateria E2E completa.
- Em seguida, `test:ui-app` sem filtro passou **21/21** no executável extraído do MSI 1.2.15 (aprox. 153 s). Incluiu upload/preview, OCR básico/completo/refazer/cancelamento, mesclagem, separação nativa e por OCR, compressão, proteção/desbloqueio, Word híbrido, marca-d’água, organização, assinatura e ocultação. Isso valida o payload extraído em execução automatizada, não o fluxo do Windows Installer.
- A auditoria do lock encontrou versões vulneráveis antigas de PDF.js e nanoid, embora o diretório instalado de testes já usasse versões corrigidas. Fixei PDF.js em 6.2.108 e alinhei as entradas corrigidas no lock; `npm audit` (completo e produção) passou sem vulnerabilidades, e os testes de licenças/manifesto/payload passaram novamente. A sincronização global via CDN SheetJS foi recusada por certificado TLS local; não se desativou TLS e `npm ci` não foi alegado/testado.
- O MSI 1.2.15 já existia em `releases`; naquela etapa foi extraído, não instalado. Na revalidação posterior desta sessão, constatou-se que a instalação real já era 1.2.15 e correspondia exatamente ao payload do MSI. A primeira tentativa histórica de smoke do pacote extraído não atingiu o renderer, mas a repetição atingiu o bootstrap em 2,9 s; a falha não se reproduziu.
- Revalidação na fonte **1.2.16** após as alterações de HTML/CSS: `npm run test:build` passou 6 checks, `npm run test:visual` passou 9 e `npm run test:ui-structure` passou 71. São auditorias do código/UI e não substituem inspeção manual de screenshots em diferentes resoluções, DPI e temas. A comparação dos arquivos mostra que as mudanças posteriores à suíte OCR 28/28 foram no renderer/estilos; os serviços OCR não mudaram.
- A instalação real já está em **1.2.15.0**, portanto não foi reinstalada. `test:installed-startup` passou 13 verificações, `test:installed-startup-link` passou 3 e `test:packaged-startup-smoke` alcançou o bootstrap do renderer em 19,253 s. O MSI 1.2.15 tem SHA-256 `350D427925D25DF9C5E4599A265068915580ADC4F682416C294A0C9FD466313B`; executável e `app.asar` instalados são idênticos aos do payload MSI. Isso confirma correspondência da instalação existente, não valida uma instalação limpa.

| Situação | Escopo |
| --- | --- |
| IMPLEMENTADO E TESTADO | Motor Tesseract.js offline, modelos `por`/`eng`, modos automático/completo/refazer, intervalos, PDF pesquisável/TXT, imagens e TIFF multipágina dentro dos limites, OCR regional, pesquisa, fila/cancelamento e integrações funcionais. Testes descritos abaixo; a cobertura é de fixtures e não garante comportamento em qualquer documento. |
| IMPLEMENTADO E TESTADO COM LIMITES | PDF para Word híbrido, busca/redação assistida por OCR, separação por palavra/frase e sugestões revisáveis de títulos recorrentes (fixture sintético híbrido nativo+OCR; sem validação em corpus real), pré-processamento adaptativo, stress sintético e MSI/portable 1.2.34 empacotados. O MSI 1.2.34 extraído passou E2E completo 21/21; não houve instalação. Cada linha da matriz registra limites específicos. |
| PARCIALMENTE IMPLEMENTADO / ACEITO | Redação definitiva além dos fixtures, logs/diagnósticos transversais, precisão real representativa, recuperação após falhas reais de Windows/armazenamento, qualidade de layout complexa em Word/tabelas e revisão manual visual/acessibilidade. A regressão de privacidade cobre agora também o fallback do logger quando o arquivo de log não pode ser gravado; isso não equivale a auditoria de todos os canais de console da interface. |
| NÃO IMPLEMENTADO (decisão registrada) | OCRmyPDF: não foi adicionado porque elevaria dependências/runtime e não há requisito que justifique substituir o serviço Tesseract.js local. |
| NÃO APLICÁVEL COMO GARANTIA | Detectar todos os dados sensíveis automaticamente ou prometer reconstrução fiel de layout/tabelas a partir do OCR. O fluxo exige revisão e documenta essas limitações. |

## 1. Diagnóstico inicial

O projeto é Electron. A arquitetura já possuía processamento em worker/fila, PDF.js para leitura/renderização, pdf-lib para alterações, conversão para Word e notificações compartilhadas. O OCR reutiliza esses serviços; não cria um motor separado por módulo. OCRmyPDF foi avaliado e não incluído. A auditoria de arquitetura e as integrações deliberadamente não-OCR constam em [OCR.md](OCR.md).

## 2–4. Componentes alterados, recursos criados e módulos integrados

Principais áreas (lista representativa; não substitui `git diff`):

- Motor/serviço: `src/main/services/ocr/`, runtime/modelos, telemetria sanitizada e integração IPC/worker em `src/main/index.js`, `src/main/worker-runtime.js` e `src/main/pdf-operation-worker.js`.
- Integrações: `src/main/services/conversion/pdf-to-word.js`, `src/main/services/conversion/text-extractor.js`, `src/main/services/image-conversion/`, `src/main/pdf-service.js` e operações de mesclagem, separação, compressão, organização e ocultação.
- Interface/ajuda: `src/renderer/ui/ocr/`, `src/renderer/ui/redact/`, workspaces de Word e imagem-PDF, `src/renderer/index.html` e `src/renderer/app.js`.
- Distribuição e qualidade: `vendor/ocr/`, inventários de licença, `electron-builder.json`, `scripts/testing/run-ocr-*`, `docs/OCR.md` e a matriz de aceite.

Recursos: PDF/imagem pesquisável, extração TXT, páginas e intervalos, lote, idiomas português/inglês/combinado, modos automático/completo/refazer OCR rastreável, detecção de páginas nativas/digitalizadas/híbridas, extração regional e busca com destaque. PDF para Word pode sugerir OCR após análise limitada; imagens para PDF oferecem OCR na mesma operação; mesclagem mantém caminho convencional e OCR opcional; separação por conteúdo oferece busca e sugestões revisáveis de títulos recorrentes (até 500 páginas); ocultação usa OCR para sugerir regiões; compressão/organização têm regressões de preservação de texto. As sugestões por títulos e a correção de corrida no visualizador regional estão incluídas no MSI 1.2.31; continuam sem validação em corpus corporativo real.

## 5. Dependências e licenças

Versões resolvidas no ambiente atual (a versão do pacote e a licença declarada não equivalem, por si só, a revisão jurídica completa):

| Dependência | Versão local | Licença declarada | Uso / estado de aviso |
| --- | ---: | --- | --- |
| `tesseract.js` | 7.0.0 | Apache-2.0 | Motor OCR; pacote e avisos OCR incluídos e testados no payload anterior. |
| `tesseract.js-core` | 7.0.0 | Apache-2.0 | Core/WASM local; aviso incluído e testado no payload anterior. |
| `pdfjs-dist` | 6.2.108 | Apache-2.0 | Leitura/renderização e extração; licença upstream disponível. |
| `pdf-lib` | 1.17.1 | MIT | Construção/alteração de PDFs. |
| `@napi-rs/canvas` | 1.0.13 | MIT | Raster e processamento local; a SBOM do binding nativo ainda requer revisão de completude. |
| `@pdf-lib/fontkit` | 1.1.1 | MIT declarado | Necessário para fontes customizadas; faltam notices/proveniência completos do bundle e componentes embutidos. A gate legal permanece aberta. |
| `utif` | 3.1.0 | MIT | Leitura TIFF multipágina. |

O inventário e a análise de componentes estão em [runtime-license-audit.md](runtime-license-audit.md). A cobertura atual não autoriza afirmar que todos os avisos do payload binário Canvas/Fontkit foram satisfeitos; não se atribuiu texto de licença por inferência.

## 6. Arquitetura

O serviço OCR centraliza validação, modos/intervalos, detecção de necessidade, worker Tesseract, orientação/pré-processamento, geração da camada invisível, extração/busca e limpeza. PDF.js lê/renderiza páginas sob limites; pdf-lib só reescreve quando a operação precisa alterar o documento. A fila/worker mantém trabalho pesado fora da thread principal, com progresso, cancelamento e isolamento de falhas. Modelos são locais, validados por tamanho/hash e não exigem instalação separada do Tesseract. A camada pública IPC aplica validação dos parâmetros; logs/telemetria não devem conter texto reconhecido.

## 7. Histórico de testes da fonte 1.2.13

Última evidência desta retomada:

- `npm run test:ocr`: aprovado em 26/26 grupos (328.745 ms); inclui PDF/imagens, páginas híbridas, saída pesquisável, teste de orientação 90°/180°/270°, busca e limites das caixas. A asserção de 180° confirma que o destaque acompanha o lado espelhado no raster original.
- `npm run test:ocr-synthetic-corpus`: aprovado; 28 imagens válidas e uma imagem corrompida isolada. 27 comparações sequenciais com CER/WER 0% nesta execução; a rotação de 180° teve cobertura de tokens 100% e CER/WER auxiliares 0% após normalizar a ordem das linhas. Não é estimativa de acurácia real.
- `npm run test:ocr-redaction-patterns`: aprovado; seis casos de presets (CPF, CNPJ, telefone, e-mail, datas) mais expressão personalizada literal, caixa e limites.
- `npm run test:ocr-log-privacy`: aprovado após corrigir classificação de PDF protegido/inválido e adicionar cobertura do fallback do logger para falha de gravação (`EACCES`), sem expor erro bruto/caminho no console. A busca OCR de ocultação também não despeja exceções PDF.js e apresenta mensagem orientativa em português.
- `npm run test:ocr`: suíte agregada aprovada **26/26 grupos** (328.745 ms; relatório `reports/ocr-regression-suite-report.md`). Inclui regressões de upload, privacidade, segurança, OCR offline e stress sintético. Após a última alteração de privacidade do fallback do logger, o teste focal `test:ocr-log-privacy`, build de 6 checks e ESLint também passaram.
- `npm run test:ocr-corpus-metrics`: aprovado; métricas Unicode, CSV multilinha, referências vazias e páginas em branco.
- `npm run test:build`: aprovado, seis checks; `npm run test:e2e-script`: aprovado; ESLint dos arquivos alterados e `git diff --check` aprovados.
- `npm run test:ocr-license`: aprovado contra o payload `win-unpacked` 1.2.13 (3 mapeamentos de licença OCR e 9 avisos WASM coincidiram byte a byte com a fonte); também havia evidência histórica no MSI QA 1.2.10.
- `npm run test:runtime-license-audit`: aprovado estruturalmente contra o `win-unpacked` 1.2.13; inventário consistente, cinco avisos centrais, com a lacuna Fontkit e três componentes Canvas sem proveniência equivalente explicitamente abertos. Detalhes em [runtime-license-audit.md](runtime-license-audit.md).
- O primeiro delta de privacidade em Organizar passou `test:ocr-log-privacy`, ESLint, build de 6 checks e E2E no `win-unpacked` 1.2.13 (pesquisa/seleção de página e organização, 2 cenários). Uma alteração posterior, restrita à tradução de erros da busca OCR, passou teste focal, ESLint e build; não foi reempacotada/E2E.

**E2E empacotado:** os 21 cenários passaram individualmente no `win-unpacked` 1.2.13 em três execuções filtradas; a primeira foi interrompida pelo usuário após 15 passos e os restantes foram executados em filtros focados. O [relatório combinado](../reports/ui-app-e2e-segmented-1.2.13.md) deixa explícito que não foi uma única execução sem filtro. Ainda não há MSI 1.2.13 nem instalação normal/limpa. O MSI extraído histórico 1.2.10 não comprova o payload atual.

## 8–9. Precisão e desempenho

- Fixture sintético atual: 27 amostras sequenciais, CER/WER 0% nesta rodada; página girada avaliada à parte, com ordem espacial normalizada; arquivo corrompido isolado. Isso mede regressão controlada, não precisão de documentos corporativos.
- Referência SmartScan anotada: três amostras sequenciais apresentaram CER 2,22% e WER 11,44%; há uma quarta amostra girada avaliada por tokens. As demais 356 imagens do lote de 360 não têm transcrição de referência. Portanto a precisão real representativa está PARCIALMENTE VALIDADA.
- Escala registrada em execuções anteriores: OCR de 1.000 páginas sintéticas e lote de 100 imagens passaram, com consumo/tempo variável descrito em [status de implementação](OCR-implementation-status.md). São medições locais, não SLA; não houve benchmark controlado em equipamentos corporativos representativos.

## 10. Problemas encontrados e corrigidos

Evidências registradas incluem: alinhamento da camada de texto invisível e mapeamento de caixas em páginas giradas; seleção prematura de orientação corrigida para avaliar candidatos 90°/270°/180°; Buffer JPEG agrupado com `byteOffset` não zero ao incorporar no pdf-lib; texto de páginas fora do intervalo indevidamente exportável em TXT; isolamento de falha individual; e proteção contra persistência temporária em testes de cancelamento/falha. Os testes atuais confirmam as regressões relevantes para a orientação; outros itens são históricos e estão identificados por data/versão nos relatórios.

## 11–12. Limitações e itens não implementados

- Precisão CER/WER de documentos reais não é mensurável no corpus de 360 itens sem transcrição. É necessário ground truth autorizado, anonimizado e revisado.
- Não há reconstrução garantida de layouts, tabelas complexas, perspectiva ou deskew avançado. A implementação adaptativa é limitada e só escolhe alternativa se a pontuação do OCR melhorar.
- OCR não garante encontrar todos os dados confidenciais; a ocultação exige revisão. Recuperação foi testada em fixtures sintéticas, não em uma bateria independente de PDFs adversariais.
- Falhas reais de ACL, disco cheio, bloqueio de arquivo e encerramento abrupto não foram reproduzidas em Windows limpo; há simulações automatizadas.
- Não se implementou OCRmyPDF nem busca OCR global independente do visualizador; a busca OCR disponível fica nos fluxos documentados de OCR/organização/ocultação.
- TIFF tem limites de tamanho/pixels/páginas e codecs incomuns podem não ser suportados. A camada OCR e operações completas/refazer ainda podem exigir o PDF inteiro na memória quando alteram o arquivo.

## 13–15. Evidências, instalação e próximos passos

Evidências detalhadas: [matriz de aceite](OCR-acceptance-matrix.md), [histórico de implementação](OCR-implementation-status.md), [guia de uso](OCR.md), [auditoria de runtime/licenças](runtime-license-audit.md) e relatórios em `reports/`.

O artefato atual é o MSI **1.2.34** descrito no início deste relatório. Foi extraído administrativamente, validado em E2E (21/21) e não foi instalado; portanto não há evidência atual de ciclo real do Windows Installer (instalação/upgrade/desinstalação) em máquina limpa ou VM. Próximas etapas: resolver a suficiência dos notices Fontkit/Canvas com evidência upstream ou revisão jurídica; obter transcrições de referência autorizadas para medir CER/WER corporativo; executar revisão visual/acessibilidade manual; e validar instalação e upgrade MSI em ambiente descartável autorizado.

**Riscos remanescentes:** precisão desconhecida em documentos reais representativos; falsos negativos na localização OCR de dados sensíveis; lacunas de notice/proveniência Fontkit/Canvas; MSI sem assinatura e sem instalação real verificada; falta de revisão visual/acessibilidade manual; e variação de desempenho conforme memória, qualidade do scan e hardware.
