# Criar referências de texto para medir OCR

O corpus SmartScan fornecido contém imagens sintéticas e metadados, mas não contém transcrições esperadas. Sem texto de referência conferido por uma pessoa, não é possível calcular CER/WER de forma válida.

## Anotação offline

1. Abra `scripts/testing/ocr-reference-annotator.html` no Edge ou Chrome.
2. Selecione a pasta do corpus em **Selecionar pasta de imagens**.
3. Opcionalmente, importe o `manifesto.csv` original para visualizar tipo de papel e defeito.
4. Transcreva o conteúdo visível fielmente, preservando palavras e pontuação. O texto digitado fica como rascunho; use **Ctrl+Enter** para confirmar a transcrição. Para páginas sem texto ou impossíveis de ler, use **Marcar em branco** ou **Marcar ilegível**. Navegue com **Próxima pendente**.
5. Exporte o CSV de referências. A coluna `status_revisao` registra pendente, rascunho, transcrito, em branco ou ilegível; o avaliador continua usando apenas `texto` como gabarito. O navegador não envia imagens nem textos pela rede; o texto fica só na memória da aba até a exportação.
6. Faça uma cópia de trabalho do corpus, sem alterar o original, e coloque nela o CSV exportado renomeado para `manifesto.csv`.
7. Rode `npm run test:ocr-corpus -- "CAMINHO_DA_COPIA"`. O avaliador exige `arquivo` e reconhece `texto` como coluna de referência; também usa `paper_type` e `defeito` quando presentes.

Páginas marcadas como em branco ou ilegíveis ficam sem transcrição e não entram na métrica de texto, mas são consideradas revisadas pela navegação. Não copie o resultado do OCR para a coluna `texto`: isso contaminaria o gabarito e produziria uma medida enganosa. A saída contém texto potencialmente sensível e deve ser armazenada conforme as regras locais de dados.

## Testes

`npm run test:ocr-reference-annotator` passou 46 verificações: CSV (BOM, aspas, vírgulas, quebras de linha, validação estrutural), estados de revisão e 20 interações simuladas de DOM para seleção de pasta, navegação, marcar em branco/ilegível, rascunho, confirmação Ctrl+Enter, botão de pendências, exportação, limpeza e zoom. ESLint focal também passou. A simulação não substitui revisão visual nem o seletor de arquivos nativo real, que seguem pendentes. Esses testes validam o formato e a lógica de estados, não a qualidade da transcrição humana nem a precisão do OCR.

## Amostra SmartScan verificada incluída no projeto

Foram adicionadas três páginas sintéticas do lote de 360 à pasta [`test-assets/ocr-smartscan-360-reference`](../test-assets/ocr-smartscan-360-reference/manifesto.csv): uma limpa, uma em baixo contraste e uma A4 paisagem com furos de scanner. As transcrições foram conferidas visualmente, incluindo tabelas e pontuação monetária; as cópias do projeto são independentes dos arquivos originais. `npm run test:ocr-smartscan-360-reference` processou 3/3 páginas sem falhas, com CER 0,79%, WER 5,11%, integridade das fontes preservada e sem conteúdo reconhecido no relatório. O resultado é um pequeno conjunto sintético controlado; não representa a precisão em documentos corporativos reais.
