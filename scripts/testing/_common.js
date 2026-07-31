const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');
const { execFileSync, spawnSync } = require('child_process');
const { PDFDocument } = require('pdf-lib');

const ROOT = path.resolve(__dirname, '..', '..');
const REPORTS_DIR = path.join(ROOT, 'reports');
const TEST_ASSETS_DIR = path.join(ROOT, 'test-assets');
const GENERATED_ASSETS_DIR = path.join(TEST_ASSETS_DIR, 'generated');
const TEMP_ROOT = path.join(ROOT, '.tmp-test-runs');

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
  return dirPath;
}

function resetDir(dirPath) {
  fs.rmSync(dirPath, { recursive: true, force: true });
  fs.mkdirSync(dirPath, { recursive: true });
  return dirPath;
}

function createTempDir(name) {
  ensureDir(TEMP_ROOT);
  const dirPath = path.join(TEMP_ROOT, `${name}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`);
  fs.mkdirSync(dirPath, { recursive: true });
  return dirPath;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
}

function writeText(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, value, 'utf8');
}

function writeReport(fileName, lines) {
  ensureDir(REPORTS_DIR);
  const output = Array.isArray(lines) ? `${lines.join(os.EOL)}${os.EOL}` : String(lines);
  const reportPath = path.join(REPORTS_DIR, fileName);
  fs.writeFileSync(reportPath, output, 'utf8');
  return reportPath;
}

function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: 'utf8',
    shell: false,
    ...options
  });
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || ''
  };
}

function execCommand(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options
  });
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return 'n/a';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(value >= 10 || index === 0 ? 0 : 1)} ${units[index]}`;
}

function sanitizeMarkdown(text) {
  return String(text).replace(/\|/g, '\\|');
}

function toMarkdownTable(headers, rows) {
  const head = `| ${headers.join(' | ')} |`;
  const separator = `| ${headers.map(() => '---').join(' | ')} |`;
  const body = rows.map((row) => `| ${row.map((cell) => sanitizeMarkdown(cell)).join(' | ')} |`);
  return [head, separator, ...body];
}

async function countPdfPages(filePath) {
  return withSuppressedPdfParserNoise(async () => {
    const bytes = fs.readFileSync(filePath);
    const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
    return doc.getPageCount();
  });
}

async function withSuppressedPdfParserNoise(fn) {
  const originalWrite = process.stderr.write.bind(process.stderr);
  const originalWarn = console.warn;
  process.stderr.write = (chunk, encoding, callback) => {
    const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk || '');
    if (
      text.includes('Invalid object ref:') ||
      text.includes('Trying to parse invalid object:')
    ) {
      if (typeof callback === 'function') callback();
      return true;
    }
    return originalWrite(chunk, encoding, callback);
  };
  console.warn = () => {};
  try {
    return await fn();
  } finally {
    process.stderr.write = originalWrite;
    console.warn = originalWarn;
  }
}

function tinyPngBuffer() {
  return Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAfUlEQVR4nO3PQQ3AIADAQEASmhCLrIngcVnSU9DOs+/4s6UDXjWgNaA1oDWgNaA1oDWgNaA1oDWgNaA1oDWgNaA1oDWgNaA1oDWgNaA1oDWgNaA1oDWgNaA1oDWgNaA1oDWgNaA1oDWgNaA1oDWgNaA1oDWgfaZLAmB6Ac0PAAAAAElFTkSuQmCC',
    'base64'
  );
}

function tinyJpgBuffer() {
  return Buffer.from(
    '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAVEQEBAAAAAAAAAAAAAAAAAAACAP/aAAwDAQACEAMQAAAByA//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAEFAqf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/AX//xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/AX//2Q==',
    'base64'
  );
}

function sampleSvgText(text = 'CENTRAL PDF') {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="320" height="96" viewBox="0 0 320 96">\n  <rect width="320" height="96" rx="16" fill="#6e6e6e" opacity="0.12"/>\n  <text x="24" y="58" font-family="Segoe UI, Arial, sans-serif" font-size="28" fill="#6e6e6e">${text}</text>\n</svg>`;
}

module.exports = {
  ROOT,
  REPORTS_DIR,
  TEST_ASSETS_DIR,
  GENERATED_ASSETS_DIR,
  TEMP_ROOT,
  assert,
  ensureDir,
  resetDir,
  createTempDir,
  readJson,
  writeJson,
  writeText,
  writeReport,
  runCommand,
  execCommand,
  formatBytes,
  toMarkdownTable,
  countPdfPages,
  withSuppressedPdfParserNoise,
  tinyPngBuffer,
  tinyJpgBuffer,
  sampleSvgText
};
