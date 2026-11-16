import { icons as LUCIDE_ICONS } from "lucide";

const ICON_ALIASES = Object.freeze({
  "chevronLeft": "ChevronLeft",
  "chevronRight": "ChevronRight",
  "chevronUp": "ChevronUp",
  "chevronDown": "ChevronDown",
  "cloud-upload": "CloudUpload",
  "upload-cloud": "CloudUpload",
  "document": "FileText",
  "file": "File",
  "file-check": "FileCheck",
  "file-image": "FileImage",
  "file-output": "FileOutput",
  "file-text": "FileText",
  "grid-2x2": "Grid2X2",
  "layout-dashboard": "LayoutDashboard",
  "layout-list": "List",
  "merge": "Merge",
  "remove": "X",
  "rows-3": "Rows3",
  "success": "CircleCheck",
  "warning": "TriangleAlert",
  "error": "CircleX",
  "trash": "Trash2",
  "undo": "Undo2",
  "unlock": "KeyRound",
  "weather-sunny": "Sun",
  "weather-moon": "Moon",
  "house": "House",
  "desktop": "Monitor",
  "security": "Shield",
  "queue": "List",
  "combine": "Merge",
  "app-mark": "Bookmark"
  , "scan-text": "ScanText"
  , "shield-check": "ShieldCheck"
  , "triangle-alert": "TriangleAlert"
});

function toPascalCase(name) {
  return String(name || "")
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

function escapeAttribute(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function resolveIcon(name) {
  const requested = String(name || "");
  const iconName = ICON_ALIASES[requested] || toPascalCase(requested);
  return LUCIDE_ICONS[iconName] || LUCIDE_ICONS.CircleHelp;
}

function buildSvg(iconNode, size = 20, className = "") {
  const children = iconNode.map(([tag, attributes = {}]) => {
    const attrs = Object.entries(attributes)
      .map(([key, value]) => `${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}="${escapeAttribute(value)}"`)
      .join(" ");
    return `<${tag}${attrs ? ` ${attrs}` : ""}></${tag}>`;
  }).join("");

  return `<svg class="lucide${className ? ` ${className}` : ""}" viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${children}</svg>`;
}

export function lucideIcon(name, options = {}) {
  const { size = 20, className = "" } = options;
  return buildSvg(resolveIcon(name), size, className);
}

export function lucideIconByState(name, options = {}) {
  const { size = 20, active = false, emphasize = false } = options;
  return lucideIcon(name, {
    size,
    className: active || emphasize ? "lucide-active" : ""
  });
}

export function lucideToneIcon(tone, size = 20) {
  return lucideIcon({ success: "success", warning: "warning", error: "error", info: "info" }[tone] || "info", { size });
}

export { ICON_ALIASES };
