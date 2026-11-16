Central PDF - componentes OCR locais

Este diretório contém os modelos de idioma usados pelo Tesseract.js em modo
offline: por.traineddata e eng.traineddata, do projeto tessdata_fast.
Projeto e licença: https://github.com/tesseract-ocr/tessdata_fast
Versão do motor no aplicativo: tesseract.js 7.0.0 e tesseract.js-core 7.0.0.
Projeto do motor: https://github.com/naptha/tesseract.js

O motor, o núcleo WebAssembly e os modelos tessdata_fast indicam licença
Apache-2.0. O instalador copia os arquivos de licença do motor/núcleo, uma cópia
da licença Apache para os modelos e os avisos dos componentes incorporados no
WebAssembly para `resources/ocr/licenses`. Preserve esses avisos nas
redistribuições. Os avisos WASM correspondem aos submódulos fixados pelo commit
do `tesseract.js-core` 7.0.0 descrito no arquivo `licenses/wasm-third-party/
THIRD-PARTY-NOTICES.txt`.

Nenhum documento, imagem ou texto reconhecido é enviado pela funcionalidade OCR.
