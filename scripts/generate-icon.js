const fs = require("fs");
const path = require("path");
const { app, BrowserWindow, nativeImage } = require("electron");

const ROOT = path.resolve(__dirname, "..");
const BUILD_DIR = path.join(ROOT, "build");
const LEGACY_ICON = path.join(BUILD_DIR, "icon-legacy.ico");
const CURRENT_ICON = path.join(BUILD_DIR, "icon.ico");
const V3_DIR = path.join(BUILD_DIR, "icon-v3");
const V3_ICO = path.join(BUILD_DIR, "icon-v3.ico");

const SIZES = [16, 24, 32, 48, 64, 128, 256];

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" fill="none">
  <rect x="48" y="22" width="144" height="212" rx="24" fill="#FDFEFE" stroke="#38567D" stroke-width="8"/>
  <path d="M146 22h25.4c5.84 0 11.44 2.32 15.58 6.46l20.56 20.56A22 22 0 0 1 214 64.58V85h-37.5c-16.84 0-30.5-13.66-30.5-30.5V22Z" fill="#D5E0EE" stroke="#38567D" stroke-width="8" stroke-linejoin="round"/>
  <path d="M80 105h88" stroke="#38567D" stroke-width="8" stroke-linecap="round"/>
  <path d="M80 129h88" stroke="#38567D" stroke-width="8" stroke-linecap="round"/>
  <path d="M80 153h48" stroke="#38567D" stroke-width="8" stroke-linecap="round"/>
  <path d="M48 170h144v40c0 13.25-10.75 24-24 24H72c-13.25 0-24-10.75-24-24v-40Z" fill="#173F72"/>
  <text x="120" y="214" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" font-size="40" font-weight="800" letter-spacing="1.5" fill="#FFFFFF">PDF</text>
</svg>`;

function ensureLegacyBackup() {
  if (fs.existsSync(CURRENT_ICON) && !fs.existsSync(LEGACY_ICON)) {
    fs.copyFileSync(CURRENT_ICON, LEGACY_ICON);
  }
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function svgToDataUrl(svg) {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function makeIcoFromPngBuffers(buffers, sizes) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(buffers.length, 4);

  const entries = [];
  let offset = 6 + buffers.length * 16;

  for (let i = 0; i < buffers.length; i += 1) {
    const size = sizes[i];
    const buf = buffers[i];
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size >= 256 ? 0 : size, 0);
    entry.writeUInt8(size >= 256 ? 0 : size, 1);
    entry.writeUInt8(0, 2);
    entry.writeUInt8(0, 3);
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(buf.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += buf.length;
    entries.push(entry);
  }

  return Buffer.concat([header, ...entries, ...buffers]);
}

async function renderSvgToPng(size) {
  const html = `<!DOCTYPE html><html><body style="margin:0;background:transparent;overflow:hidden;"><div style="width:${size}px;height:${size}px">${SVG}</div></body></html>`;
  const tempHtmlPath = path.join(V3_DIR, `render-${size}.html`);
  fs.writeFileSync(tempHtmlPath, html, "utf8");
  const win = new BrowserWindow({
    width: size,
    height: size,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    webPreferences: {
      offscreen: true
    }
  });

  await win.loadFile(tempHtmlPath);
  await new Promise((resolve) => setTimeout(resolve, 120));
  const image = await win.webContents.capturePage();
  win.destroy();
  fs.rmSync(tempHtmlPath, { force: true });
  return image.toPNG();
}

async function generate() {
  ensureLegacyBackup();
  ensureDir(V3_DIR);
  fs.writeFileSync(path.join(V3_DIR, "icon-v3.svg"), SVG, "utf8");

  const pngBuffers = [];
  const masterPng = await renderSvgToPng(256);
  fs.writeFileSync(path.join(V3_DIR, "icon-v3-256.png"), masterPng);
  const masterImage = nativeImage.createFromBuffer(masterPng);

  for (const size of SIZES) {
    const pngPath = path.join(V3_DIR, `icon-v3-${size}.png`);
    const png = size === 256
      ? masterPng
      : masterImage.resize({ width: size, height: size }).toPNG();
    fs.writeFileSync(pngPath, png);
    pngBuffers.push(png);
  }

  const icoBuffer = makeIcoFromPngBuffers(pngBuffers, SIZES);
  fs.writeFileSync(V3_ICO, icoBuffer);
  fs.writeFileSync(CURRENT_ICON, icoBuffer);
}

app.whenReady()
  .then(async () => {
    await generate();
    app.quit();
  })
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });
