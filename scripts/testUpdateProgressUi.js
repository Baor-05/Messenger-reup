const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, ipcMain } = require('electron');

app.disableHardwareAcceleration();
app.setPath('userData', path.join(app.getPath('temp'), 'messenger-update-ui-test'));

const forceExitTimer = setTimeout(() => {
  console.error('Update progress UI test timed out.');
  process.exit(1);
}, 10000);

ipcMain.on('get-settings', (event) => {
  event.returnValue = {
    isDarkMode: true,
    alwaysOnTop: false,
    appLockEnabled: false,
    appLockHash: '',
    appLockTimeout: 5,
  };
});
ipcMain.on('get-lock-settings', (event) => {
  event.returnValue = {
    enabled: false,
    hash: '',
    timeout: 5,
  };
});

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    width: 1100,
    height: 760,
    show: false,
    webPreferences: {
      contextIsolation: false,
      nodeIntegration: true,
    },
  });

  try {
    await window.loadFile(path.join(__dirname, '..', 'index.html'));
    window.webContents.send('update-progress-state', {
      visible: true,
      phase: 'downloading',
      version: '1.1.4',
      releaseNotes: '- Dọn cache\n- Sleep profile nền',
      percent: 67,
      transferred: 70254592,
      total: 104857600,
      bytesPerSecond: 5242880,
    });

    await new Promise((resolve) => setTimeout(resolve, 250));

    const state = await window.webContents.executeJavaScript(`(() => {
      const overlay = document.getElementById('update-progress-overlay');
      const box = document.querySelector('.update-progress-box');
      const fill = document.getElementById('update-progress-fill');
      const left = document.getElementById('sidebar-left');
      const right = document.getElementById('sidebar-right');
      return {
        visible: overlay.classList.contains('visible'),
        heading: document.getElementById('update-progress-heading').textContent,
        status: document.getElementById('update-progress-status').textContent,
        detail: document.getElementById('update-progress-detail').textContent,
        percent: document.getElementById('update-progress-percent').textContent,
        fillWidth: fill.getBoundingClientRect().width,
        trackWidth: fill.parentElement.getBoundingClientRect().width,
        box: box.getBoundingClientRect().toJSON(),
        left: left.getBoundingClientRect().toJSON(),
        right: right.getBoundingClientRect().toJSON(),
        viewport: { width: innerWidth, height: innerHeight }
      };
    })()`);

    assert.strictEqual(state.visible, true);
    assert.strictEqual(state.heading, 'Đang cập nhật Messenger 1.1.4');
    assert.strictEqual(state.status, 'Đang tải bản cập nhật...');
    assert.strictEqual(state.percent, '67%');
    assert.ok(state.detail.includes('MB'));
    assert.ok(state.fillWidth > state.trackWidth * 0.6);
    assert.ok(state.fillWidth < state.trackWidth * 0.75);
    assert.ok(state.box.x >= state.left.width);
    assert.ok(state.box.x + state.box.width <= state.right.x);
    assert.ok(state.box.y >= 0);
    assert.ok(state.box.y + state.box.height <= state.viewport.height);

    const screenshotPath = path.join(app.getPath('temp'), 'messenger-update-progress-1.1.4.png');
    const screenshot = await window.webContents.capturePage();
    fs.writeFileSync(screenshotPath, screenshot.toPNG());

    console.log(`Update progress UI test passed: ${screenshotPath}`);
  } finally {
    if (!window.isDestroyed()) window.destroy();
  }
}).then(() => {
  clearTimeout(forceExitTimer);
  process.exit(0);
}).catch((error) => {
  clearTimeout(forceExitTimer);
  console.error(error);
  process.exit(1);
});
