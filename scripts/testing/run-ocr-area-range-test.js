const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { writeReport } = require('./_common');
const { recognizePdfArea } = require('../../src/main/services/ocr/ocr-service');
const { openPdfJsDocumentFromFile } = require('../../src/main/services/ocr/pdf-range-transport');

async function run() {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'central-pdf-ocr-area-range-'));
  const sourcePath = path.resolve(__dirname, '../../test-assets/generated/pdf-to-word-hybrid.pdf');
  const testPath = path.join(temporaryDirectory, 'documento-hibrido-grande.pdf');
  const originalReadFile = fs.promises.readFile;
  let sourceFullReads = 0;

  try {
    fs.copyFileSync(sourcePath, testPath);
    fs.appendFileSync(testPath, Buffer.alloc(128 * 1024, 0x20));
    fs.promises.readFile = function readFileWithoutSourceBuffer(filePath, ...args) {
      if (path.resolve(String(filePath)) === testPath) {
        sourceFullReads += 1;
        throw new Error('A extração regional tentou carregar o PDF inteiro.');
      }
      return originalReadFile.call(this, filePath, ...args);
    };

    const result = await recognizePdfArea(
      testPath,
      1,
      { x: 0, y: 0, width: 1, height: 1 },
      { language: 'eng' }
    );
    assert.equal(sourceFullReads, 0, 'A origem não deve ser carregada integralmente na memória.');
    assert.equal(result.pageNumber, 1);
    assert.equal(result.recognized, true);
    assert.match(result.text, /ACCOUNT 2026/i);

    let cancellationChecks = 0;
    await assert.rejects(recognizePdfArea(
      testPath,
      1,
      { x: 0, y: 0, width: 1, height: 1 },
      { language: 'eng' },
      () => {},
      () => ++cancellationChecks > 2
    ), /OPERATION_CANCELLED/);
    assert.ok(cancellationChecks >= 3, 'O cancelamento deve permanecer ativo durante a leitura por faixas.');
    assert.equal(sourceFullReads, 0, 'O cancelamento também não deve carregar a origem integralmente.');

    let cancelInFlight = false;
    let signalRangeRead;
    let releaseRangeRead;
    let deliveredRanges = 0;
    const rangeReadStarted = new Promise((resolve) => { signalRangeRead = resolve; });
    const delayedRead = new Promise((resolve) => { releaseRangeRead = resolve; });
    const originalOpen = fs.promises.open;
    fs.promises.open = async function openWithDelayedRangeRead(filePath, ...args) {
      const fileHandle = await originalOpen.call(this, filePath, ...args);
      if (path.resolve(String(filePath)) !== testPath) return fileHandle;
      return new Proxy(fileHandle, {
        get(target, property) {
          if (property === 'read') {
            return async (...readArgs) => {
              if (readArgs[3] > 0) {
                signalRangeRead();
                await delayedRead;
              }
              return target.read(...readArgs);
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        }
      });
    };

    let rangeDocument;
    let requestedTransport;
    try {
      const fakePdfJs = {
        PDFDataRangeTransport: class {
          constructor() {}
          onDataRange() { deliveredRanges += 1; }
        },
        getDocument: (documentOptions) => {
          requestedTransport = documentOptions.range;
          return { destroy: async () => {} };
        }
      };
      rangeDocument = await openPdfJsDocumentFromFile(fakePdfJs, testPath, {}, () => cancelInFlight);
      requestedTransport.requestDataRange(64 * 1024, (64 * 1024) + 64);
      await Promise.race([
        rangeReadStarted,
        new Promise((_, reject) => setTimeout(() => reject(new Error('O teste não iniciou a leitura de faixa esperada.')), 3000))
      ]);
      cancelInFlight = true;
      releaseRangeRead();
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(rangeDocument.getReadError()?.message, 'OPERATION_CANCELLED');
      assert.equal(deliveredRanges, 0, 'Uma faixa lida após o cancelamento não pode ser entregue ao PDF.js.');
    } finally {
      cancelInFlight = true;
      releaseRangeRead();
      fs.promises.open = originalOpen;
      await rangeDocument?.close();
    }

    const report = writeReport('ocr-area-range-report.md', [
      '# Regressão focada — OCR regional por intervalos', '',
      `Aprovado: OCR reconheceu texto em PDF de ${fs.statSync(testPath).size} bytes sem leitura integral da origem.`,
      `Aprovado: cancelamento durante a leitura inicial foi respeitado (${cancellationChecks} verificações).`,
      'Aprovado: leitura de faixa em andamento foi interrompida antes de entregar bytes ao PDF.js.',
      `Leituras integrais da origem: ${sourceFullReads}.`,
      'O fixture é sintético/local; nenhum arquivo do usuário ou rede foi acessado.'
    ]);
    console.log(`OCR area range passed: source=${fs.statSync(testPath).size} bytes, fullReads=${sourceFullReads}; report: ${report}`);
  } finally {
    fs.promises.readFile = originalReadFile;
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

run().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
