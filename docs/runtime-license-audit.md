# Auditoria de avisos de runtime — 2026-11-02

## Payload MSI 1.2.34 — 04/11/2026

- Repetido `test:runtime-license-audit` sobre o conteúdo extraído administrativamente do MSI 1.2.34 (sem instalação): 71 dependências runtime no lock, 56 no `app.asar`, 50 com licença local, 5 cobertas por notices centrais, 15 fora da build/plataforma.
- A única dependência presente sem aviso verificado é `@pdf-lib/fontkit@1.1.1` (MIT declarado, sem arquivo LICENSE incluído). A discussão pública específica do bundle ainda lista cinco questões de proveniência/notices sem confirmação do mantenedor: [discussão upstream #1791](https://github.com/Hopding/pdf-lib/discussions/1791). Não inventar ou atribuir notice por inferência.
- Canvas 1.0.13: SBOM com 142 componentes, 9 sem expressão SPDX e 3 sem licença/proveniência de registry verificada (`skia.win32-x64-msvc.node`, `canvas`, `skia-fontations`). O [repositório upstream do Canvas](https://github.com/Brooooooklyn/canvas) confirma que é um binding de Skia; ainda assim a auditoria do pacote não resolve a cadeia de notices completa do binário Windows.
- MSI SHA-256 `101B0F262293D2831D2FFE7302E25E45DBD3C401E9B95DED94826430D2A882C2`; `test:ocr-license` também passou contra o payload. Verificações são estruturais e não constituem parecer jurídico nem autorização de distribuição comercial.

## Revalidação MSI 1.2.33 — 04/11/2026

- `test:runtime-license-audit` executado contra o diretório extraído administrativamente do MSI 1.2.33 (não instalado): lock de 71 dependências de produção; 56 presentes no `app.asar`; 50 com arquivos de licença locais; 5 com notices centrais; 15 ausentes por plataforma/build.
- A lacuna runtime permanece: `@pdf-lib/fontkit@1.1.1` está presente sem notice standalone ou central verificado. A SBOM do Canvas 1.0.13 apresenta 142 componentes, 9 sem expressão SPDX e 3 sem licença/proveniência de registry confirmada (`skia.win32-x64-msvc.node`, `canvas`, `skia-fontations`). Os metadados de seis crates do registry e dois commits-fonte locais foram conferidos; isso não prova cobertura integral de notices no binding nativo nem resolve o bundle Fontkit.
- `test:ocr-license` com `CENTRAL_PDF_OCR_PACKAGE_DIR` ativo também passou, verificando os modelos e notices OCR do payload. A auditoria de runtime é estrutural; o resultado **não constitui aprovação jurídica**. MSI não assinado e não instalado.

## Revalidação MSI 1.2.32 — 04/11/2026

- O MSI `releases/1.2.32/Central-PDF-1.2.32-win-x64.msi` foi extraído administrativamente (sem instalação); `test:ocr-license` e `test:runtime-license-audit` foram executados contra a extração. Resultado runtime permanece: 56/71 dependências presentes, 50 licenças locais, 5 notices centrais, 15 dependências ausentes por plataforma/build e uma presente sem notice verificado: `@pdf-lib/fontkit@1.1.1`.
- O executável, `app.asar`, modelos `por`/`eng` e notices comparados ao `win-unpacked` conferem por SHA-256. O Canvas continua com SBOM de 142 itens, 9 sem expressão SPDX e 3 componentes sem licença/proveniência de registry confirmada. Não declarar aceite comercial nem parecer jurídico; MSI segue sem assinatura.

## Win-unpacked da compilação MSI 1.2.31 — 2026-11-04

- Reexecução em `releases/1.2.31/Central-PDF-win-x64-unpacked`: 56 de 71 dependências runtime presentes, 50 com licença local, 5 com aviso central e 15 ausentes por plataforma/arquitetura. O único pacote presente sem aviso verificável continua sendo `@pdf-lib/fontkit@1.1.1` (declara MIT no lockfile, mas não inclui licença isolada nem notice central).
- Para o Canvas 1.0.13, a SBOM tem 142 componentes; 9 não declaram expressão SPDX e 3 continuam sem licença de registry verificada (`skia.win32-x64-msvc.node`, `canvas`, `skia-fontations`). `npm run test:ocr-license` passou no unpacked (3 mapeamentos + 9 notices WASM). Essas verificações são estruturais, não parecer jurídico nem conferência byte a byte do conteúdo extraído do MSI.
- O MSI 1.2.31 não foi instalado nem extraído nesta rodada. A auditoria confirma o diretório `win-unpacked` que acompanha a build, não substitui inspeção do payload MSI instalado. O gap Fontkit/Canvas permanece como pendência para distribuição comercial.

## Payload MSI 1.2.29 — 2026-11-04

- A extração administrativa do MSI 1.2.29 terminou com código 0 e não instalou nem registrou o produto. Foram comparados por SHA-256 o executável, `app.asar`, modelos OCR português/inglês e `runtime-third-party-notices.json` extraídos com o diretório `win-unpacked`; todos coincidiram.
- `test:ocr-license` passou com a verificação do payload MSI ativada. `test:runtime-license-audit` também passou estruturalmente: 71 dependências runtime no lockfile, 56 presentes no `app.asar`, 50 licenças locais, 5 avisos centrais, 15 dependências ausentes desta build/plataforma e **1 pacote sem aviso verificado**, `@pdf-lib/fontkit@1.1.1`. Para Canvas, a SBOM contém 142 componentes e 9 sem expressão de licença; os metadados de seis crates foram verificados, permanecendo três proveniências sem licença de registry verificada.
- O E2E `startup renderer` + `ocr` passou sobre `Central PDF.exe` extraído diretamente do MSI. Não foi feita instalação, atualização ou desinstalação. Portanto, esta evidência confirma o payload e o fluxo OCR focal, mas não fecha as lacunas legais/proveniência, que continuam como gate para distribuição comercial.
- Identificação do MSI: 156.749.824 bytes; SHA-256 `6032F87F4E7E01E7D0E4E0C50F0744D56365D8A1D53658D2CD21AF0D14842E64`. `releases/latest/Central-PDF-win-x64.msi` tem o mesmo hash.

# Atualização upstream — 2026-11-03

- `foliojs/fontkit` agora tem um `LICENSE` MIT no branch `master`, incluído pelo PR #300 em 2/11/2026, com aviso `Copyright (c) 2014-present Devon Govett`. Isso corrige a ausência de arquivo na árvore atual desse upstream. Não prova, por si só, que esse aviso cobre exatamente o fork e o bundle `@pdf-lib/fontkit@1.1.1` distribuído pelo Central PDF, nem os componentes incorporados ao bundle; o pacote local 1.1.1 continua sem `LICENSE`.
- A discussão #1791 permanece marcada **Unanswered**: existe uma resposta comunitária que reproduz a composição e lista cinco pontos de proveniência/notice ainda abertos, mas não há resposta do mantenedor. O issue #1793 foi encerrado automaticamente pelo bot por inatividade, não por solução técnica. Fontes: [discussão exata do pacote 1.1.1](https://github.com/Hopding/pdf-lib/discussions/1791), [issue fechado por stale](https://github.com/Hopding/pdf-lib/issues/1793), [PR upstream #300 mesclado](https://github.com/foliojs/fontkit/pull/300), [LICENSE atual de foliojs/fontkit](https://github.com/foliojs/fontkit/blob/master/LICENSE).
- O issue do Canvas #1360 permanece aberto e solicita proveniência de um binário Windows x64 **1.0.9**; é apenas contexto para os riscos de notices estáticos, não evidência conclusiva da composição de `@napi-rs/canvas@1.0.13` usado aqui. A SBOM 1.0.13 e os arquivos exatos do MSI continuam sendo a base local da auditoria.
- **Resultado:** avanço upstream parcial para o projeto original fontkit; sem confirmação aplicável ao fork/bundle usado, não alterei o inventário e mantenho o gate de distribuição comercial pendente. Não inferir que o MSI QA está legalmente liberado.

## Rechecagem da discussão Fontkit — 2026-11-04

- A discussão #1791 continua rotulada **Unanswered** (sem resposta do mantenedor), mas agora contém uma resposta comunitária com reprodução independente do tarball `@pdf-lib/fontkit@1.1.1`: o autor relata que os bundles reconstruídos coincidem com os publicados, exceto finais de linha, e enumera dependências/notices incorporados. A resposta identifica, entre outros, headers Apache-2.0 do código Google Brotli, `ieee754` BSD-3-Clause, `pako` MIT/Zlib na variante UMD, componentes ISC e atribuição Joyent em `string_decoder`.
- A própria pessoa que abriu a discussão confirmou a reprodução, diz ter resolvido 27 de 32 registros e lista cinco pontos ainda sem proveniência/notice upstream suficiente: wrapper/fork Brotli, alterações de `@pdf-lib/restructure`, aviso histórico de `dfa`, origem/licença de tabelas de `iconv-lite` e notice do código embutido `rollup-plugin-node-globals`. Trata-se de análise técnica reproduzível de participantes, não confirmação de mantenedor nem parecer jurídico; por isso não copiei atribuições para o inventário sem revisão de cada texto/licença.
- Fontes primárias consultadas: [discussão #1791 e resposta reproduzível](https://github.com/Hopding/pdf-lib/discussions/1791), [issue #1793](https://github.com/Hopding/pdf-lib/issues/1793). O bloqueio de Fontkit permanece, mas agora está descrito com a evidência mais recente e separa claramente itens identificados dos cinco itens ainda em aberto.

## Precisão do status de `@pdf-lib/fontkit@1.1.1` — 2026-11-03

- A licença declarada pelo pacote não é desconhecida: tanto o `package.json` local/lockfile quanto a página oficial do pacote npm indicam **MIT**; os metadados também listam Andrew Dillon como autor e Devon Govett como colaborador. Inventário local do diretório 1.1.1 confirma que não há arquivo raiz `LICENSE` no artefato instalado.
- A pendência é de suficiência/proveniência do aviso distribuído, não de ausência do campo SPDX/license: falta um conjunto completo e autoritativo de copyright/licenças para o fork e os componentes embutidos no bundle. Não converti autor/contribuidor em titulares de copyright sem confirmação. A discussão upstream específica continua sem resposta de mantenedor e enumera cinco questões de proveniência ainda abertas.
- Fontes: [metadados oficiais do pacote npm](https://www.npmjs.com/package/%40pdf-lib/fontkit), [pedido de esclarecimento sobre o artefato exato](https://github.com/Hopding/pdf-lib/discussions/1791). Essa distinção melhora a precisão do inventário, mas **não fecha o gate de distribuição** nem constitui parecer jurídico.

## Pinagem do artefato Fontkit — 2026-11-03

- O `package-lock.json` registrava `@pdf-lib/fontkit@1.1.1` sem URL nem integridade do tarball, e o `package.json` aceitava versões futuras via `^1.1.1`. Fixei a dependência em `1.1.1` e acrescentei ao lockfile o tarball oficial e o SHA-512 publicados pelo registry npm (`npm view @pdf-lib/fontkit@1.1.1 dist --json`). Isso faz instalações futuras validarem o conteúdo resolvido contra o digest do registry e impede atualização implícita para outra versão.
- Esta alteração melhora reprodutibilidade e cadeia de suprimentos, mas não confirma que os bytes já instalados localmente correspondem ao tarball nem resolve os avisos de copyright/componentes embutidos descritos acima. Não gera MSI nem muda o binário desta versão. A auditoria posterior, registrada abaixo, completou URL/hash em todas as 419 entradas versionadas do lockfile.

## Pinagem do núcleo PDF usado pelo OCR — 2026-11-03

- A mesma lacuna existia nas dependências de execução diretamente usadas na geração/leitura de PDFs. Acrescentei `resolved` e `integrity` do registry para `pdf-lib@1.17.1`, `@pdf-lib/standard-fonts@1.0.0`, `@pdf-lib/upng@1.0.1` e `pako@1.0.11`, consultados por `npm view <pacote>@<versão> dist --json`.
- `package.json` e a entrada raiz do lockfile agora fixam exatamente as dependências diretas `pdf-lib@1.17.1` e `@pdf-lib/fontkit@1.1.1`; os três pacotes transitivos citados permanecem travados por versão, URL e SHA-512 no lockfile.
- Ampliei a mesma proteção às dependências diretas restantes sem hash: `docx@9.7.1` (fluxo OCR→Word) e `@pdfsmaller/pdf-encrypt@1.0.2`. Todas as dependências diretas e transitivas versionadas têm URL e integridade; a verificação estrutural está registrada no item seguinte.
- Também foram adicionados URL/SHA-512 às 22 entradas transitivas de runtime e às 32 entradas exclusivamente `dev` que ainda faltavam. Verificação estrutural do lockfile: **0 de 419 entradas versionadas sem `resolved`/`integrity`**, 0 divergências entre as dependências diretas de `package.json` e a raiz do lockfile.
- A pinagem protege os tarballs de runtime e desenvolvimento contra substituição silenciosa em instalações futuras. Não fiz instalação limpa, não reconstruí MSI e não alego que o conteúdo já instalado foi retroativamente verificado. Isso melhora a reprodutibilidade da próxima instalação/build; não substitui revisão dos avisos legais pendentes descritos abaixo. Fontes dos digests: metadados oficiais do registry npm (`dist.tarball` e `dist.integrity`) nas versões exatas do lockfile; referências principais: [pdf-lib](https://registry.npmjs.org/pdf-lib/1.17.1), [standard-fonts](https://registry.npmjs.org/@pdf-lib/standard-fonts/1.0.0), [upng](https://registry.npmjs.org/@pdf-lib/upng/1.0.1), [pako](https://registry.npmjs.org/pako/1.0.11), [docx](https://registry.npmjs.org/docx/9.7.1) e [pdf-encrypt](https://registry.npmjs.org/@pdfsmaller/pdf-encrypt/1.0.2).

# Rechecagem das fontes upstream — 2026-11-03

- (Registro substituído pela atualização upstream acima: o PR #300 foi mesclado e publicou licença para o repositório foliojs/fontkit, mas a relação com o artefato fork `@pdf-lib/fontkit@1.1.1` segue sem confirmação do mantenedor.)
- A consulta às issues do Canvas ainda lista aberta a solicitação de mapeamento entre o binário Windows x64, Skia e runtimes estáticos. A release `1.0.13` publica SBOM, mas a SBOM não atribui SPDX aos nove componentes já descritos abaixo; a publicação da SBOM é evidência de inventário, não prova de cobertura de avisos. Evidência: [issue upstream #1360](https://github.com/Brooooooklyn/canvas/issues/1360) e [releases do Canvas](https://github.com/Brooooooklyn/canvas/releases).
- **Decisão desta rechecagem:** manter a pendência de Fontkit/Canvas aberta, sem alterar avisos, licença declarada, dependências ou pacote MSI. O MSI 1.2.23 permanece um artefato de QA, não uma aprovação para distribuição comercial. A próxima ação que realmente fecha a lacuna é resposta/notice autoritativo dos mantenedores ou substituição tecnicamente validada das dependências afetadas, seguida de nova auditoria do payload exato.

## Reauditoria do payload MSI 1.2.23 — 2026-11-03

- Executado `CENTRAL_PDF_OCR_PACKAGE_DIR=<win-unpacked 1.2.23> npm run test:runtime-license-audit` contra o `app.asar` do mesmo payload submetido a E2E 21/21. Resultado: 56 de 71 dependências de produção aparecem no pacote, 50 têm arquivo de licença local, cinco têm notice central versionado e 15 não entram neste build/plataforma.
- Somente `@pdf-lib/fontkit@1.1.1` ficou sem notice independente/verificado entre os pacotes de runtime presentes. A verificação registra a declaração MIT do pacote, mas a ausência do arquivo de licença e de um notice upstream completo continua aberta. A issue upstream está encerrada automaticamente sem resposta substantiva; a discussão pública fornece reconstrução técnica de terceiros, mas deixa cinco questões de proveniência/notice abertas. Fontes primárias: [issue upstream](https://github.com/Hopding/pdf-lib/issues/1793) e [discussão upstream](https://github.com/Hopding/pdf-lib/discussions/1791).
- Para `@napi-rs/canvas@1.0.13`, a SBOM do binário reporta nove componentes sem expressão de licença. Seis crates de registry têm metadados/checksums verificados no registry; três componentes locais/empacotados continuam sem comprovação equivalente: `skia.win32-x64-msvc.node`, `canvas@0.1.0` e `skia-fontations@0.0.0`. A auditoria aponta commits, mas isso não equivale a notice completo para cada dependência embutida.
- `npm run test:runtime-license-manifest` passou: cinco notices centrais permanecem versionados, completos e consistentes com lockfile. Essa validação atesta o inventário registrado, não resolve parecer jurídico. Não criei attribution por inferência nem alterei a dependência; substituí-la pode afetar assinatura com fontes customizadas e exigiria validação funcional.
- Resultado para distribuição 1.2.23: o runtime audit foi executado e está reproduzível, mas o gate legal permanece **PARCIAL**. Requer confirmação autoritativa do fornecedor ou revisão jurídica/decisão técnica sobre substituição antes de declarar conformidade completa.

## MSI 1.2.21 extraído — 2026-11-03

- A auditoria de runtime foi executada contra o `app.asar` extraído do MSI versionado 1.2.21: 56/71 dependências de produção presentes, 50 arquivos de licença, 5 avisos centrais e 15 pacotes não presentes nesta plataforma/build.
- `@pdf-lib/fontkit@1.1.1` declara `MIT` nos metadados do pacote, mas não traz `LICENSE` no tarball e continua sem aviso distribuído verificado; o aviso MIT de Canvas não resolve as licenças/proveniência de todos os componentes incorporados.
- Este MSI foi posteriormente instalado neste PC; o executável instalado confere por SHA-256 com o payload extraído. Não é assinado. A auditoria é estrutural, não parecer jurídico. Consulte [validação do MSI 1.2.21](../reports/msi-1.2.21-validation.md).

## Histórico do artefato instalado — MSI 1.2.18, rechecagem em 2026-11-03

- O MSI 1.2.18 foi instalado neste PC com autorização explícita. O hash do MSI publicado é `73A4B144BC04D13BFB30EF6B54FDEBA46F4D44A8A74F4EC3355A8D642C853F48`; a instalação e os testes de inicialização/atalhos estão documentados em [status OCR](OCR-implementation-status.md).
- A auditoria runtime executada contra a extração administrativa desse MSI reportou 56 de 71 dependências de produção no payload, 50 licenças locais, 5 avisos centrais, 15 dependências fora da build/plataforma e `@pdf-lib/fontkit@1.1.1` sem aviso verificado. A SBOM Canvas ainda apresenta nove itens sem expressão SPDX e três sem licença upstream verificada.
- Os dados de 1.2.15 e 1.2.16 abaixo são registros históricos, não representam o artefato atualmente instalado. O MSI não tem assinatura; a contagem estrutural não é parecer jurídico. A fonte avançou para 1.2.20 e um empacotamento estava em andamento, sem MSI 1.2.20 validado nesta auditoria.

## Revalidação MSI 1.2.15 — 2026-11-03

- MSI existente extraído administrativamente, sem instalação ou modificação de `releases`. O payload passou 12 checks estruturais, conferência dos dados OCR e auditoria runtime: 56/71 dependências de produção presentes, 50 licenças locais, 5 avisos centrais; `@pdf-lib/fontkit@1.1.1` e itens internos do Canvas seguem pendentes de proveniência/notices autoritativos.
- Smoke do executável extraído confirmou `renderer-did-finish-load` + `renderer-bootstrap-complete` em 2.853 ms. E2E OCR focado no mesmo payload passou OCR completo de duas páginas (22.269 ms) e refazer OCR (19.026 ms). A suíte integral 1.2.15 e instalação/upgrade MSI não foram executados.
- A primeira tentativa de smoke da manhã falhou antes de observar o renderer; a repetição passou, sem evidência que permita atribuir a falha inicial a uma causa reproduzível. O relatório de smoke registra a execução aprovada mais recente.

## Rechecagem de fontes upstream — 2026-11-03

- `@pdf-lib/fontkit@1.1.1`: não apareceu resposta de mantenedor à solicitação de aviso; o issue #1793 foi encerrado pelo bot de stale, sem solução substantiva. A discussão pública #1791 contém uma reconstrução reproduzível feita por terceiros e identifica 5 pontos de proveniência ainda em aberto no bundle; é evidência útil de risco, mas não é notice oficial nem foi copiada para o instalador. Fontes: [issue #1793](https://github.com/Hopding/pdf-lib/issues/1793) e [discussion #1791](https://github.com/Hopding/pdf-lib/discussions/1791).
- Canvas: o issue upstream #1360 segue aberto e trata do artefato Windows x64 **1.0.9**, não da versão 1.0.13 usada pelo projeto. Ele documenta questões ainda sem resposta sobre bibliotecas Skia/runtime estáticas; serve como contexto, não comprova a composição/licença do nosso binário 1.0.13. Não transferimos avisos de uma versão para outra. Fonte: [issue #1360](https://github.com/Brooooooklyn/canvas/issues/1360).
- Decisão mantida: a declaração MIT de nível de pacote e o texto de licença de Canvas não resolvem por inferência os avisos de componentes incorporados. Os payloads passaram as verificações técnicas, mas a revisão de conformidade continua pendente para distribuição comercial.

## Alternativa de Fontkit conferida no pacote publicado — 2026-11-03

- Verifiquei o tarball exato `fontkit@2.0.4` do registry npm (integridade `sha512-syetQadaUEDNdxdugga9CpEYVaQIxOwk7GlwZWWZ19//qW4zE5bknOKeMBDYAASwnpaSHKJITRLMF9m1fp3s6g==`). O pacote declara MIT e o README/upstream exibem essa licença, porém o tarball também não inclui `LICENSE` nem `NOTICE` independentes.
- A API é candidata funcionalmente compatível, mas a substituição não melhoraria a evidência de aviso da licença-raiz; além disso, implicaria validar o novo grafo de dependências e regressões de assinatura. Não alterei `package.json`/lock nem a dependência. Fontes primárias: [package.json upstream 2.0.4](https://github.com/foliojs/fontkit/blob/master/package.json) e [README upstream](https://github.com/foliojs/fontkit).

## MSI existente 1.2.14 — extração e inicialização — 2026-11-03

- O MSI de `releases/1.2.14/` foi extraído administrativamente para `%TEMP%`, sem instalação nem alteração da pasta `releases`.
- No payload extraído, `test:ocr-license` passou com 3 mapeamentos de licença OCR e 9 avisos WASM; `test:runtime-license-audit` passou estruturalmente com 56 dependências presentes no `app.asar`, 50 arquivos de licença locais e 5 avisos centrais. `@pdf-lib/fontkit@1.1.1` permanece sem aviso verificado; a SBOM Canvas mantém nove itens sem expressão SPDX.
- O smoke test MSI (`reports/packaged-startup-smoke.md`) chegou a `renderer-did-finish-load` e `renderer-bootstrap-complete` em cerca de 3,4 s. O smoke da fonte 1.2.15 em dev com Vite também passou (`reports/development-startup-smoke.md`, 6,2 s). Isso confirma o carregamento do renderer nos contextos testados, mas não valida instalação MSI 1.2.15, upgrade, remoção ou atalhos após instalação limpa.

## Payload `win-unpacked` 1.2.14 — 2026-11-03

- Empacotamento isolado para QA, sem MSI, em `%TEMP%\CentralPdfOCR-1.2.14-dir-1b3059aa9719467f81388e6b1c375e05\win-unpacked`.
- `test:ocr-license` passou contra o payload (3 mapeamentos de licença do Tesseract e 9 avisos WASM byte-a-byte). `test:runtime-license-audit` passou estruturalmente: 71 dependências no lock, 56 presentes no `app.asar`, 50 com licença local, 5 com aviso central, 15 ausentes da build/plataforma e 1 sem aviso verificado: `@pdf-lib/fontkit@1.1.1`.
- A SBOM oficial Canvas 1.0.13 (142 componentes) e SHA-256 do binding presente no pacote conferiram; seis metadados/checksums de crates e a proveniência dos commits Canvas/Skia foram validados. Isso não fecha a revisão de avisos para o binário agregado Skia/native nem a lacuna independente do Fontkit.
- E2E do executável empacotado passou 21/21 numa execução completa. Isso valida o `win-unpacked`, não instalação, upgrade, atalhos ou desinstalação do MSI. Não foi produzido MSI.
- Depois da auditoria do payload, o lockfile foi alinhado às versões corrigidas que já estavam no `node_modules`: `pdfjs-dist@6.2.108`, `nanoid@5.1.16`, Electron 43.8.6, Vite 8.3.5, Undici 7.30.1 e source-map-js 1.2.2. `npm audit` e `npm audit --omit=dev` passaram sem vulnerabilidades. O `app.asar` analisado já continha as mesmas versões de runtime; a auditoria de avisos foi repetida após a atualização do lock.

## Payload 1.2.13 atualizado — 2026-11-03

- Empacotei a fonte 1.2.13 em `%TEMP%\central-pdf-ocr-1.2.13-organize-qa\win-unpacked`. `npm run test:ocr-license` passou contra esse payload: três mapeamentos de licença do Tesseract e nove avisos de componentes WASM conferidos por igualdade com a fonte. O E2E focado de organização também passou em dois cenários no mesmo build.
- `npm run test:runtime-license-audit` passou estruturalmente: 71 dependências de produção no lockfile, 56 no `app.asar`, 50 com licença local, cinco cobertas por avisos centrais e 15 não presentes nessa plataforma/build. A única dependência presente sem aviso verificado continua sendo `@pdf-lib/fontkit@1.1.1`. A SBOM Canvas 1.0.13 contém 142 componentes, nove sem expressão de licença; seis crates têm metadados/checksums do registry verificados, mas três componentes locais/artefato nativo continuam sem licença/proveniência equivalente.
- O teste verifica consistência do inventário, não conformidade jurídica total. Nenhum MSI foi produzido ou instalado; não declarar liberação legal do payload.

## MSI 1.2.7 extraído para QA — 2026-11-02

- MSI temporário: `%TEMP%\CentralPdfOCRMSI-20261102-retry1\Central PDF 1.2.7.msi`; 156.758.016 bytes; SHA-256 `2D18DCF93964CAFB412B778E9F06E8B22F2694DEB94A6AFE39D5621F0852DE20`. Extração administrativa concluída para `%TEMP%\CentralPdfOCRMSIExtract-20261102-retry1\Central PDF`.
- `npm run test:runtime-license-audit` identificou 56 dependências de produção no `app.asar`: 50 com licença local, cinco cobertas por avisos centrais, 15 do manifesto não presentes nesta build/plataforma e uma lacuna sem aviso verificado: `@pdf-lib/fontkit@1.1.1`. SBOM do Canvas: 142 componentes, nove sem expressão SPDX. O teste estrutural passou; isso não fecha a revisão legal/proveniência.
- `npm run test:ocr-license` passou contra o payload extraído; o E2E rodado sobre o executável extraído do MSI passou **21/21** (`reports/ui-app-e2e-report.md`). O MSI não está assinado nem foi instalado; isso não fecha a revisão de licença nem autoriza tratá-lo como release aprovado.

## Revalidação do payload — 2026-11-02

Build Windows x64 `--dir` temporária em `%TEMP%\central-pdf-unpacked-license-audit\win-unpacked` (sem MSI e sem escrita em `releases`). `npm run test:runtime-license-audit` passou: manifesto no payload idêntico byte a byte à fonte, 56 dependências de produção encontradas, 50 com licença independente e cinco cobertas por avisos centrais. Das 56, somente `@pdf-lib/fontkit@1.1.1` continua sem qualquer aviso verificado. O MIT de nível de pacote do Canvas está presente e confirmado no payload, mas a auditoria legal estrita continua aberta para componentes nativos/estáticos não atribuídos pela SBOM; a build não valida instalação, atalhos ou desinstalação.

## Regressão JPEG OCR — 2026-11-02

Durante a regressão integrada, a aprovação falhava intermitentemente ao converter JPEG em PDF: algumas imagens ficam em Buffer agrupado do Node com `byteOffset` não zero, mas o embutidor JPEG do pdf-lib examina `imageData.buffer` a partir de offset zero. O OCR agora usa uma `Uint8Array` com `ArrayBuffer` exato para a incorporação JPEG quando a origem é um Buffer agrupado; Buffers que já têm backing exato continuam sem cópia. A regressão `npm run test:ocr-language-accuracy` passou 15/15, cobrindo JPEG individual e em lote, outros idiomas, CER/WER e cancelamento. `npm run test:ocr` passou após corrigir também a expectativa do teste de privacidade por página; `npm run test:ocr-range-export` confirmou exclusão de texto nativo não selecionado, reconhecimento da página selecionada e hash original intacto.

### Rechecagem upstream do Fontkit — 2026-11-02

O repositório oficial `foliojs/fontkit` ainda exibe MIT no README, mas não tem arquivo `LICENSE`; o PR upstream #300 que propõe adicionar um texto MIT com atribuição a Devon Govett está aberto e sem aprovação/merge. Logo, o texto proposto não é aviso oficial confirmado para o fork `@pdf-lib/fontkit@1.1.1` (cujo pacote lista Andrew Dillon como autor e Devon Govett como colaborador), e não foi copiado para o inventário. O pedido específico sobre o release 1.1.1 permanece sem resposta do mantenedor. Evidências: [repositório upstream](https://github.com/foliojs/fontkit), [PR #300 aberto com proposta de licença](https://github.com/foliojs/fontkit/pull/300), [pedido de esclarecimento do release](https://github.com/Hopding/pdf-lib/issues/1793).

O inventário versionado `vendor/licenses/runtime-third-party-notices.json` contém textos integrais e URLs de origem para cinco dependências cujo aviso foi confirmado contra a fonte versionada e o lockfile:

| Pacote | Versão | Licença |
| --- | --- | --- |
| `dingbat-to-unicode` | 1.0.1 | BSD-2-Clause |
| `hash.js` | 1.1.7 | MIT |
| `isarray` | 1.0.0 | MIT |
| `tr46` | 0.0.3 | MIT |
| `@napi-rs/canvas-win32-x64-msvc` | 1.0.13 | MIT |

O Electron Builder distribui esse inventário em `resources/licenses/runtime-third-party-notices.json`. `npm run test:runtime-license-manifest` confere versões, nomes e licenças com o lockfile, completude mínima do texto, procedência HTTPS e duplicidade. `npm run test:runtime-license-audit` confere também sua presença e igualdade byte a byte no pacote Windows.

## Resultado do pacote Windows x64 unpacked

Pacote temporário histórico em `C:\Users\THIAGO~1.ROD\AppData\Local\Temp\CentralPdfLicenseDir-4c61b2b2611542a2941632538933a501\win-unpacked` (sem MSI): 56 dependências de produção presentes no `app.asar`; 50 com arquivo de licença no próprio pacote e outras 4 cobertas pelo inventário central daquela build. Essa build precede a inclusão do quinto aviso central abaixo e não serve como verificação do inventário atual. As pendências atuais são:

- `@pdf-lib/fontkit@1.1.1`: bundle JavaScript incorpora componentes de terceiros, e ainda faltam avisos/proveniência completos e confirmáveis para todo o conteúdo distribuído.
- `@napi-rs/canvas-win32-x64-msvc@1.0.13`: o texto MIT de nível de pacote está agora coberto pelo aviso central versionado, mas isso não fornece as licenças/proveniências ausentes de componentes internos identificados pela SBOM oficial do binário nativo.

### Reinvestigação das duas exceções — 2026-11-02

- Canvas: o upstream publicou SBOMs para versões recentes, mas a solicitação upstream sobre a atribuição dos componentes estáticos do artefato Windows x64 continua aberta; a evidência pública encontrada refere-se à versão 1.0.9 e pede a relação de objetos/avisos do Skia e runtime estático. Isso não prova quais componentes exatos estão no binário 1.0.2 usado aqui, portanto não foi usada uma lista de outra versão para preencher o aviso. Fontes: [solicitação upstream sobre o binário Windows x64](https://github.com/Brooooooklyn/canvas/issues/1360), [release upstream com SBOMs](https://github.com/Brooooooklyn/canvas/releases/tag/v1.0.13).
- Fontkit: conferimos o pacote local 1.1.1 e o arquivo distribuído `dist/fontkit.umd.js` (1.506.282 bytes): o pacote não contém `LICENSE`; o README/package metadata declaram MIT, mas isso não fornece o texto integral nem a proveniência de todo o bundle. A inspeção do bundle encontrou avisos incorporados identificáveis de `base64-arraybuffer` (MIT, atribuído a Niklas von Hertzen) e de código Google Brotli (Apache-2.0, copyright 2013 Google Inc.). Eles confirmam que o bundle agrega componentes sujeitos a avisos próprios, mas não identificam de modo completo e verificável todos os componentes/ titulares do pacote. Essa inspeção direta substitui a discussão pública de terceiros citada em versões anteriores deste registro; não se usa aquela discussão como evidência de conformidade. Fontes primárias para a declaração do pacote: [README upstream](https://github.com/Hopding/fontkit/blob/master/README.md), [repositório upstream](https://github.com/Hopding/fontkit).
- Decisão: não copiar um SBOM de outra versão, reconstruir direitos autorais por inferência ou tratar o campo `license` do npm como prova de todos os componentes incorporados. A verificação da aplicação e o E2E podem continuar, mas auditoria estrita de distribuição deve permanecer bloqueada até documentação autoritativa suficiente ou substituição tecnicamente validada dessas dependências.

### Alternativa Fontkit upstream avaliada — 2026-11-02

- O pedido de esclarecimento sobre o aviso de `@pdf-lib/fontkit@1.1.1` foi fechado pelo bot de stale em 26/10/2026; a página não contém resposta de mantenedor. Isso não resolve a lacuna do aviso. Fonte: [issue upstream #1793](https://github.com/Hopding/pdf-lib/issues/1793).
- Avaliei isoladamente o pacote oficial `fontkit@2.0.4` do projeto foliojs, declarado MIT e com nove dependências de runtime listadas no `package.json`; a README upstream documenta a API `create/layout/subset`. Num teste local sem alterar o projeto, `pdf-lib@1.x` aceitou a API e embutiu seis fontes manuscritas do Windows (Segoe Script, Segoe Print, Lucida Handwriting, Monotype Corsiva, Brush Script e Ink Free); larguras, nomes PostScript e tamanhos dos PDFs coincidiram com os obtidos com o fork atual. Isso é evidência de compatibilidade funcional básica, não um E2E da ferramenta de assinatura.
- **Não troquei a dependência:** embora o upstream declare MIT, o pacote testado também não trouxe um arquivo `LICENSE` independente e suas dependências precisam de inventário/notices próprios. Portanto a troca não fecha, por si só, a lacuna legal; exigiria atualizar a dependência, lockfile, regressões de assinatura e auditoria integral do novo grafo. Fontes primárias: [README fontkit upstream](https://github.com/foliojs/fontkit), [package.json oficial](https://github.com/foliojs/fontkit/blob/master/package.json), [pacote npm fontkit](https://www.npmjs.com/package/fontkit).

### Rechecagem pública do artefato Fontkit 1.1.1 — 2026-11-02

- O metadata oficial do repositório `foliojs/fontkit` declara MIT, autor Devon Govett e dependências runtime; isso se refere à versão atual 2.0.4, não constitui a cadeia de avisos do fork `@pdf-lib/fontkit@1.1.1` ([package.json upstream](https://github.com/foliojs/fontkit/blob/master/package.json)).
- A discussão no repositório pdf-lib segue sem resposta de mantenedor. Um comentário comunitário descreve uma reconstrução do UMD 1.1.1 e identifica 30 pacotes incorporados, porém relata cinco grupos de proveniência/avisos ainda sem resposta conclusiva; o comentário é útil como pista reproduzível, não é aviso oficial nem foi copiado para o inventário ([discussão #1791, sem resposta de mantenedor](https://github.com/Hopding/pdf-lib/discussions/1791)). O pedido de licença #1793 foi fechado por bot de stale sem resposta substantiva ([issue #1793](https://github.com/Hopding/pdf-lib/issues/1793)).
- Decisão mantida: não reconstruir a licença integral nem atribuições para o fork a partir de metadata, comentários da comunidade ou código de outra versão. O pacote segue como pendência de conformidade para distribuição; eventual resolução exige confirmação do mantenedor ou substituição com compatibilidade e cadeia de notices testadas.

### Verificação de procedência da SBOM Canvas — 2026-11-02

- O SBOM oficial por plataforma do `@napi-rs/canvas-win32-x64-msvc@1.0.13` lista seis crates do registro sem expressão SPDX: `anstyle@1.0.14`, `clap@4.6.7`, `clap_builder@4.6.7`, `clap_lex@1.1.1`, `cxxbridge-cmd@1.0.205` e `strsim@0.11.1`. Os metadados e arquivos `.crate` exatos foram consultados no crates.io; as primeiras cinco declaram `MIT OR Apache-2.0` e a última `MIT`, com os arquivos LICENSE respectivos presentes nos arquivos-fonte oficiais. Isso melhora a identificação dessas seis entradas, mas **não** demonstra sozinho que cada uma esteja ligada ao binário de runtime (a árvore também pode conter ferramentas de build), nem resolve as entradas locais `canvas`/`skia-fontations` ou as dependências nativas agrupadas no componente `.node`.
- Integridade dos seis arquivos `.crate`: os SHA-256 locais conferiram com `version.checksum` publicado pelo crates.io. Os hashes estão listados para reprodução:

  | Crate exato | Expressão declarada | SHA-256 do arquivo `.crate` |
  | --- | --- | --- |
  | `anstyle@1.0.14` | `MIT OR Apache-2.0` | `940b3a0ca603d1eade50a4846a2afffd5ef57a9feac2c0e2ec2e14f9ead76000` |
  | `clap@4.6.7` | `MIT OR Apache-2.0` | `aa8876b300ab35ba921adea3dfd70157a46249b33f95c9084ae5709785478946` |
  | `clap_builder@4.6.7` | `MIT OR Apache-2.0` | `ec0797fb7aeb1406c84efac526901f7ec3ead2124f946b494e72879d4b54704d` |
  | `clap_lex@1.1.1` | `MIT OR Apache-2.0` | `1c133bc6a41be0d194c306b5506d15e6feeea7b1d6604bd3f8310dfb2ca96486` |
  | `cxxbridge-cmd@1.0.205` | `MIT OR Apache-2.0` | `54a486ed16a3f2a053fe7f5b98db4c1a59846a23e8cb9e49f9d1bd48830d51a2` |
  | `strsim@0.11.1` | `MIT` | `7da8b5736845d9f2fcb837ea5d9e2628564b3b043a70948a3f0b778838c5fb4f` |
- O release upstream `@napi-rs/canvas@1.1.0` foi comparado sem alterar a dependência do projeto. O pacote Windows x64 continua publicando SBOM CycloneDX 1.6 com 142 componentes e o mesmo conjunto de nove entradas sem expressão de licença; portanto, a atualização isolada não fecha a pendência e não foi aplicada.
- Fontes primárias verificadas: [SBOM/release Canvas v1.0.13](https://github.com/Brooooooklyn/canvas/releases/tag/v1.0.13), [Cargo.lock do tag v1.0.13](https://raw.githubusercontent.com/Brooooooklyn/canvas/v1.0.13/Cargo.lock), [manifesto Canvas v1.0.13](https://raw.githubusercontent.com/Brooooooklyn/canvas/v1.0.13/Cargo.toml), [package.json v1.0.13](https://raw.githubusercontent.com/Brooooooklyn/canvas/v1.0.13/package.json), [licença do repositório](https://github.com/Brooooooklyn/canvas/blob/v1.0.13/LICENSE) e os metadados/arquivos de licença fixados por versão no [crates.io](https://crates.io/).
- O status da auditoria estrita permanece bloqueado para Canvas e Fontkit. A nova verificação não foi usada para marcar o binário como integralmente coberto: falta documentação autoritativa do Skia e do código local incorporado; Fontkit ainda não tem um conjunto completo de notices verificáveis para o artefato publicado exato. A inspeção do UMD foi feita no pacote instalado com nomes de arquivo e tamanho conferidos; não basta para atribuir licença a cada trecho agregado.

### Pinagem do código local Canvas/Skia — 2026-11-02

- Resolvi a origem dos dois componentes locais restantes sem SPDX. O tag assinado Canvas `v1.0.13` aponta ao commit `00a115d9903647f116daf86eccd2c6ba36128371`; o gitlink `skia` desse commit aponta exatamente ao commit Skia `b94213a11b3a2edadfae89f0c57a7f4ab72772c9`. O manifesto do wrapper mostra `canvas@0.1.0` e `skia-fontations@0.0.0`; o segundo é uma ponte `publish=false` cujo crate root e módulos vêm de `skia/src/ports/fontations`, não um pacote independente do crates.io.
- O código Skia/Fontations referenciado inclui cabeçalho do Google que encaminha ao `LICENSE` do Skia; esse arquivo contém os termos BSD de redistribuição, inclusive a exigência de reproduzir aviso e disclaimer em distribuição binária. O Canvas local declara MIT e o pacote traz o texto MIT já incluído no aviso central. Fontations Rust e outras dependências aparecem individualmente na SBOM; não atribuí MIT/Apache ao wrapper inteiro por causa dos crates dependentes.
- `run-runtime-license-audit.js` agora fixa os dois commits e exige que os componentes `canvas@0.1.0` e `skia-fontations@0.0.0` continuem presentes na SBOM sem expressão própria. O relatório chama isso de **proveniência de fonte verificada**, não de licença SPDX verificada, nem prova que todos os avisos requeridos já estejam distribuídos.
- A lacuna em `skia.win32-x64-msvc.node` é diferente: é o artefato nativo agregado, não uma obra com licença única. Seu hash continua comparado à SBOM oficial, que lista os componentes constituintes. Ainda é necessária revisão de completude dos avisos binários do conjunto Skia/dependências; a licença BSD do Skia deve acompanhar a distribuição conforme seus próprios termos. Isso não altera a pendência independente do Fontkit e não libera a auditoria legal do MSI.
- Fontes primárias para reprodução: [tag Canvas v1.0.13](https://github.com/Brooooooklyn/canvas/releases/tag/v1.0.13), [manifesto do wrapper no commit fixado](https://raw.githubusercontent.com/Brooooooklyn/canvas/00a115d9903647f116daf86eccd2c6ba36128371/crates/skia-fontations/Cargo.toml), [manifesto Cargo do Canvas no commit fixado](https://raw.githubusercontent.com/Brooooooklyn/canvas/00a115d9903647f116daf86eccd2c6ba36128371/Cargo.toml), [manifesto oficial do Skia](https://github.com/Brooooooklyn/canvas/tree/v1.0.13/skia) e [licença BSD do Skia no commit exato](https://github.com/google/skia/blob/b94213a11b3a2edadfae89f0c57a7f4ab72772c9/LICENSE).

Na build histórica acima, as duas exceções estavam deliberadamente descobertas; o campo `license` do `package.json` não era tratado como substituto dos avisos exigidos. O estado atual da fonte e as pendências restantes estão registrados na atualização abaixo.

### Atualização do inventário de avisos — 2026-11-02

- A fonte central passou a incluir o texto MIT exatamente igual a `node_modules/@napi-rs/canvas/LICENSE`, aplicável ao pacote Windows 1.0.13 conforme seus metadados e o repositório oficial na tag `v1.0.13`. A regressão compara o texto integral e URL versionada; `npm run test:runtime-license-manifest` passou com cinco avisos.
- O Electron Builder já copia esse manifesto para `resources/licenses/runtime-third-party-notices.json`. Ainda não foi reconstruído o `win-unpacked`/MSI após a alteração, portanto a paridade no payload atual não foi testada.
- A leitura do SBOM confirmou nove componentes sem expressão SPDX. O manifesto oficial do Canvas coloca `cxx-build` em `build-dependencies` e restringe `skia-fontations` a macOS/Linux, não ao binário Windows. O SBOM também lista `cxxbridge-cmd`; a cadeia sugere componentes de compilação, mas o SBOM plano não separa dependências de build das ligadas ao `.node`. As seis crates registradas no crates.io têm licenças identificadas e arquivos-fonte conferidos, mas isso não prova quais entraram no binário. O `.node` é um componente agregado sem notice próprio; permanecem sem evidência suficiente a cobertura de Skia/terceiros estáticos e a atribuição integral do Fontkit. Fonte do manifesto nativo: [Cargo.toml v1.0.13](https://raw.githubusercontent.com/Brooooooklyn/canvas/v1.0.13/Cargo.toml).
- A pendência `@pdf-lib/fontkit@1.1.1` continua sem solução verificável. Para Canvas, a licença MIT do pacote também não resolve, por si só, a ausência de licença/proveniência de componentes indicados pela SBOM. A gate estrita de distribuição deve permanecer bloqueada até inventário e reprodução desses avisos ou substituição tecnicamente validada.

## Verificações executadas em conjunto

- `npm run test:runtime-license-manifest` — passou, cinco avisos íntegros e fixados em versão; o aviso Canvas é comparado byte a byte com o texto upstream instalado.
- `npm run test:ocr-license` — passou, três mapeamentos principais e nove avisos WASM.
- `npm run test:build` — passou, seis checks.
- ESLint nos scripts JavaScript alterados — sem erros.
- `electron-builder --win --dir --x64 --publish never` — pacote unpacked criado; auditoria de runtime acima passou e reportou as duas exceções.
- MSI não foi gerado.

## Revalidação do mesmo pacote — 2026-11-02

- `npm run test:ui-app` executado sem filtro contra o mesmo `win-unpacked`: **21/21 cenários passaram**, incluindo OCR, pesquisa, extração regional, cancelamento/retry, completo/refazer, lote OCR cancelado, integrações com mesclagem, Word, separação, compressão, segurança, organização e demais fluxos. Soma dos tempos das etapas: cerca de 52 s (não é benchmark controlado). Relatório atualizado em `reports/ui-app-e2e-report.md`.
- `npm run test:ocr-license` passou com `CENTRAL_PDF_OCR_PACKAGE_DIR` ativo, conferindo modelos e arquivos de licença OCR empacotados byte a byte.
- `npm run test:ocr` também passou integralmente nessa rodada. MSI e instalação limpa continuam pendentes.

## Atualização do runtime Canvas e segurança — 2026-11-02

- Atualizado `@napi-rs/canvas`/`@napi-rs/canvas-win32-x64-msvc` para 1.0.13. O tarball x64 contém `sbom.cdx.json` CycloneDX 1.6 com 142 componentes. O SHA-256 do binário `skia.win32-x64-msvc.node` é `5d00cf716176a32c2a289f48cad19637131fe7de394c4fed58ae48043325943a`, igual ao hash do componente binário declarado pela SBOM. A verificação de pacote agora confere arquivo, versão, SBOM e hash contra o binário unpacked.
- O inventário melhora a proveniência em relação à versão 1.0.2, mas **não resolve** os avisos: nove componentes não têm expressão de licença na SBOM, e ela não incorpora os textos de licença. `npm run test:runtime-license-audit` confirmou que o aviso de Canvas e o de Fontkit continuam descobertos; `CENTRAL_PDF_LICENSE_STRICT=1` falha corretamente para esses dois pacotes. A declaração MIT no `package.json` não substitui os avisos ausentes.
- Alternativa examinada para Fontkit: o tarball oficial `fontkit@2.0.4` também declara MIT, mas não inclui arquivo LICENSE e acrescenta nove dependências de runtime; portanto não resolve a lacuna de avisos e não foi trocado às cegas. A assinatura com fonte embutida continua usando a dependência atual até haver fonte/notices confirmados ou uma alternativa que passe regressões de embed.
- Corrigidas vulnerabilidades via `npm audit fix` e overrides compatíveis, sem `--force`: Electron 43.8.6, Vite 8.3.5, electron-builder 26.18.1, minimatch 11.0.4 e brace-expansion corrigidos. `npm audit` agora retorna zero vulnerabilidades. O Electron foi baixado do release oficial e validado pelo SHA-256 listado no pacote npm antes de usar na build.
- Regressão após as mudanças: `npm run test:ocr-suite` 18/18, lint e build/contratos 6 checks; E2E completo em `C:\Users\thiago.rodrigues\AppData\Local\Temp\CentralPdfOcrFinalBuild-20261102\win-unpacked` passou 21/21. `npm run test:ocr-license` e comparação da SBOM/binário passaram.
- Não há Windows Sandbox disponível neste host e o daemon Docker não está ativo; por isso não foi feita instalação limpa do MSI nem registro/atalhos/desinstalação. MSI não foi gerado nesta rodada. Fontkit e instalação limpa continuam pendentes.

## MSI de QA extraído — 2026-11-02

- Foi gerado fora de `releases` um MSI de QA 1.2.6 em `%TEMP%\CentralPdfMsiQABuild-20261102\Central PDF 1.2.6.msi` (156.749.824 bytes; SHA-256 `88B693CFE0782EAF8F9F3E2582809A116FBFC2545ED04F11FC426AED0ED5EC68`; `ProductVersion` 1.2.6.0; sem assinatura digital).
- `msiexec /a` extraiu o pacote para `%TEMP%\CentralPdfMsiQAExtract-20261102` com retorno 0. Foi usada extração administrativa, não instalação do produto; os efeitos em registro, atalhos, atualização e desinstalação não foram validados. `test:ocr-license` passou com a pasta extraída; E2E usando `CENTRAL_PDF_E2E_PACKAGED_APP` apontado ao executável extraído passou 21/21 (`reports/ui-app-e2e-report.md`, estado empacotado). A verificação confirmou `app.asar`, qpdf e modelos `por`/`eng` presentes.
- `test:runtime-license-audit` contra esse payload ainda encontra exatamente dois avisos runtime sem verificação completa: Canvas 1.0.13 e Fontkit 1.1.1. O MSI é candidato de QA, não deve ser tratado como liberado para distribuição.
- Extração administrativa e inicialização do executável não equivalem a instalação limpa: registro, atalho, primeira execução normal e desinstalação continuam sem validação por falta de VM/Sandbox acessível.

## Reauditoria no payload Windows atual — 2026-11-02

- Build `win-unpacked` temporário: `%TEMP%\central-pdf-ocr-final-verification-20261102\win-unpacked`. `npm run test:ocr-license` passou com a verificação do pacote ativada: modelos e 3 mapeamentos de licença de alto nível + 9 avisos WASM presentes e conferidos.
- `npm run test:runtime-license-audit` encontrou 56 pacotes de produção no `app.asar`: 50 com arquivo de licença local, 5 cobertos pelo inventário central e 15 lockfile-only ausentes deste build Windows. O aviso central Canvas MIT agora está no payload e foi reconhecido como cobertura de nível de pacote; dingbat-to-unicode, hash.js, isarray e tr46 também estão cobertos. **A única dependência sem qualquer aviso verificável nesta execução é `@pdf-lib/fontkit@1.1.1`.**
- Isso não encerra a revisão do Canvas: sua SBOM v1.0.13 ainda contém 142 componentes e 9 sem expressão SPDX, e a presença da licença MIT do pacote não prova os notices de todas as partes estáticas incorporadas no binding nativo. Fontkit permanece pendente por falta de proveniência/avisos completos. Não tratar o payload como legalmente liberado para distribuição até a revisão desses componentes ser concluída.
- O build foi `win-unpacked`, não MSI; a execução do E2E não valida instalação/desinstalação em ambiente limpo.
- Alternativa examinada: `opentype.js` publica um arquivo MIT explícito, mas não é substituto direto confirmado para o adaptador esperado por pdf-lib. A interface de fontkit usada por pdf-lib inclui criação de fonte, `layout`, glyph runs e `createSubset`; a documentação do OpenType.js descreve sua própria API de parse, sem declarar essa compatibilidade. Não fiz troca nem adaptação especulativa: poderia degradar fontes manuscritas, shaping ou incorporação/subset. Referências primárias: [licença OpenType.js](https://github.com/opentypejs/opentype.js/blob/master/LICENSE), [API/interface esperada por pdf-lib](https://github.com/Hopding/pdf-lib/blob/master/src/types/fontkit.ts) e [documentação de parse do OpenType.js](https://github.com/opentypejs/opentype.js/blob/master/README.md).

## Estado da solicitação upstream sobre Fontkit — 2026-11-02

- A busca atual encontrou a [discussão #1791](https://github.com/Hopding/pdf-lib/discussions/1791) sem resposta de mantenedor. Um participante independente relata ter reconstruído o bundle e publicado uma lista de notices no [gist associado](https://gist.github.com/Vituartzz/9bb8cb17b2e05cfe8e836b05311e16e4), mas essa publicação não é um aviso oficial do autor/mantenedor. A própria resposta identifica trechos Apache-2.0 preservados e dependências transitivas embutidas; é uma pista técnica útil para auditoria, não uma licença oficial aprovada.
- A [solicitação #1793](https://github.com/Hopding/pdf-lib/issues/1793) foi fechada automaticamente pelo bot de stale em 2026-10-26, sem resposta de mantenedor visível. Portanto, o bloqueio de proveniência **continua aberto**. Não copiei o gist para `THIRD_PARTY_NOTICES` nem alterei o status da dependência, pois isso apresentaria uma análise comunitária como autorização oficial.
- Próxima ação segura: pedir confirmação ao mantenedor/fornecedor ou substituir a dependência por uma alternativa com avisos verificáveis e validar novamente incorporação, subset, shaping, fontes manuscritas e regressões de assinatura. Até lá, a distribuição comercial deve passar por revisão jurídica própria; esta auditoria técnica não é aconselhamento jurídico.

## Verificação do pacote npm exato — 2026-11-02

- `npm view @pdf-lib/fontkit@1.1.1 ...` retornou do registry a integridade `sha512-KjMd7grNapIWS/Dm0gvfHEilSyAmeLvrEGVcqLGi0VYebuqqzTbgF29efCx7tvx+IEbG3zQciRSWl3GkUSvjZg==`, licença declarada `MIT`, autor `Andrew Dillon` e contributor `Devon Govett`. A página oficial do [pacote npm](https://www.npmjs.com/package/@pdf-lib/fontkit?activeTab=versions) confirma a licença e a versão 1.1.1.
- Inspecionei a cópia instalada correspondente à versão 1.1.1: `package.json` contém esses metadados, o README apenas aponta para o texto MIT genérico, e o pacote não contém arquivo `LICENSE` nem copyright completo no bundle. Isso confirma a lacuna observada pela auditoria sem confundir declaração SPDX/MIT com um notice completo.
- Essa evidência não resolve quem detém/compartilha os direitos autorais de todo o bundle nem enumera de forma autoritativa notices incorporados. Não criei um copyright ou licença reconstruída a partir do campo de autor; a pendência de distribuição permanece até confirmação upstream/proveniência verificável ou substituição validada.

## Componentes Rust sem SPDX na SBOM Canvas — 2026-11-02

- Inspecionei os nove componentes sem `licenses`/SPDX na SBOM CycloneDX do pacote Windows x64 1.0.13. Seis são crates de registry; consultei a API oficial crates.io para a versão e baixei os `.crate` exatos para `%TEMP%\central-pdf-canvas-crate-license-audit-20261103`. O SHA-256 de cada arquivo corresponde tanto ao checksum do registry quanto ao hash que a SBOM declara para o componente:

| Crate | Versão | Licença do registry | Arquivos no pacote | Verificação |
| --- | --- | --- | --- | --- |
| [`anstyle`](https://crates.io/api/v1/crates/anstyle/1.0.14) | 1.0.14 | MIT OR Apache-2.0 | `LICENSE-MIT`, `LICENSE-APACHE` | checksum/SBOM coincidem |
| [`clap`](https://crates.io/api/v1/crates/clap/4.6.7) | 4.6.7 | MIT OR Apache-2.0 | `LICENSE-MIT`, `LICENSE-APACHE` | checksum/SBOM coincidem |
| [`clap_builder`](https://crates.io/api/v1/crates/clap_builder/4.6.7) | 4.6.7 | MIT OR Apache-2.0 | `LICENSE-MIT`, `LICENSE-APACHE` | checksum/SBOM coincidem |
| [`clap_lex`](https://crates.io/api/v1/crates/clap_lex/1.1.1) | 1.1.1 | MIT OR Apache-2.0 | `LICENSE-MIT`, `LICENSE-APACHE` | checksum/SBOM coincidem |
| [`cxxbridge-cmd`](https://crates.io/api/v1/crates/cxxbridge-cmd/1.0.205) | 1.0.205 | MIT OR Apache-2.0 | `LICENSE-MIT`, `LICENSE-APACHE` | checksum/SBOM coincidem |
| [`strsim`](https://crates.io/api/v1/crates/strsim/0.11.1) | 0.11.1 | MIT | `LICENSE` | checksum/SBOM coincidem |

- Isso confirma proveniência/licença dos seis crates, mas não altera a SBOM original (hash do binário e SBOM são verificados byte a byte) nem prova que cada crate de build foi incorporado ao binário final. Os três componentes restantes são `skia.win32-x64-msvc.node`, `canvas@0.1.0` e `skia-fontations@0.0.0`. O commit de origem do pacote npm `@napi-rs/canvas@1.0.13` é `00a115d9903647f116daf86eccd2c6ba36128371`; o manifest `skia-fontations` não declara licença e referencia código sob o submódulo Skia. O projeto publica um [SBOM de release e código-fonte](https://github.com/Brooooooklyn/canvas/releases/tag/v1.0.13), mas a enumeração desses três componentes ainda requer proveniência/notices completos do binário e dos trechos locais/Skia.
- Conclusão revisada: os seis crates de registry deixaram de ser uma lacuna de licença por falta de metadado; continuam seis entradas sem SPDX no artefato upstream, e as três lacunas acima mantêm aberta a gate de aviso/proveniência do Canvas. Não tratar a auditoria legal como liberada.
- `scripts/testing/run-runtime-license-audit.js` agora mantém essa evidência como mapa offline versionado: compara nome, versão, PURL e SHA-256 crates.io/SBOM, falhando se a SBOM ou os hashes mudarem sem nova revisão. Executado contra o `win-unpacked` QA 1.2.10: passou e listou os seis metadados verificados, os três componentes sem evidência equivalente e a lacuna Fontkit; `test:runtime-license-manifest` também passou (5 avisos centrais íntegros). O teste atesta a consistência da auditoria, não uma liberação legal.

