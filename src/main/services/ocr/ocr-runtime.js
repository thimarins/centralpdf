const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SUPPORTED_LANGUAGES = Object.freeze({ por: 'português', eng: 'inglês' });
const OCR_MODEL_INTEGRITY = Object.freeze({
  por: Object.freeze({ bytes: 1_982_756, sha256: 'c4932b937207a9514b7514d518b931a99938c02a28a5a5a553f8599ed58b7deb' }),
  eng: Object.freeze({ bytes: 4_113_088, sha256: '7d4322bd2a7749724879683fc3912cb542f19906c83bcc1a52132556427170b2' })
});

function getOcrTessdataDirectory({ resourcesPath = process.resourcesPath, moduleDirectory = __dirname } = {}) {
  const packagedRoot = resourcesPath ? path.join(resourcesPath, 'ocr') : '';
  const ocrRoot = packagedRoot && fs.existsSync(packagedRoot)
    ? packagedRoot
    : path.resolve(moduleDirectory, '../../../../vendor/ocr');
  return path.join(ocrRoot, 'tessdata');
}

function getOcrRuntimeStatus(languages = Object.keys(SUPPORTED_LANGUAGES), options = {}) {
  const requested = [...new Set((Array.isArray(languages) ? languages : [languages])
    .map((language) => String(language || '').trim().toLowerCase())
    .filter((language) => Object.hasOwn(SUPPORTED_LANGUAGES, language)))];
  const tessdataDirectory = getOcrTessdataDirectory(options);
  const availableLanguages = [];
  const missingLanguages = [];
  const invalidLanguages = [];

  for (const language of requested) {
    const modelPath = path.join(tessdataDirectory, `${language}.traineddata`);
    try {
      const modelStats = fs.statSync(modelPath);
      fs.accessSync(modelPath, fs.constants.R_OK);
      const integrity = OCR_MODEL_INTEGRITY[language];
      if (!modelStats.isFile()) {
        missingLanguages.push(language);
        continue;
      }
      if (modelStats.size !== integrity.bytes) {
        invalidLanguages.push(language);
        continue;
      }
      const digest = crypto.createHash('sha256').update(fs.readFileSync(modelPath)).digest('hex');
      if (digest !== integrity.sha256) invalidLanguages.push(language);
      else availableLanguages.push(language);
    } catch {
      missingLanguages.push(language);
    }
  }

  const missingNames = missingLanguages.map((language) => SUPPORTED_LANGUAGES[language]);
  const invalidNames = invalidLanguages.map((language) => SUPPORTED_LANGUAGES[language]);
  const problems = [];
  if (missingNames.length) problems.push(`${missingNames.length === 1 ? 'falta o modelo de' : 'faltam os modelos de'} ${missingNames.join(' e ')}`);
  if (invalidNames.length) problems.push(`${invalidNames.length === 1 ? 'o modelo de' : 'os modelos de'} ${invalidNames.join(' e ')} ${invalidNames.length === 1 ? 'está danificado ou foi alterado' : 'estão danificados ou foram alterados'}`);
  const message = problems.length
    ? `O OCR não está disponível porque ${problems.join('; ')} neste aplicativo. Reinstale o Central PDF ou procure o suporte de TI. Seus arquivos não foram alterados.`
    : '';

  return {
    available: requested.length > 0 && availableLanguages.length === requested.length,
    availableLanguages,
    missingLanguages,
    invalidLanguages,
    message
  };
}

module.exports = { SUPPORTED_LANGUAGES, OCR_MODEL_INTEGRITY, getOcrTessdataDirectory, getOcrRuntimeStatus };
