const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');
const { ROOT } = require('./_common');

const manifestPath = path.join(ROOT, 'vendor', 'licenses', 'runtime-third-party-notices.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));
assert.equal(manifest.schemaVersion, 1);
assert.ok(Array.isArray(manifest.notices) && manifest.notices.length > 0);
const seen = new Set();
for (const notice of manifest.notices) {
  const key = `${notice.package}@${notice.version}`;
  assert.ok(!seen.has(key), `Aviso duplicado: ${key}`);
  seen.add(key);
  const locked = lock.packages[`node_modules/${notice.package}`];
  assert.ok(locked, `Pacote não está no lockfile: ${key}`);
  assert.equal(locked.version, notice.version, `Versão desatualizada no aviso: ${key}`);
  assert.equal(locked.license, notice.license, `Licença divergente do lockfile: ${key}`);
  assert.match(notice.source, /^https:\/\//, `Fonte sem URL HTTPS: ${key}`);
  assert.ok(notice.text.trim().length >= 300, `Texto de licença inesperadamente curto: ${key}`);
  if (notice.license === 'MIT') {
    assert.match(notice.text, /Permission is hereby granted/i, `Texto MIT incompleto: ${key}`);
    assert.match(notice.text, /THE SOFTWARE IS PROVIDED/i, `Disclaimer MIT ausente: ${key}`);
  }
  if (notice.license === 'BSD-2-Clause') {
    assert.match(notice.text, /Redistribution and use in source and binary forms/i, `Texto BSD incompleto: ${key}`);
    assert.match(notice.text, /THIS SOFTWARE IS PROVIDED/i, `Disclaimer BSD ausente: ${key}`);
  }
}
const canvasNotice = manifest.notices.find((notice) => notice.package === '@napi-rs/canvas-win32-x64-msvc' && notice.version === '1.0.13');
assert.ok(canvasNotice, 'Aviso MIT do binding Windows Canvas 1.0.13 ausente.');
assert.match(canvasNotice.source, /Brooooooklyn\/canvas\/blob\/v1\.0\.13\/LICENSE$/);
const canvasLicense = fs.readFileSync(path.join(ROOT, 'node_modules', '@napi-rs', 'canvas', 'LICENSE'), 'utf8')
  .split(/\r?\n---\r?\n/, 1)[0]
  .trim();
assert.equal(canvasNotice.text, canvasLicense, 'Aviso do binding Canvas não corresponde ao texto MIT exato do upstream versionado.');
console.log(`Runtime license manifest passed: ${manifest.notices.length} version-pinned, complete notices.`);
