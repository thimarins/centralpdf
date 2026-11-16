const { app, BrowserWindow } = require('electron');
const path = require('path');

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    width: 1400,
    height: 900,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  await win.loadFile(path.join(process.cwd(), 'src/renderer/index.html'));
  await new Promise(r => setTimeout(r, 800));

  for (const width of [1000, 1200, 1400, 1600, 1920]) {
    win.setSize(width, 900);
    await new Promise(r => setTimeout(r, 400));

    const res = await win.webContents.executeJavaScript(`(() => {
      document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
      const tabOrg = document.getElementById('tab-organize');
      tabOrg.classList.add('active');
      const ws = document.getElementById('organize-workspace');
      ws.classList.remove('hidden');

      // Select 1 page
      const toolbarActions = document.getElementById('organize-toolbar-actions');
      toolbarActions.dataset.selection = 'single';

      const cmdBar = document.querySelector('.organize-command-bar');
      const btns = Array.from(document.querySelectorAll('#organize-toolbar-actions button')).map(b => {
        const rect = b.getBoundingClientRect();
        return { id: b.id, left: Math.round(rect.left), right: Math.round(rect.right), width: Math.round(rect.width), top: Math.round(rect.top) };
      });

      const searchBox = document.querySelector('.organize-command-search');
      const searchRect = searchBox ? searchBox.getBoundingClientRect() : null;

      const overlaps = [];
      for (let i = 0; i < btns.length - 1; i++) {
        if (btns[i].right > btns[i + 1].left) {
          overlaps.push({
            btn1: btns[i].id,
            btn2: btns[i + 1].id,
            overlapPx: btns[i].right - btns[i + 1].left
          });
        }
      }

      const actionsRect = toolbarActions.getBoundingClientRect();
      let searchOverlap = 0;
      if (searchRect && actionsRect.right > searchRect.left) {
        searchOverlap = actionsRect.right - searchRect.left;
      }

      return {
        windowWidth: window.innerWidth,
        barMode: cmdBar.dataset.toolbarMode,
        barWidth: Math.round(cmdBar.getBoundingClientRect().width),
        actionsWidth: Math.round(actionsRect.width),
        searchLeft: searchRect ? Math.round(searchRect.left) : 0,
        actionsRight: Math.round(actionsRect.right),
        overlapsCount: overlaps.length,
        overlaps,
        searchOverlap
      };
    })()`);

    console.log('Result for width', width, ':', JSON.stringify(res, null, 2));
  }

  app.quit();
});
