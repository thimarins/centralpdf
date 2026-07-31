const fs = require('fs');
const path = require('path');
const { ROOT, toMarkdownTable, writeReport } = require('./_common');

async function runVisualAudit() {
  const html = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'index.html'), 'utf8');
  const cssRoot = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'style.css'), 'utf8');
  const cssPartialsDir = path.join(ROOT, 'src', 'renderer', 'styles');
  const cssPartials = fs.existsSync(cssPartialsDir)
    ? fs.readdirSync(cssPartialsDir).filter((file) => file.endsWith('.css')).map((file) => fs.readFileSync(path.join(cssPartialsDir, file), 'utf8')).join('\n')
    : '';
  const css = `${cssRoot}\n${cssPartials}`;
  const appJs = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'app.js'), 'utf8');
  const iconCatalog = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'ui', 'icons', 'fluent-icons.js'), 'utf8');
  const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

  const checks = [
    { name: 'Segoe UI Variable', ok: /Segoe UI Variable/i.test(css), details: 'tipografia do sistema' },
    { name: 'Fluent icon catalog', ok: (Boolean(packageJson.dependencies?.['@fluentui/react-icons']) || Boolean(packageJson.devDependencies?.['@fluentui/react-icons'])) && /Fluent|icon/i.test(iconCatalog), details: 'biblioteca oficial presente' },
    { name: 'Reduced motion guard', ok: /prefers-reduced-motion/.test(css), details: 'respeito a acessibilidade de animacao' },
    { name: 'Sidebar active state', ok: /nav-item\.active/.test(css), details: 'estado ativo estilizado' },
    { name: 'Title icons in pages', ok: /title-with-icon/.test(html), details: 'titulos principais com icones' },
    { name: 'Action buttons with icons', ok: /btn-icon-label/.test(html) && /btn-icon-label/.test(css), details: 'botoes principais acompanham icones' },
    { name: 'No emoji icons in renderer', ok: !/[\u{1F300}-\u{1FAFF}]/u.test(`${html}\n${css}\n${appJs}`), details: 'sem emojis decorativos' }
  ];

  const reportPath = writeReport('visual-audit.md', [
    '# Visual Audit Report',
    '',
    `Gerado em ${new Date().toISOString()}.`,
    '',
    ...toMarkdownTable(['Check', 'Status', 'Detalhes'], checks.map((item) => [item.name, item.ok ? 'ok' : 'warning', item.details])),
    '',
    'Observacao: esta auditoria e estatica e opcionalmente pode ser complementada por screenshots manuais antes de release.'
  ]);

  return {
    ok: checks.every((item) => item.ok),
    reportPath,
    checks
  };
}

if (require.main === module) {
  runVisualAudit()
    .then((summary) => {
      console.log(`Visual audit completed: ${summary.checks.length} checks`);
      process.exit(summary.ok ? 0 : 1);
    })
    .catch((error) => {
      console.error(error.stack || String(error));
      process.exit(1);
    });
}

module.exports = {
  runVisualAudit
};
