const os = require('os');
const packageInfo = require('../../package.json');

const releaseVersion = String(packageInfo.releaseVersion || packageInfo.version || '0.0.0');
const packageVersion = String(packageInfo.version || '0.0.0');
const buildLabel = String(packageInfo.buildLabel || 'local');

function getFriendlyUsername() {
  try {
    const raw = os.userInfo().username || process.env.USERNAME || 'Usuário';
    return raw
      .split(/[\._\s]/)
      .filter(Boolean)
      .map(part => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
      .join(' ');
  } catch (e) {
    return 'Usuário';
  }
}

const APP_META = {
  productName: 'Central PDF',
  releaseVersion,
  packageVersion,
  versionLabel: `v${releaseVersion}`,
  buildLabel,
  currentUser: getFriendlyUsername()
};

module.exports = {
  APP_META
};
