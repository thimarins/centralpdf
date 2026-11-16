const fs = require('fs');
const path = require('path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const asar = require('@electron/asar');
const { ROOT } = require('./_common');

const packagedRoot = process.env.CENTRAL_PDF_OCR_PACKAGE_DIR;
assert.ok(packagedRoot, 'Defina CENTRAL_PDF_OCR_PACKAGE_DIR para o diretório win-unpacked a auditar.');
const archivePath = path.join(packagedRoot, 'resources', 'app.asar');
assert.ok(fs.existsSync(archivePath), `app.asar não encontrado: ${archivePath}`);
const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));
const manifestPath = path.join(ROOT, 'vendor', 'licenses', 'runtime-third-party-notices.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const canvasRegistryLicenseEvidence = [
  { name: 'anstyle', version: '1.0.14', license: 'MIT OR Apache-2.0', checksum: '940b3a0ca603d1eade50a4846a2afffd5ef57a9feac2c0e2ec2e14f9ead76000' },
  { name: 'clap', version: '4.6.7', license: 'MIT OR Apache-2.0', checksum: 'aa8876b300ab35ba921adea3dfd70157a46249b33f95c9084ae5709785478946' },
  { name: 'clap_builder', version: '4.6.7', license: 'MIT OR Apache-2.0', checksum: 'ec0797fb7aeb1406c84efac526901f7ec3ead2124f946b494e72879d4b54704d' },
  { name: 'clap_lex', version: '1.1.1', license: 'MIT OR Apache-2.0', checksum: '1c133bc6a41be0d194c306b5506d15e6feeea7b1d6604bd3f8310dfb2ca96486' },
  { name: 'cxxbridge-cmd', version: '1.0.205', license: 'MIT OR Apache-2.0', checksum: '54a486ed16a3f2a053fe7f5b98db4c1a59846a23e8cb9e49f9d1bd48830d51a2' },
  { name: 'strsim', version: '0.11.1', license: 'MIT', checksum: '7da8b5736845d9f2fcb837ea5d9e2628564b3b043a70948a3f0b778838c5fb4f' }
];
// The platform release pins these local crates to this Canvas commit and Skia
// gitlink. This is source provenance evidence, not a blanket license for the
// aggregated native binary or its third-party dependencies.
const canvasLocalSourceEvidence = {
  canvasCommit: '00a115d9903647f116daf86eccd2c6ba36128371',
  skiaCommit: 'b94213a11b3a2edadfae89f0c57a7f4ab72772c9',
  components: [
    { name: 'canvas', version: '0.1.0', purl: 'pkg:cargo/canvas@0.1.0', sourceLicense: 'MIT' },
    { name: 'skia-fontations', version: '0.0.0', purl: 'pkg:cargo/skia-fontations@0.0.0', sourceLicense: 'Skia BSD-style source; bundled Fontations dependencies audited separately' }
  ]
};
const packagedManifestPath = path.join(packagedRoot, 'resources', 'licenses', 'runtime-third-party-notices.json');
assert.ok(fs.existsSync(packagedManifestPath), 'Inventário central de licenças não foi incluído no pacote.');
assert.deepEqual(fs.readFileSync(packagedManifestPath), fs.readFileSync(manifestPath), 'Inventário central no pacote difere da fonte auditada.');
assert.equal(manifest.schemaVersion, 1, 'Versão inesperada do inventário de avisos centrais.');
const centralNotices = new Map();
for (const notice of manifest.notices) {
  assert.ok(notice.package && notice.version && notice.license && notice.source, 'Aviso central sem identificação/procedência.');
  assert.ok(notice.text?.trim(), `Texto de licença ausente para ${notice.package}@${notice.version}.`);
  const key = `${notice.package}@${notice.version}`;
  assert.ok(!centralNotices.has(key), `Aviso central duplicado: ${key}`);
  centralNotices.set(key, notice);
}

const packagedEntries = asar.listPackage(archivePath);
const packagedFiles = packagedEntries
  .map((entry) => String(entry).replace(/^[/\\]+/, '').replace(/\\/g, '/').toLowerCase());
const productionPackages = Object.entries(lock.packages || {})
  .filter(([packagePath, info]) => packagePath.startsWith('node_modules/') && info?.dev !== true);
const packagedProductionPackages = productionPackages.filter(([packagePath]) => {
  const normalizedPath = packagePath.replace(/\\/g, '/').toLowerCase();
  return packagedFiles.some((filePath) => filePath.startsWith(`${normalizedPath}/`));
});

const coverage = packagedProductionPackages.map(([packagePath, info]) => {
  const packageName = packagePath.slice('node_modules/'.length);
  const normalizedPath = packagePath.replace(/\\/g, '/').toLowerCase();
  const packagePrefix = `${normalizedPath}/`;
  const standaloneLicense = packagedFiles.some((filePath) => filePath.startsWith(packagePrefix)
    && /(^|\/)(license|licence|copying|notice)([^/]*$)/i.test(filePath.slice(packagePrefix.length)));
  const notice = centralNotices.get(`${packageName}@${info.version}`);
  if (notice) {
    assert.equal(notice.license, info.license, `Licença do inventário não confere com o lockfile: ${packageName}@${info.version}`);
  }
  return {
    package: packageName,
    version: info.version,
    declaredLicense: info.license || 'não declarada',
    standaloneLicense,
    centralNotice: Boolean(notice),
    covered: standaloneLicense || Boolean(notice)
  };
});
const missingNotices = coverage.filter((item) => !item.covered);
const canvasPackageName = '@napi-rs/canvas-win32-x64-msvc';
const canvasLockEntry = productionPackages.find(([packagePath]) => packagePath === `node_modules/${canvasPackageName}`);
let canvasSbom = null;
const canvasVersionParts = canvasLockEntry?.[1].version.split('.').map(Number) || [];
const canvasSbomExpected = canvasVersionParts[0] > 1
  || (canvasVersionParts[0] === 1 && (canvasVersionParts[1] > 0 || canvasVersionParts[1] === 0 && canvasVersionParts[2] >= 13));
if (canvasLockEntry) {
  const canvasPackageRoot = path.join(ROOT, 'node_modules', '@napi-rs', 'canvas-win32-x64-msvc');
  const sourceSbomPath = path.join(canvasPackageRoot, 'sbom.cdx.json');
  if (canvasSbomExpected) assert.ok(fs.existsSync(sourceSbomPath), 'A versão Canvas do lockfile exige uma SBOM oficial por plataforma.');
  if (fs.existsSync(sourceSbomPath)) {
    const packagedSbomPath = `node_modules/${canvasPackageName}/sbom.cdx.json`;
    const normalizedSbomPath = packagedSbomPath.toLowerCase();
    assert.ok(packagedFiles.includes(normalizedSbomPath), 'SBOM do binário Canvas não foi incluída no app.asar.');
    const sourceSbomBytes = fs.readFileSync(sourceSbomPath);
    const packagedSbomFile = path.join(packagedRoot, 'resources', 'app.asar.unpacked', packagedSbomPath);
    assert.ok(fs.existsSync(packagedSbomFile), 'SBOM Canvas não foi extraída junto do pacote nativo.');
    const packagedSbomBytes = fs.readFileSync(packagedSbomFile);
    assert.deepEqual(packagedSbomBytes, sourceSbomBytes, 'SBOM Canvas no pacote difere da fonte do tarball verificado.');
    const sbom = JSON.parse(sourceSbomBytes.toString('utf8'));
    const [canvasPackagePath, canvasPackageInfo] = canvasLockEntry;
    assert.equal(sbom.specVersion, '1.6', 'Versão CycloneDX inesperada na SBOM Canvas.');
    assert.equal(sbom.metadata?.component?.name, canvasPackageName, 'SBOM Canvas não identifica o pacote de plataforma esperado.');
    assert.equal(sbom.metadata?.component?.version, canvasPackageInfo.version, 'Versão da SBOM Canvas não confere com o lockfile.');
    const binaryName = JSON.parse(fs.readFileSync(path.join(canvasPackageRoot, 'package.json'), 'utf8')).main;
    const binaryComponent = sbom.components?.find((component) => component.type === 'file' && component.name === binaryName);
    assert.ok(binaryComponent, 'SBOM Canvas não identifica o binário nativo distribuído.');
    const expectedHash = binaryComponent.hashes?.find((hash) => hash.alg === 'SHA-256')?.content;
    const packagedBinaryPath = path.join(packagedRoot, 'resources', 'app.asar.unpacked', canvasPackagePath, binaryName);
    assert.ok(expectedHash && fs.existsSync(packagedBinaryPath), 'Binário Canvas unpacked ou hash SHA-256 da SBOM não disponível.');
    const actualHash = crypto.createHash('sha256').update(fs.readFileSync(packagedBinaryPath)).digest('hex');
    assert.equal(actualHash, expectedHash, 'Hash do binário Canvas empacotado difere da SBOM CycloneDX.');
    const componentsWithoutLicenseExpression = sbom.components.filter((component) => !(component.licenses || []).length);
    const registryLicenseMetadataVerified = canvasRegistryLicenseEvidence.filter((evidence) => {
      const component = componentsWithoutLicenseExpression.find((item) => item.name === evidence.name
        && item.version === evidence.version
        && item.purl === `pkg:cargo/${evidence.name}@${evidence.version}`);
      if (!component) return false;
      const sbomHash = component.hashes?.find((hash) => hash.alg === 'SHA-256')?.content;
      assert.equal(sbomHash, evidence.checksum, `Checksum crates.io/SBOM divergente para ${evidence.name}@${evidence.version}.`);
      return true;
    });
    assert.equal(registryLicenseMetadataVerified.length, canvasRegistryLicenseEvidence.length, 'A evidência crates.io da SBOM Canvas está incompleta ou desatualizada; revise a versão e os checksums antes de aceitar a auditoria.');
    const localSourceComponentsVerified = canvasLocalSourceEvidence.components.filter((evidence) => {
      const component = sbom.components.find((item) => item.name === evidence.name
        && item.version === evidence.version
        && item.purl === evidence.purl);
      assert.ok(component, `Componente de código local Canvas ausente ou alterado na SBOM: ${evidence.name}@${evidence.version}.`);
      assert.equal((component.licenses || []).length, 0, `SBOM passou a declarar uma licença para ${evidence.name}; reavalie a evidência upstream e este mapeamento.`);
      return true;
    });
    canvasSbom = {
      version: canvasPackageInfo.version,
      specVersion: sbom.specVersion,
      componentCount: sbom.components.length,
      binarySha256: actualHash,
      componentsWithoutLicenseExpression: componentsWithoutLicenseExpression.length,
      registryLicenseMetadataVerified: registryLicenseMetadataVerified.map(({ name, version, license, checksum }) => ({ name, version, license, checksum })),
      localSourceProvenanceVerified: {
        canvasCommit: canvasLocalSourceEvidence.canvasCommit,
        skiaCommit: canvasLocalSourceEvidence.skiaCommit,
        components: localSourceComponentsVerified.map(({ name, version, sourceLicense }) => ({ name, version, sourceLicense }))
      },
      componentsStillMissingVerifiedRegistryLicense: componentsWithoutLicenseExpression
        .filter((component) => !registryLicenseMetadataVerified.some((evidence) => evidence.name === component.name && evidence.version === component.version))
        .map(({ name, version, purl }) => ({ name, version, purl }))
    };
  }
}

console.log(JSON.stringify({
  archivePath,
  productionPackageCount: productionPackages.length,
  packagedProductionPackageCount: packagedProductionPackages.length,
  packagesWithLocalLicenseFiles: coverage.filter((item) => item.standaloneLicense).length,
  packagesCoveredByCentralNotices: coverage.filter((item) => item.centralNotice).length,
  packagesNotPresentInThisPlatformBuild: productionPackages.length - packagedProductionPackages.length,
  canvasSbom,
  packagesWithoutStandaloneLicenseFile: coverage.filter((item) => !item.standaloneLicense),
  packagesWithoutAnyVerifiedNotice: missingNotices
}, null, 2));

if (process.env.CENTRAL_PDF_LICENSE_STRICT === '1') {
  assert.deepEqual(missingNotices, [], 'Há licenças de dependências de produção sem aviso verificável no pacote.');
}
