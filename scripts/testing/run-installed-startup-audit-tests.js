const assert = require('node:assert/strict');
const { parseShortcutBuffer, matchesExpectedVersion } = require('./run-installed-startup-audit');

function createShortcut({ base, suffix, argumentsText = '' }) {
  const unicode = (value) => Buffer.from(`${value}\0`, 'utf16le');
  const baseBytes = unicode(base);
  const suffixBytes = unicode(suffix);
  const argumentBytes = argumentsText ? unicode(argumentsText) : Buffer.alloc(0);
  const linkInfoHeaderSize = 0x24;
  const linkInfoSize = linkInfoHeaderSize + baseBytes.length + suffixBytes.length;
  const linkInfo = Buffer.alloc(linkInfoSize);
  linkInfo.writeUInt32LE(linkInfoSize, 0);
  linkInfo.writeUInt32LE(linkInfoHeaderSize, 4);
  linkInfo.writeUInt32LE(1, 8);
  linkInfo.writeUInt32LE(linkInfoHeaderSize, 28);
  linkInfo.writeUInt32LE(linkInfoHeaderSize + baseBytes.length, 32);
  baseBytes.copy(linkInfo, linkInfoHeaderSize);
  suffixBytes.copy(linkInfo, linkInfoHeaderSize + baseBytes.length);

  const header = Buffer.alloc(76);
  header.writeUInt32LE(0x4c, 0);
  header.writeUInt32LE(0x82 | (argumentBytes.length ? 0x20 : 0), 20);
  const stringData = argumentBytes.length
    ? Buffer.concat([Buffer.from([argumentsText.length & 0xff, argumentsText.length >> 8]), argumentBytes])
    : Buffer.alloc(0);
  return Buffer.concat([header, linkInfo, stringData]);
}

const expected = 'C:\\Program Files\\Central PDF\\Central PDF.exe';
const validTarget = parseShortcutBuffer(createShortcut({ base: 'C:\\Program Files\\Central PDF', suffix: '\\Central PDF.exe' }));
assert.equal(validTarget.target, expected, 'Destino `.lnk` Unicode com caminho local não foi interpretado corretamente.');

const misleadingTarget = parseShortcutBuffer(createShortcut({
  base: 'C:\\Program Files\\Central PDF',
  suffix: '\\electron.exe',
  argumentsText: '--app="C:\\Program Files\\Central PDF\\Central PDF.exe"'
}));
assert.equal(misleadingTarget.target, 'C:\\Program Files\\Central PDF\\electron.exe', 'O parser aceitou texto nos argumentos como se fosse o executável de destino.');
assert.notEqual(misleadingTarget.target.toLowerCase(), expected.toLowerCase(), 'Atalho para Electron deve ser rejeitado.');
assert.equal(parseShortcutBuffer(Buffer.alloc(20)), null, 'Atalho truncado deve falhar de forma segura.');
assert.equal(matchesExpectedVersion('1.2.21', '1.2.21'), true, 'A versão esperada deve ser reconhecida.');
assert.equal(matchesExpectedVersion('1.2.18', '1.2.21'), false, 'Uma instalação antiga deve ser detectada.');
assert.equal(matchesExpectedVersion(null, '1.2.21'), false, 'Metadados ausentes devem falhar com segurança.');

console.log('Installed startup audit helper checks passed: 6 (shortcuts and package version).');
