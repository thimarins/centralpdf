const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createCanvas } = require('@napi-rs/canvas');
const { runCorpusAssessment } = require('./run-ocr-corpus-assessment');
const { writeReport } = require('./_common');

const scenarios = [
  ['Relatório mensal aprovado.', 'Referência 2401 — saldo R$ 1.248,50.'],
  ['Ação rápida concluída.', 'Revisão válida em São Paulo.'],
  ['Cadastro de fornecedor ativo.', 'CNPJ 12.345.678/0001-90.'],
  ['Pagamento confirmado.', 'Data: 02/11/2026 — total R$ 728,40.'],
  ['Documento interno revisado.', 'Responsável: equipe financeira.'],
  ['Invoice approved for payment.', 'Reference 51842 — total USD 124.50.'],
  ['Quarterly report: final copy.', 'Reviewed by the operations team.'],
  ['Revisão e proteção concluídas.', 'Informações válidas para o cliente.'],
  ['Comprovante de transferência.', 'Identificador 804217 — situação: pago.'],
  ['Pedido recebido com sucesso.', 'Prazo previsto: 15 dias úteis.'],
  ['Contrato assinado digitalmente.', 'Versão 3.2 — arquivo confidencial.'],
  ['Customer account statement.', 'Account number 204861 — balance 725.40.'],
  ['Nota fiscal de serviço.', 'Valor líquido: R$ 2.580,00.'],
  ['Entrega confirmada no endereço.', 'Protocolo 921-708 — recebido às 14:35.'],
  ['Solicitação aprovada pela gestão.', 'Código interno: FIN-2026-041.'],
  ['Document processing completed.', 'Please retain this copy for your records.'],
  ['Informações cadastrais atualizadas.', 'E-mail confirmado pelo titular.'],
  ['Relatório de auditoria final.', 'Nenhuma divergência encontrada.'],
  ['Invoice number 007428.', 'Due date: 30/11/2026 — amount 980.25.'],
  ['Recibo de pagamento eletrônico.', 'Autorização 482901 — aprovado.'],
  ['Termo de aprovação interna.', 'Ação, revisão e conclusão registradas.'],
  ['Arquivo recebido para análise.', 'Origem: departamento operacional.'],
  ['Monthly account summary.', 'Payment received — thank you.'],
  ['Documento arquivado corretamente.', 'Consulta disponível mediante autorização.'],
  ['Texto reduzido para leitura controlada.', 'Protocolo 552-190 — total R$ 1.905,20.'],
  ['Contraste moderado em papel acinzentado.', 'Ação válida — São Paulo, 02/11/2026.'],
  ['Orientação automática em página girada.', 'Referência 91824 — revisão concluída.'],
  ['Caracteres portugueses: órgão, saúde, início.', 'Nº 74 — validade até 30/11/2026.']
];

function csv(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

async function createLabeledImage(filePath, lines, index) {
  const isSmallText = index === scenarios.length - 4;
  const isLowContrast = index === scenarios.length - 3;
  const isRotated = index === scenarios.length - 2;
  const width = isSmallText ? 1400 : index % 4 === 0 ? 1500 : 1800;
  const height = isSmallText ? 300 : index % 4 === 0 ? 460 : 360;
  const canvas = createCanvas(width, height);
  const context = canvas.getContext('2d');
  const backgrounds = ['#ffffff', '#fafafa', '#f4f4f1', '#f8f8f8'];
  const ink = ['#111111', '#202020', '#303030', '#181818'];
  context.fillStyle = isLowContrast ? '#eeeeea' : backgrounds[index % backgrounds.length];
  context.fillRect(0, 0, width, height);
  context.fillStyle = isLowContrast ? '#666660' : ink[index % ink.length];
  context.font = `${isSmallText ? 30 : isLowContrast ? 38 : index % 3 === 0 ? 48 : 56}px Arial`;
  context.textBaseline = 'top';
  context.textAlign = 'left';
  const rotation = isRotated ? 180 : index % 6 === 0 ? 0.35 : index % 6 === 1 ? -0.35 : 0;
  if (rotation) {
    context.translate(width / 2, height / 2);
    context.rotate(rotation * Math.PI / 180);
    context.translate(-width / 2, -height / 2);
  }
  context.fillText(lines[0], 52, 90, width - 104);
  context.fillText(lines[1], 52, 200, width - 104);
  const format = index % 5 === 4 ? 'image/jpeg' : 'image/png';
  await fs.writeFile(filePath, canvas.toBuffer(format));
}

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'central-pdf-ocr-synthetic-corpus-'));
  const reportPath = writeReport('ocr-synthetic-corpus-report.md', []);
  try {
    const rows = ['arquivo,texto,paper_type,defeito,metric_mode'];
    let corruptEntryAdded = false;
    const addCorruptEntry = async () => {
      const corruptName = 'synthetic-corrupt.png';
      await fs.writeFile(path.join(root, corruptName), 'conteudo propositalmente inválido', 'utf8');
      rows.push([csv(corruptName), csv('referência não comparável pois a imagem é inválida'), 'synthetic', 'corrompido', 'sequence'].join(','));
      corruptEntryAdded = true;
    };
    for (const [index, lines] of scenarios.entries()) {
      if (index === Math.floor(scenarios.length / 2)) await addCorruptEntry();
      const extension = index % 5 === 4 ? 'jpg' : 'png';
      const fileName = `synthetic-${String(index + 1).padStart(2, '0')}.${extension}`;
      await createLabeledImage(path.join(root, fileName), lines, index);
      const defect = index === scenarios.length - 4 ? 'texto_pequeno'
        : index === scenarios.length - 3 ? 'baixo_contraste_controlado'
          : index === scenarios.length - 2 ? 'rotacao_180'
            : index === scenarios.length - 1 ? 'acentuacao' : index % 6 < 2 ? 'leve_inclinacao' : index % 4 === 2 ? 'baixo_contraste' : 'limpo';
      rows.push([csv(fileName), csv(lines.join('\n')), 'synthetic', defect, defect === 'rotacao_180' ? 'tokens' : 'sequence'].join(','));
    }
    assert.ok(corruptEntryAdded, 'O arquivo corrompido precisa aparecer entre itens válidos para testar o pareamento após falhas.');
    await fs.writeFile(path.join(root, 'manifesto.csv'), `${rows.join('\n')}\n`, 'utf8');

    const result = await runCorpusAssessment(root, reportPath, { includeAccuracyByDefect: true });
    const report = await fs.readFile(reportPath, 'utf8');
    assert.equal(result.inputs, scenarios.length + 1);
    assert.equal(result.outputs, scenarios.length, 'A falha de uma imagem deve ser isolada sem cancelar os demais itens.');
    assert.equal(result.failures, 1);
    const accuracy = report.match(/amostras sequenciais: (\d+); CER: ([\d.]+)%; WER: ([\d.]+)%/);
    assert.ok(accuracy, 'O relatório precisa incluir CER/WER agregados.');
    assert.equal(Number(accuracy[1]), scenarios.length - 1, 'A página girada é avaliada por cobertura de palavras, sem pressupor ordem linear no raster invertido.');
    for (const defect of ['texto_pequeno', 'baixo_contraste_controlado', 'acentuacao']) {
      assert.ok(result.accuracyByDefect?.[defect], `O relatório deve apresentar CER/WER agregados para ${defect}.`);
      assert.ok(result.accuracyByDefect[defect].cer <= 0.02, `CER em ${defect} ultrapassou o limite de 2%.`);
      assert.ok(result.accuracyByDefect[defect].wer <= 0.05, `WER em ${defect} ultrapassou o limite de 5%.`);
    }
    assert.equal(result.tokenRecallByDefect?.rotacao_180, 1, 'A rotação deve preservar todas as palavras reconhecidas, mesmo quando a referência não exige ordem espacial.');
    const reversedLineAccuracy = result.reversedLineAccuracyByDefect?.rotacao_180;
    assert.ok(reversedLineAccuracy, 'O caso invertido deve reportar, sem conteúdo, se a ordem extraída acompanha linhas revertidas.');
    assert.ok(reversedLineAccuracy.cer <= 0.02, `CER com ordem espacial normalizada na rotação de 180° ultrapassou 2%: ${(reversedLineAccuracy.cer * 100).toFixed(2)}%.`);
    assert.ok(reversedLineAccuracy.wer <= 0.05, `WER com ordem espacial normalizada na rotação de 180° ultrapassou 5%: ${(reversedLineAccuracy.wer * 100).toFixed(2)}%.`);
    assert.ok(result.orientationCorrectionsByDefect?.rotacao_180?.some((angle) => Math.abs(angle) >= 178), 'A amostra girada em 180° precisa confirmar que o motor escolheu a correção de orientação correspondente.');
    assert.ok(Number(accuracy[2]) <= 2, `CER ${accuracy[2]}% ultrapassou o limite de 2%.`);
    assert.ok(Number(accuracy[3]) <= 5, `WER ${accuracy[3]}% ultrapassou o limite de 5%.`);
    assert.match(report, /Integridade SHA-256 das imagens originais: inalteradas/);
    assert.match(report, /O relatório contém apenas métricas agregadas/);
    const categoryMetricsHeading = report.indexOf('### CER/WER por categoria do fixture');
    const rotatedMetricsHeading = report.indexOf('### Comparação auxiliar da página girada 180°');
    assert.ok(categoryMetricsHeading >= 0 && rotatedMetricsHeading > categoryMetricsHeading, 'As métricas por categoria e a comparação auxiliar de rotação precisam aparecer na ordem correta.');
    assert.match(report.slice(rotatedMetricsHeading), /\| rotacao_180 \|[^\n]+\| 1 \| 0\.00% \| 0\.00% \|/, 'O relatório deve apresentar CER/WER da página girada após normalização espacial.');
    for (const [expectedText] of scenarios) {
      assert.ok(!report.includes(expectedText), 'O relatório de avaliação não pode expor texto esperado/reconhecido.');
    }
    assert.ok(!report.includes('synthetic-01.png'), 'O relatório não deve identificar nomes dos arquivos do corpus.');
    console.log(`OCR synthetic quality corpus passed: ${scenarios.length} labeled images (including small text, reduced contrast, and 180° rotation), one isolated corrupt input, aggregate CER/WER within threshold, source integrity preserved, no text leakage. Report: ${reportPath}`);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
