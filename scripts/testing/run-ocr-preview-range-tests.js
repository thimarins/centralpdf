const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { writeReport } = require('./_common');
const { PDF_PREVIEW_RANGE_CHUNK_BYTES, createPdfPreviewRangeSessions } = require('../../src/main/services/ocr/pdf-preview-range-sessions');

async function run() {
  const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'central-pdf-preview-range-'));
  const pdfPath = path.join(tempDirectory, 'documento.pdf');
  const originalBytes = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(180 * 1024, 0x5a)]);
  fs.writeFileSync(pdfPath, originalBytes);
  let currentTime = Date.now();
  let nextId = 0;
  let maxBytesSeen = 0;
  const sessions = createPdfPreviewRangeSessions({
    fs,
    path,
    inspectPdfFileAsync: async (filePath, maxBytes) => {
      maxBytesSeen = maxBytes;
      const stats = await fs.promises.stat(filePath);
      return { ok: stats.isFile() && stats.size <= maxBytes };
    },
    getMaxFileSize: () => 1024 * 1024,
    maxSupportedBytes: 2 * 1024 * 1024,
    createId: () => `session-${++nextId}`,
    now: () => currentTime
  });
  const firstSender = { destroyed: false, isDestroyed() { return this.destroyed; } };
  const secondSender = { destroyed: false, isDestroyed() { return this.destroyed; } };
  const checks = [];

  try {
    await assert.rejects(sessions.open(firstSender, path.join(tempDirectory, 'missing.txt')), /PDF válido/i);
    await assert.rejects(sessions.open(firstSender, path.join(tempDirectory, 'missing.pdf')), /ainda existe/i);
    checks.push('bloqueia formato/extensão que não é PDF');

    const opened = await sessions.open(firstSender, pdfPath);
    assert.equal(maxBytesSeen, 1024 * 1024);
    assert.equal(opened.length, originalBytes.length);
    assert.equal(opened.initialData.byteLength, PDF_PREVIEW_RANGE_CHUNK_BYTES);
    assert.deepEqual(Buffer.from(opened.initialData), originalBytes.subarray(0, PDF_PREVIEW_RANGE_CHUNK_BYTES));
    checks.push('prévia inicial retorna apenas o primeiro bloco de 64 KiB dentro do limite configurado');

    await assert.rejects(sessions.read(secondSender, { sessionId: opened.sessionId, begin: 0, end: 32 }), /outra janela/i);
    const chunk = await sessions.read(firstSender, { sessionId: opened.sessionId, begin: 96 * 1024, end: 160 * 1024 });
    assert.equal(chunk.byteLength, PDF_PREVIEW_RANGE_CHUNK_BYTES);
    assert.deepEqual(Buffer.from(chunk), originalBytes.subarray(96 * 1024, 160 * 1024));
    checks.push('sessão é isolada por renderer e lê intervalos válidos fora do bloco inicial');

    await assert.rejects(sessions.read(firstSender, { sessionId: opened.sessionId, begin: 0, end: PDF_PREVIEW_RANGE_CHUNK_BYTES + 1 }), /trecho inválido/i);
    await assert.rejects(sessions.read(firstSender, { sessionId: opened.sessionId, begin: originalBytes.length - 1, end: originalBytes.length + 1 }), /trecho inválido/i);
    checks.push('rejeita blocos acima do limite e posições fora do arquivo');

    fs.appendFileSync(pdfPath, Buffer.from('mudança'));
    await assert.rejects(sessions.read(firstSender, { sessionId: opened.sessionId, begin: 0, end: 32 }), /alterado/i);
    checks.push('interrompe a leitura quando identidade/tamanho do arquivo muda');

    const expiring = await sessions.open(firstSender, pdfPath);
    currentTime += 10 * 60 * 1000 + 1;
    await assert.rejects(sessions.read(firstSender, { sessionId: expiring.sessionId, begin: 0, end: 32 }), /expirou/i);
    checks.push('expira sessões ociosas');

    const closing = await sessions.open(firstSender, pdfPath);
    assert.equal(sessions.closeSender(firstSender), 1);
    await assert.rejects(sessions.read(firstSender, { sessionId: closing.sessionId, begin: 0, end: 32 }), /não existe/i);
    checks.push('fecha sessões vinculadas quando o renderer encerra');
  } finally {
    fs.rmSync(tempDirectory, { recursive: true, force: true });
  }

  const report = writeReport('ocr-preview-range-report.md', [
    '# Regressão rápida — sessão local de intervalos PDF', '',
    `Verificações aprovadas: ${checks.length}/${checks.length}.`, '',
    ...checks.map((check) => `- Aprovado: ${check}.`), '',
    'O teste usa PDF sintético local e não acessa arquivos do usuário nem a rede.'
  ]);
  console.log(`OCR preview ranges passed: ${checks.length}/${checks.length}; report: ${report}`);
}

run().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
