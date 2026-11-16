const assert = require('node:assert/strict');
const { createCanvas, loadImage } = require('@napi-rs/canvas');
const {
  createMarginTrimmedImage,
  estimateSmallSkewCorrection,
  recognizeWithAdaptiveOrientation
} = require('../../src/main/services/ocr/ocr-service');

function createLowContrastFixture() {
  const canvas = createCanvas(800, 320);
  const context = canvas.getContext('2d');
  context.fillStyle = '#b8b8b8';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = '#c5c5c5';
  context.font = '38px Arial';
  context.textBaseline = 'top';
  context.fillText('Texto legivel apos melhoria', 24, 24);
  return canvas.toBuffer('image/png');
}

function createLargeMarginFixture() {
  const canvas = createCanvas(900, 600);
  const context = canvas.getContext('2d');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = '#111111';
  context.font = '36px Arial';
  context.fillText('CONTRATO 2026', 300, 160);
  context.fillText('Central PDF', 300, 230);
  context.fillText('Página de exemplo', 300, 300);
  context.fillText('Conteúdo para OCR', 300, 370);
  return canvas.toBuffer('image/png');
}

async function run() {
  const fixture = createLowContrastFixture();
  let enhancementAttempts = 0;
  const progress = [];
  const improved = await recognizeWithAdaptiveOrientation(
    fixture,
    { recognize: async () => ({ data: { text: 'Texto reconhecido em documento pesquisavel', confidence: ++enhancementAttempts === 1 ? 10 : 95 } }) },
    { autoRotate: false },
    () => false,
    (event) => progress.push(event)
  );
  assert.equal(enhancementAttempts, 2, 'Desativar rotação também suprimiu a melhoria de imagem independente.');
  assert.equal(improved.preprocessingApplied, true, 'O serviço não registrou a melhoria efetivamente escolhida.');
  assert.equal(progress.some((event) => event.stage === 'orientation-check'), false, 'A rotação foi tentada embora estivesse desativada.');

  let disabledAttempts = 0;
  const unchanged = await recognizeWithAdaptiveOrientation(
    fixture,
    { recognize: async () => ({ data: { text: 'Texto reconhecido em documento pesquisavel', confidence: (disabledAttempts += 1, 10) } }) },
    { autoRotate: false, imageEnhancement: false },
    () => false
  );
  assert.equal(disabledAttempts, 1, 'A melhoria de imagem foi executada apesar de estar desativada.');
  assert.equal(unchanged.preprocessingApplied, false, 'A saída informou pré-processamento quando ele estava desativado.');

  const marginFixture = createLargeMarginFixture();
  let cancellationChecks = 0;
  await assert.rejects(
    estimateSmallSkewCorrection(marginFixture, { isCancelled: () => ++cancellationChecks >= 2 }),
    (error) => error?.message === 'OPERATION_CANCELLED',
    'A análise de inclinação não interrompeu o cálculo após o cancelamento.'
  );
  assert.ok(cancellationChecks >= 2, 'A análise de inclinação não consultou o cancelamento durante a amostragem.');
  const estimatedSkew = await estimateSmallSkewCorrection(marginFixture);
  assert.ok(Number.isFinite(estimatedSkew) && Math.abs(estimatedSkew) <= 3, 'A análise compacta não retornou uma correção de inclinação válida.');

  const directCandidate = await createMarginTrimmedImage(marginFixture);
  assert.ok(directCandidate, 'Margens grandes e uniformes não foram detectadas.');
  const candidateImage = await loadImage(directCandidate.bytes);
  assert.ok(candidateImage.width < 900 && candidateImage.height < 600, 'A imagem de análise não foi recortada.');
  assert.ok(directCandidate.cropOffset.x > 0 && directCandidate.cropOffset.y > 0, 'O recorte não preservou o deslocamento original.');

  const marginProgress = [];
  let marginAttempts = 0;
  const marginResult = await recognizeWithAdaptiveOrientation(
    marginFixture,
    {
      recognize: async (bytes) => {
        marginAttempts += 1;
        const image = await loadImage(bytes);
        const confidence = image.width < 900 && image.height < 600 ? 95 : 10;
        const word = { text: 'CONTRATO', confidence, bbox: { x0: 12, y0: 20, x1: 170, y1: 62 } };
        return { data: {
          text: 'Documento reconhecido para pesquisa completa', confidence, words: [word],
          blocks: [{ paragraphs: [{ lines: [{ baseline: { x0: 12, y0: 62, x1: 170, y1: 62 }, words: [word] }] }] }]
        } };
      }
    },
    { autoRotate: false },
    () => false,
    (event) => marginProgress.push(event)
  );
  assert.equal(marginAttempts, 2, 'O OCR não comparou o recorte uma única vez com a imagem original.');
  assert.equal(marginResult.preprocessingApplied, true, 'O recorte aceito não foi informado no resultado.');
  assert.ok(marginResult.data.words[0].bbox.x0 >= marginResult.cropOffset.x, 'A caixa do texto não foi remapeada para a página original.');
  assert.ok(marginResult.data.blocks[0].paragraphs[0].lines[0].baseline.x0 >= marginResult.cropOffset.x, 'A linha de base não foi remapeada para a página original.');
  assert.ok(marginProgress.some((event) => event.method === 'trim-empty-margins'), 'O progresso não registrou a melhoria de margens escolhida.');

  console.log(JSON.stringify({ ok: true, checks: 13, cases: ['melhoria independente da rotação', 'melhoria explicitamente desativada', 'estimativa de inclinação com coordenadas compactas', 'cancelamento responsivo durante correção de inclinação', 'recorte comparativo de margens com remapeamento'] }));
}

run().catch((error) => {
  console.error(error.stack || String(error));
  process.exitCode = 1;
});
