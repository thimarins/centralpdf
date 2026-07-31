const fs = require('fs');
const path = require('path');
const Module = require('module');
const { PDFDocument } = require('pdf-lib');
const {
  assert,
  createTempDir,
  ensureDir,
  writeReport,
  countPdfPages,
  withSuppressedPdfParserNoise,
  formatBytes,
  toMarkdownTable
} = require('./_common');
const { generateTestAssets } = require('./generate-test-assets');
const pdfService = require('../../src/main/pdf-service');
const logger = require('../../src/main/logger');
const utils = require('../../src/main/utils');
const { APP_PATHS } = require('../../src/main/constants');
const { convertImagesToPdf } = require('../../src/main/services/image-conversion/image-to-pdf');
const { applySimpleSignature } = require('../../src/main/services/signature/signature-service');
const { convertPdfToWord } = require('../../src/main/services/conversion/pdf-to-word');

function freshConfigServiceWithElectron(mockElectron) {
  const targetPath = require.resolve('../../src/main/config-service');
  const originalLoad = Module._load;
  delete require.cache[targetPath];
  Module._load = function patched(request, parent, isMain) {
    if (request === 'electron') {
      return mockElectron;
    }
    return originalLoad.apply(this, arguments);
  };

  try {
    return require('../../src/main/config-service');
  } finally {
    Module._load = originalLoad;
  }
}

async function withSuppressedStderr(fn) {
  const originalWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = () => true;
  try {
    return await fn();
  } finally {
    process.stderr.write = originalWrite;
  }
}

async function verifyRotation(filePath, expectedDegrees) {
  const originalWrite = process.stderr.write.bind(process.stderr);
  const originalWarn = console.warn;
  process.stderr.write = () => true;
  console.warn = () => {};
  try {
    const doc = await PDFDocument.load(fs.readFileSync(filePath), { ignoreEncryption: true });
    const angle = doc.getPages()[0].getRotation().angle;
    return angle === expectedDegrees;
  } finally {
    process.stderr.write = originalWrite;
    console.warn = originalWarn;
  }
}

async function runFunctionalTests() {
  const manifest = await generateTestAssets();
  const assets = manifest.files;
  const workspace = createTempDir('functional-suite');
  const splitDir = ensureDir(path.join(workspace, 'split'));
  const splitSizeDir = ensureDir(path.join(workspace, 'split-size'));
  const watermarkDir = ensureDir(path.join(workspace, 'watermark'));
  const diagnosticsDir = ensureDir(path.join(workspace, 'diagnostics'));
  const logsDir = ensureDir(path.join(workspace, 'logs'));
  const signatureDir = ensureDir(path.join(workspace, 'signature'));
  const conversionDir = ensureDir(path.join(workspace, 'conversion'));
  const results = [];

  function record(name, status, details) {
    results.push({ name, status, details });
  }

  assert.strictEqual(utils.sanitizeFilename('..\\CON?.pdf'), 'CON_.pdf');
  record('sanitizeFilename', 'ok', 'sanitiza traversal e nomes reservados do Windows');

  assert.deepStrictEqual(utils.parsePageRanges('1-3, 5, 7-8', 10), [0, 1, 2, 4, 6, 7]);
  record('parsePageRanges', 'ok', 'intervalos validos convertidos corretamente');

  const smallInspection = utils.inspectPdfFile(assets.smallPdf);
  assert.ok(smallInspection.ok);
  assert.deepStrictEqual(smallInspection.warnings, []);
  record('inspectPdfFile small', 'ok', `arquivo pequeno valido (${formatBytes(smallInspection.size)})`);

  const largeInspection = utils.inspectPdfFile(assets.largeVirtualPdf);
  assert.ok(largeInspection.ok);
  assert.ok(largeInspection.warnings.includes('large'));
  record('inspectPdfFile large warning', 'ok', `warnings: ${largeInspection.warnings.join(', ')}`);

  const hugeInspection = utils.inspectPdfFile(assets.hugeVirtualPdf);
  assert.ok(hugeInspection.ok);
  assert.ok(hugeInspection.warnings.includes('heavy-mode'));
  record('inspectPdfFile huge warning', 'ok', `warnings: ${hugeInspection.warnings.join(', ')}`);

  const nearLimitInspection = utils.inspectPdfFile(assets.nearLimitVirtualPdf);
  assert.ok(nearLimitInspection.ok);
  assert.ok(nearLimitInspection.warnings.includes('near-limit'));
  record('inspectPdfFile near-limit warning', 'ok', `warnings: ${nearLimitInspection.warnings.join(', ')}`);

  const oversizeInspection = utils.inspectPdfFile(assets.oversizeVirtualPdf);
  assert.ok(!oversizeInspection.ok);
  record('inspectPdfFile oversize rejection', 'ok', 'arquivo acima do limite oficial rejeitado');

  assert.ok(!utils.isValidPdfPath(assets.fakePdf));
  record('fake pdf rejection', 'ok', 'arquivo renomeado sem estrutura PDF foi rejeitado');

  assert.ok(utils.isValidImagePath(assets.watermarkPng));
  assert.ok(utils.isValidImagePath(assets.watermarkJpg));
  assert.ok(utils.isValidImagePath(assets.watermarkSvg));
  record('image validation', 'ok', 'PNG, JPG e SVG de teste aceitos');

  assert.strictEqual(pdfService.hasDigitalSignatures(assets.smallPdf), false);
  assert.strictEqual(pdfService.hasDigitalSignatures(assets.signedIndicatorPdf), true);
  record('signature detection', 'ok', 'detector encontra indicador simples de assinatura');

  assert.strictEqual(await pdfService.validatePdfIntegrity(assets.smallPdf), true);
  const corruptIntegrity = await withSuppressedStderr(() => pdfService.validatePdfIntegrity(assets.corruptPdf));
  assert.strictEqual(corruptIntegrity, false);
  record('validatePdfIntegrity', 'ok', 'PDF valido passa e PDF corrompido falha');

  const mergeOutput = path.join(workspace, 'merged.pdf');
  await pdfService.mergePdfs([assets.smallPdf, assets.mediumPdf], mergeOutput);
  assert.strictEqual(await countPdfPages(mergeOutput), 10);
  record('mergePdfs', 'ok', '2 + 8 paginas resultaram em 10 paginas');

  const splitFiles = await pdfService.splitPdfByPages(assets.smallPdf, splitDir, 'pagina');
  assert.strictEqual(splitFiles.length, 2);
  assert.ok(splitFiles.every((file) => fs.existsSync(file)));
  record('splitPdfByPages', 'ok', `gerou ${splitFiles.length} arquivos individuais`);

  const splitRangeOutput = path.join(workspace, 'range.pdf');
  await pdfService.splitPdfByRanges(assets.mediumPdf, '1-3,5', splitRangeOutput);
  assert.strictEqual(await countPdfPages(splitRangeOutput), 4);
  record('splitPdfByRanges', 'ok', 'intervalo 1-3,5 gerou 4 paginas');

  const splitBySize = await pdfService.splitPdfBySize(assets.manyPagesPdf, splitSizeDir, 50 * 1024, 'parte');
  assert.ok(splitBySize.length >= 2);
  record('splitPdfBySize', 'ok', `gerou ${splitBySize.length} partes por limite de tamanho`);

  const organizeOutput = path.join(workspace, 'organized.pdf');
  await pdfService.organizePdf(assets.smallPdf, [
    { sourceIndex: 1, rotation: 90 },
    { sourceIndex: 0, rotation: 0 }
  ], organizeOutput);
  assert.strictEqual(await countPdfPages(organizeOutput), 2);
  assert.ok(await verifyRotation(organizeOutput, 90));
  record('organizePdf', 'ok', 'reordena paginas e aplica rotacao');

  const compressOutput = path.join(workspace, 'compressed.pdf');
  const reduction = await pdfService.compressPdf(assets.imageHeavyPdf, compressOutput);
  assert.ok(fs.existsSync(compressOutput));
  assert.ok(Number.isFinite(reduction) && reduction >= 0);
  record('compressPdf', 'ok', `saida valida com reducao reportada de ${reduction}%`);

  const imagesToPdfOutput = path.join(workspace, 'imagens.pdf');
  const imageToPdfResult = await convertImagesToPdf([
    assets.watermarkPng,
    assets.watermarkJpg,
    assets.watermarkPng
  ], imagesToPdfOutput);
  assert.ok(fs.existsSync(imagesToPdfOutput));
  assert.strictEqual(await countPdfPages(imagesToPdfOutput), 3);
  assert.strictEqual(imageToPdfResult.pageCount, 3);
  record('convertImagesToPdf', 'ok', '3 imagens reunidas em um unico PDF com 3 paginas');

  const signatureOutput = path.join(signatureDir, 'assinado.pdf');
  await applySimpleSignature(assets.smallPdf, signatureOutput, {
    fields: [
      {
        type: 'signature',
        pageIndex: 0,
        xRatio: 0.16,
        yRatio: 0.18,
        widthRatio: 0.32,
        heightRatio: 0.08,
        value: 'Thiago Rodrigues',
        fontFamily: 'SignatureFlow',
        color: '#244a7c',
        opacity: 100,
        rotation: 0
      },
      {
        type: 'date',
        pageIndex: 0,
        xRatio: 0.16,
        yRatio: 0.27,
        widthRatio: 0.18,
        heightRatio: 0.05,
        value: '20/05/2026',
        fontFamily: 'CorporateSans',
        color: '#2f2f2f',
        opacity: 100,
        rotation: 0
      },
      {
        type: 'seal',
        pageIndex: 1,
        xRatio: 0.62,
        yRatio: 0.14,
        widthRatio: 0.18,
        heightRatio: 0.1,
        imagePath: assets.watermarkPng,
        opacity: 100,
        rotation: 0
      }
    ]
  });
  assert.ok(fs.existsSync(signatureOutput));
  assert.strictEqual(await countPdfPages(signatureOutput), 2);
  record('applySimpleSignature', 'ok', 'assinatura visual com texto, data e selo gerou PDF válido');

  const docxConversion = await convertPdfToWord(assets.smallPdf, conversionDir, {
    format: 'docx',
    outputName: 'small-converted.docx'
  });
  assert.ok(fs.existsSync(docxConversion.outputPath));
  assert.ok(docxConversion.extractedCharacters > 0);
  record('convertPdfToWord docx', 'ok', `DOCX gerado com ${docxConversion.extractedCharacters} caracteres extraídos`);

  const textConversion = await convertPdfToWord(assets.smallPdf, conversionDir, {
    format: 'text',
    outputName: 'small-converted.txt'
  });
  assert.ok(fs.existsSync(textConversion.outputPath));
  const textOutput = fs.readFileSync(textConversion.outputPath, 'utf8');
  assert.ok(textOutput.includes('Small Test PDF'));
  record('convertPdfToWord text', 'ok', 'texto estruturado gerado com conteúdo reconhecível');

  await pdfService.applyWatermarkBatch([assets.smallPdf, assets.mediumPdf], watermarkDir, {
    watermarkKind: 'text',
    text: 'CONFIDENCIAL',
    fontSize: 60,
    color: '#6e6e6e',
    opacity: 18,
    rotation: -35,
    position: 'diagonal',
    scale: 100,
    outputSuffix: '_marca_dagua',
    fontFamily: 'HelveticaBold'
  });
  const textWatermarked = fs.readdirSync(watermarkDir).filter((file) => file.endsWith('.pdf'));
  assert.strictEqual(textWatermarked.length, 2);
  record('applyWatermarkBatch text', 'ok', 'aplicacao em lote gerou 2 copias');

  const watermarkImageDir = ensureDir(path.join(workspace, 'watermark-image'));
  await pdfService.applyWatermarkBatch([assets.smallPdf], watermarkImageDir, {
    watermarkKind: 'image',
    imagePath: assets.watermarkPng,
    opacity: 18,
    rotation: -30,
    position: 'center',
    scale: 100,
    outputSuffix: '_wmimg'
  });
  assert.strictEqual(fs.readdirSync(watermarkImageDir).filter((file) => file.endsWith('.pdf')).length, 1);
  record('applyWatermarkBatch image', 'ok', 'marca dagua por imagem gerou saida valida');

  const protectOutput = path.join(workspace, 'protected.pdf');
  await pdfService.encryptPdf(assets.smallPdf, protectOutput, 'senha123');
  assert.ok(fs.existsSync(protectOutput));
  record('encryptPdf', 'ok', 'PDF criptografado com senha gerou arquivo');

  const decryptOutput = path.join(workspace, 'decrypted.pdf');
  await pdfService.decryptPdf(protectOutput, decryptOutput, 'senha123');
  assert.ok(fs.existsSync(decryptOutput));
  assert.strictEqual(await countPdfPages(decryptOutput), 2);
  record('decryptPdf', 'ok', 'PDF descriptografado com senha correta gerou arquivo válido');

  logger.init(logsDir, 30);
  logger.logOperation('TEST_SUITE', 'acao de teste');
  logger.logError('TEST_SUITE', new Error(`Falha em ${assets.smallPdf}`));
  logger.logCrash(new Error(`Crash em ${assets.mediumPdf}`));
  await new Promise((resolve) => setTimeout(resolve, 200));
  await logger.exportDiagnostics(diagnosticsDir, {
    defaultOutputDir: workspace,
    recentHistory: [{ filePath: assets.smallPdf, outputPath: mergeOutput }]
  }, { queueHealthy: true });
  const diagnosticsConfig = JSON.parse(fs.readFileSync(path.join(diagnosticsDir, 'config-diagnostic.json'), 'utf8'));
  const exportedOps = fs.readFileSync(path.join(diagnosticsDir, 'operations.log'), 'utf8');
  assert.strictEqual(diagnosticsConfig.defaultOutputDir, '[configured-output-dir]');
  assert.ok(!exportedOps.includes(assets.smallPdf));
  assert.ok(/\[path:.*\]/.test(exportedOps) || exportedOps.includes('small.pdf'));
  record('exportDiagnostics', 'ok', 'configuracoes e logs saem sanitizados');

  const portableRoot = createTempDir('portable-config');
  fs.writeFileSync(path.join(portableRoot, APP_PATHS.portableMarkerFile), 'portable');
  const electronPortable = {
    app: {
      isPackaged: true,
      getPath: () => path.join(portableRoot, 'userData')
    }
  };
  const configPortable = freshConfigServiceWithElectron(electronPortable);
  const previousCwd = process.cwd();
  const originalExecPath = process.execPath;
  const originalArgv = [...process.argv];
  const originalPortableEnv = process.env.PORTABLE_EXECUTABLE_DIR;
  process.chdir(portableRoot);
  process.env.PORTABLE_EXECUTABLE_DIR = portableRoot;
  process.argv = [...originalArgv, '--portable'];
  configPortable.init();
  assert.strictEqual(configPortable.isPortableMode(), true);
  assert.ok(configPortable.getLogsPath().includes(path.join('data', 'logs')));
  record('configService portable mode', 'ok', 'modo portatil detectado com marker/env');
  process.chdir(previousCwd);
  process.argv = originalArgv;
  if (originalPortableEnv === undefined) {
    delete process.env.PORTABLE_EXECUTABLE_DIR;
  } else {
    process.env.PORTABLE_EXECUTABLE_DIR = originalPortableEnv;
  }

  const installedRoot = createTempDir('installed-config');
  const userData = path.join(installedRoot, 'userData');
  const electronInstalled = {
    app: {
      isPackaged: false,
      getPath: () => userData
    }
  };
  const configInstalled = freshConfigServiceWithElectron(electronInstalled);
  process.chdir(installedRoot);
  delete process.env.PORTABLE_EXECUTABLE_DIR;
  process.argv = originalArgv.filter((value) => value !== '--portable');
  configInstalled.init();
  assert.strictEqual(configInstalled.isPortableMode(), false);
  assert.ok(configInstalled.getLogsPath().startsWith(userData));
  record('configService installed mode', 'ok', 'modo instalado usa userData');
  process.chdir(previousCwd);
  process.argv = originalArgv;

  const table = toMarkdownTable(
    ['Teste', 'Status', 'Detalhes'],
    results.map((result) => [result.name, result.status, result.details])
  );
  const reportPath = writeReport('functional-report.md', [
    '# Functional Test Report',
    '',
    `Gerado em ${new Date().toISOString()}.`,
    '',
    ...table
  ]);

  return {
    ok: true,
    total: results.length,
    reportPath,
    results
  };
}

if (require.main === module) {
  withSuppressedPdfParserNoise(() => runFunctionalTests())
    .then((summary) => {
      console.log(`Functional tests passed: ${summary.total}`);
    })
    .catch((error) => {
      console.error(error.stack || String(error));
      process.exit(1);
    });
}

module.exports = {
  runFunctionalTests
};

