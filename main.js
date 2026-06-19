// ============================================================
//  Messenger — Ứng dụng Messenger Desktop cho Windows
//  Nhân: Chromium (Google Chrome)
//  Desktop wrapper for Messenger
// ============================================================

const {
  app,
  BrowserWindow,
  BrowserView,
  shell,
  session,
  Menu,
  MenuItem,
  Tray,
  globalShortcut,
  ipcMain,
  nativeImage,
  nativeTheme,
  dialog,
  Notification,
} = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs');

// ============================================================
//  HỆ THỐNG DOWNLOAD
// ============================================================
let activeDownloads = new Map(); // id -> { item, filename, savePath, received, total }
let downloadCounter = 0;

// ============================================================
//  CẤU HÌNH CHUNG
// ============================================================
const MESSENGER_URL = 'https://www.facebook.com/messages';
const APP_NAME = 'Messenger';
const APP_ID = 'com.messenger.desktop';
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

// ============================================================
//  CHỐNG CHẠY TRÙNG LẶP (Single Instance Lock)
// ============================================================
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.exit(0);
  process.exit(0);
}

if (process.platform === 'win32') {
  app.setAppUserModelId(APP_ID);
}

app.on('second-instance', () => {
  showExistingInstance();
});

// ============================================================
//  HỆ THỐNG LƯU CÀI ĐẶT
// ============================================================
const SETTINGS_PATH = path.join(app.getPath('userData'), 'settings.json');

const DEFAULT_SETTINGS = {
  windowBounds: { width: 1200, height: 800 },
  startMinimized: false,
  autoLaunch: false,
  minimizeToTray: true,
  globalHotkey: 'Ctrl+Shift+M',
  currentTheme: 'default',
  isDarkMode: true,
  alwaysOnTop: false,
  blockSeen: false,
  blockTyping: false,
  appLockEnabled: false,
  appLockHash: '',
  appLockTimeout: 5,
};

function loadSettings() {
  try {
    const data = fs.readFileSync(SETTINGS_PATH, 'utf8');
    return { ...DEFAULT_SETTINGS, ...JSON.parse(data) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings(data) {
  try {
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {}
}

// ============================================================
//  BIẾN TOÀN CỤC
// ============================================================
let mainWindow = null;
let tray = null;
let settings = loadSettings();
let isQuitting = false;
let unreadCount = 0;
let profileUnreadCounts = {}; // { profileId: count }
let profileNames = {}; // { profileId: displayName }

let browserViews = {}; // { profileId: BrowserView }
let webContentsIntervals = new Map(); // webContents.id -> Set<Timeout>
let webContentsProfiles = new Map(); // webContents.id -> profileId
let profileNotificationStates = {}; // { profileId: { signature, timestamp } }
let activeProfileId = null;

// ============================================================
//  TẠO ICON BADGE
// ============================================================
function createBadgeIcon(count) {
  const size = 18;
  const text = count > 9 ? '9+' : String(count);
  const fontSize = count > 9 ? 9 : 11;

  const svg = `
    <svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
      <circle cx="${size / 2}" cy="${size / 2}" r="${size / 2}" fill="#e74c3c"/>
      <text x="${size / 2}" y="${size / 2 + fontSize / 3}"
            text-anchor="middle" fill="white"
            font-size="${fontSize}" font-weight="bold"
            font-family="Arial, sans-serif">${text}</text>
    </svg>`;

  return nativeImage.createFromDataURL(
    `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`
  );
}

// ============================================================
//  TẠO SYSTEM TRAY
// ============================================================
function createTray() {
  const iconPath = path.join(__dirname, 'icon.png');
  let trayIcon;
  try {
    trayIcon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
  } catch {
    trayIcon = nativeImage.createEmpty();
  }
  tray = new Tray(trayIcon);
  updateTrayMenu();
  tray.setToolTip(APP_NAME);

  tray.on('click', () => {
    if (!mainWindow) return;
    if (mainWindow.isVisible() && mainWindow.isFocused()) {
      mainWindow.hide();
    } else {
      showExistingInstance();
    }
  });

  tray.on('double-click', () => {
    if (!mainWindow) return;
    showExistingInstance();
  });
}

function updateTrayMenu() {
  if (!tray) return;
  const contextMenu = Menu.buildFromTemplate([
    { label: '💬 Mở Messenger', click: () => showExistingInstance() },
    { type: 'separator' },
    { label: '🔄 Tải lại trang', click: () => {
      if (activeProfileId && browserViews[activeProfileId]) {
        browserViews[activeProfileId].webContents.reload();
      }
    }},
    { label: '🚀 Khởi động cùng Windows', type: 'checkbox', checked: settings.autoLaunch, click: (item) => toggleAutoLaunch(item.checked) },
    { label: '📌 Thu nhỏ xuống Tray khi đóng', type: 'checkbox', checked: settings.minimizeToTray, click: (item) => { settings.minimizeToTray = item.checked; saveSettings(settings); } },
    { type: 'separator' },
    { label: '🛡️ Bảo mật', submenu: [
        { label: 'Chặn hiển thị "Đã xem"', type: 'checkbox', checked: settings.blockSeen, click: (item) => toggleBlockSeen(item.checked) },
        { label: 'Chặn hiển thị "Đang nhập"', type: 'checkbox', checked: settings.blockTyping, click: (item) => toggleBlockTyping(item.checked) }
    ]},
    { type: 'separator' },
    { label: '⬇️ Kiểm tra cập nhật', click: () => checkForUpdates(true) },
    { type: 'separator' },
    { label: '❌ Thoát hoàn toàn', click: () => quitAppCompletely() },
  ]);
  tray.setContextMenu(contextMenu);
}

function trackWebContentsInterval(contents, intervalId) {
  if (!contents || contents.isDestroyed()) {
    clearInterval(intervalId);
    return intervalId;
  }

  let intervals = webContentsIntervals.get(contents.id);
  if (!intervals) {
    intervals = new Set();
    webContentsIntervals.set(contents.id, intervals);
    contents.once('destroyed', () => clearWebContentsIntervals(contents.id));
  }

  intervals.add(intervalId);
  return intervalId;
}

function clearWebContentsIntervals(contentsOrId) {
  const contentsId = typeof contentsOrId === 'number' ? contentsOrId : contentsOrId && contentsOrId.id;
  if (!contentsId) return;

  const intervals = webContentsIntervals.get(contentsId);
  if (!intervals) return;

  intervals.forEach((intervalId) => clearInterval(intervalId));
  webContentsIntervals.delete(contentsId);
}

function destroyBrowserView(profileId) {
  const view = browserViews[profileId];
  if (!view) return;

  try {
    if (mainWindow && !mainWindow.isDestroyed() && mainWindow.getBrowserView() === view) {
      mainWindow.setBrowserView(null);
    }
  } catch {}

  try {
    if (view.webContents) {
      clearWebContentsIntervals(view.webContents);
      if (!view.webContents.isDestroyed()) {
        view.webContents.destroy();
      }
    }
  } catch {}

  delete browserViews[profileId];
}

function destroyAllBrowserViews() {
  Object.keys(browserViews).forEach((profileId) => destroyBrowserView(profileId));
  webContentsIntervals.forEach((intervals) => {
    intervals.forEach((intervalId) => clearInterval(intervalId));
  });
  webContentsIntervals.clear();
}

function saveWindowBounds() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    settings.windowBounds = mainWindow.getBounds();
    saveSettings(settings);
  } catch {}
}

function prepareForFullQuit() {
  isQuitting = true;
  saveWindowBounds();
  destroyAllBrowserViews();

  if (tray) {
    try {
      tray.destroy();
    } catch {}
    tray = null;
  }

  try {
    globalShortcut.unregisterAll();
  } catch {}
}

function quitAppCompletely() {
  prepareForFullQuit();

  if (mainWindow && !mainWindow.isDestroyed()) {
    try {
      mainWindow.removeAllListeners('close');
      mainWindow.destroy();
    } catch {}
  }

  setTimeout(() => app.exit(0), 1000).unref();
  app.quit();
}

function restoreMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  updateMessengerAwayMode();
}

function showExistingInstance() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  updateBrowserViewBounds();
  updateMessengerAwayMode();
}

function isMessengerAwayModeActive() {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  return !mainWindow.isVisible() || mainWindow.isMinimized();
}

function shouldNotifyUser() {
  return isMessengerAwayModeActive();
}

function playMessageSound() {
  try {
    shell.beep();
  } catch {}
}

function handleIncomingMessages(profileId, addedCount, messageInfo = null) {
  if (shouldNotifyUser()) {
    showMessageNotification(profileId, addedCount, messageInfo);
  } else {
    playMessageSound();
  }
}

function sendProfileBadge(profileId, count) {
  if (mainWindow && !mainWindow.isDestroyed() && profileId) {
    mainWindow.webContents.send('update-profile-badge', { id: profileId, count: count || 0 });
  }
}

function updateProfileUnreadCount(profileId, count, messageInfo = null) {
  if (!profileId || typeof count !== 'number' || Number.isNaN(count)) return;

  const normalizedCount = Math.max(0, count);
  const previousCount = profileUnreadCounts[profileId];
  if (shouldNotifyUser() && previousCount > 0 && normalizedCount === 0 && !messageInfo) {
    return;
  }

  if (typeof previousCount === 'number' && normalizedCount > previousCount) {
    const hasMessageInfo = !!(messageInfo && (messageInfo.sender || messageInfo.message));
    const previousNotification = profileNotificationStates[profileId];
    const hasRecentSpecificNotification = previousNotification && Date.now() - previousNotification.timestamp < 8000;
    if (hasMessageInfo || !hasRecentSpecificNotification) {
      handleIncomingMessages(profileId, normalizedCount - previousCount, messageInfo);
    }
  }

  profileUnreadCounts[profileId] = normalizedCount;
  sendProfileBadge(profileId, normalizedCount);
}

function parseUnreadCountFromTitle(title) {
  const match = String(title || '').match(/\((\d+)\)/);
  return match ? parseInt(match[1], 10) : null;
}

function normalizeNotificationText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function shouldSkipDuplicateNotification(profileId, sender, body) {
  const signature = `${normalizeNotificationText(sender)}|${normalizeNotificationText(body)}`;
  const now = Date.now();
  const previous = profileNotificationStates[profileId];
  if (previous && previous.signature === signature && now - previous.timestamp < 45000) {
    return true;
  }

  profileNotificationStates[profileId] = { signature, timestamp: now };
  return false;
}

function showMessageNotification(profileId, addedCount, messageInfo = null) {
  const isNotificationSupported = typeof Notification.isSupported !== 'function' || Notification.isSupported();
  if (!shouldNotifyUser() || !isNotificationSupported) return;

  const profileName = profileNames[profileId] || 'Messenger';
  const sender = normalizeNotificationText(messageInfo && messageInfo.sender ? messageInfo.sender : profileName);
  const message = normalizeNotificationText(messageInfo && messageInfo.message ? messageInfo.message : '');
  const countText = addedCount > 1 ? `${addedCount} tin nhắn mới` : 'Có tin nhắn mới';
  const body = message || countText;
  if (shouldSkipDuplicateNotification(profileId, sender, body)) return;

  const notification = new Notification({
    title: sender,
    body,
    icon: path.join(__dirname, 'icon.png'),
    silent: false,
  });

  notification.on('click', () => {
    restoreMainWindow();
    if (profileId && browserViews[profileId]) {
      activeProfileId = profileId;
      mainWindow.setBrowserView(browserViews[profileId]);
      updateBrowserViewBounds();
    }
  });

  notification.show();
}

function buildMessengerAwayScript(away) {
  return `
    (function() {
      if (!window.__messengerAwayPatchInstalled) {
        window.__messengerAwayPatchInstalled = true;
        window.__messengerAwayMode = false;
        var hiddenDescriptor = Object.getOwnPropertyDescriptor(Document.prototype, 'hidden');
        var visibilityDescriptor = Object.getOwnPropertyDescriptor(Document.prototype, 'visibilityState');
        var originalHasFocus = document.hasFocus ? document.hasFocus.bind(document) : function() { return true; };

        try {
          Object.defineProperty(Document.prototype, 'hidden', {
            configurable: true,
            get: function() {
              return window.__messengerAwayMode ? true : (hiddenDescriptor && hiddenDescriptor.get ? hiddenDescriptor.get.call(this) : false);
            }
          });
        } catch (e) {}

        try {
          Object.defineProperty(Document.prototype, 'visibilityState', {
            configurable: true,
            get: function() {
              return window.__messengerAwayMode ? 'hidden' : (visibilityDescriptor && visibilityDescriptor.get ? visibilityDescriptor.get.call(this) : 'visible');
            }
          });
        } catch (e) {}

        document.hasFocus = function() {
          return window.__messengerAwayMode ? false : originalHasFocus();
        };

        window.__messengerSetAwayMode = function(value) {
          var next = !!value;
          if (window.__messengerAwayMode === next) return;
          window.__messengerAwayMode = next;
          window.dispatchEvent(new Event(next ? 'blur' : 'focus'));
          document.dispatchEvent(new Event('visibilitychange'));
        };
      }

      window.__messengerSetAwayMode(${away ? 'true' : 'false'});
    })();
  `;
}

function setWebContentsAwayMode(contents, away) {
  if (!contents || contents.isDestroyed()) return;
  contents.executeJavaScript(buildMessengerAwayScript(away)).catch(() => {});
}

function setAllMessengerAwayMode(away) {
  Object.values(browserViews).forEach((view) => {
    if (view && view.webContents) {
      setWebContentsAwayMode(view.webContents, away);
    }
  });
}

function updateMessengerAwayMode() {
  setAllMessengerAwayMode(isMessengerAwayModeActive());
}

function buildMessengerNotificationBridgeScript() {
  return `
    (function() {
      if (window.__messengerNotificationBridgeInstalled || typeof window.Notification !== 'function') return;
      window.__messengerNotificationBridgeInstalled = true;

      var NativeNotification = window.Notification;

      function reportNotification(title, options) {
        var payload = {
          sender: String(title || ''),
          message: String((options && options.body) || ''),
          icon: String((options && options.icon) || '')
        };

        if (window.messengerApp && typeof window.messengerApp.reportWebNotification === 'function') {
          window.messengerApp.reportWebNotification(payload);
        }
      }

      function FakeNotification(title, options) {
        reportNotification(title, options || {});

        var target = new EventTarget();
        target.title = String(title || '');
        target.body = String((options && options.body) || '');
        target.icon = String((options && options.icon) || '');
        target.close = function() {
          setTimeout(function() {
            try { target.dispatchEvent(new Event('close')); } catch (e) {}
          }, 0);
        };

        setTimeout(function() {
          try { target.dispatchEvent(new Event('show')); } catch (e) {}
          if (typeof target.onshow === 'function') target.onshow(new Event('show'));
        }, 0);

        return target;
      }

      FakeNotification.requestPermission = function(callback) {
        var result;
        try {
          result = NativeNotification.requestPermission(callback);
        } catch (e) {
          result = Promise.resolve('granted');
          if (typeof callback === 'function') callback('granted');
        }
        return result;
      };

      Object.defineProperty(FakeNotification, 'permission', {
        configurable: true,
        get: function() {
          try { return NativeNotification.permission || 'granted'; } catch (e) { return 'granted'; }
        }
      });

      try {
        FakeNotification.prototype = NativeNotification.prototype;
      } catch (e) {}

      window.Notification = FakeNotification;
    })();
  `;
}

function installMessengerNotificationBridge(contents) {
  if (!contents || contents.isDestroyed()) return;
  contents.executeJavaScript(buildMessengerNotificationBridgeScript()).catch(() => {});
}

function buildMessengerUnreadObserverScript() {
  return `
    (function() {
      if (window.__messengerUnreadObserverInstalled) return;
      window.__messengerUnreadObserverInstalled = true;

      var lastSignature = '';
      var pendingTimer = null;

      function readUnreadCount() {
        var title = document.title || '';
        var titleMatch = title.match(/\\((\\d+)\\)/);
        if (titleMatch) return parseInt(titleMatch[1], 10);

        var selectors = [
          '[data-testid="MWJewelThreadListUnread"]',
          '[aria-label*="unread"]',
          '[aria-label*="chưa đọc"]',
          'span.pq6dq46d'
        ];

        var total = 0;
        selectors.forEach(function(selector) {
          document.querySelectorAll(selector).forEach(function(node) {
            var label = node.getAttribute('aria-label') || '';
            var text = node.textContent || '';
            var source = text || label;
            var match = source.match(/\\d+/);
            if (match) {
              var n = parseInt(match[0], 10);
              if (!isNaN(n)) total += n;
            }
          });
        });

        return total;
      }

      function cleanText(value) {
        return String(value || '').replace(/\\s+/g, ' ').trim();
      }

      function findThreadContainer(node) {
        var current = node;
        for (var i = 0; current && i < 8; i += 1) {
          var role = current.getAttribute && current.getAttribute('role');
          var aria = cleanText(current.getAttribute && current.getAttribute('aria-label'));
          var text = cleanText(current.innerText || current.textContent || '');
          if (
            role === 'row' ||
            role === 'link' ||
            role === 'listitem' ||
            (aria && text && text.length > 10)
          ) {
            return current;
          }
          current = current.parentElement;
        }
        return node;
      }

      function parseMessageInfoFromText(rawText) {
        var text = cleanText(rawText);
        if (!text) return null;

        var noise = [
          /^active now$/i,
          /^đang hoạt động$/i,
          /^sent$/i,
          /^đã gửi$/i,
          /^you:/i,
          /^bạn:/i
        ];

        var parts = text
          .split(/\\n| · | • |\\s{2,}/)
          .map(cleanText)
          .filter(function(part) {
            return part && !noise.some(function(pattern) { return pattern.test(part); });
          });

        if (parts.length === 0) return null;

        var sender = parts[0];
        var message = '';
        for (var i = 1; i < parts.length; i += 1) {
          if (parts[i] && parts[i] !== sender) {
            message = parts[i];
            break;
          }
        }

        if (!message && parts.length > 1) message = parts[parts.length - 1];
        if (!message || message === sender) return null;

        return {
          sender: sender.slice(0, 80),
          message: message.slice(0, 180)
        };
      }

      function readLastMessageInfo() {
        var selectors = [
          '[data-testid="MWJewelThreadListUnread"]',
          '[aria-label*="unread"]',
          '[aria-label*="chưa đọc"]',
          'span.pq6dq46d'
        ];

        for (var i = 0; i < selectors.length; i += 1) {
          var nodes = document.querySelectorAll(selectors[i]);
          for (var j = 0; j < nodes.length; j += 1) {
            var container = findThreadContainer(nodes[j]);
            var info = parseMessageInfoFromText(container && (container.innerText || container.textContent));
            if (info) return info;
          }
        }

        var rows = document.querySelectorAll('[role="row"], [role="listitem"], [role="link"]');
        for (var k = 0; k < Math.min(rows.length, 12); k += 1) {
          var rowText = rows[k].innerText || rows[k].textContent || '';
          if (/unread|chưa đọc|\\d+/.test(rowText.toLowerCase())) {
            var fallbackInfo = parseMessageInfoFromText(rowText);
            if (fallbackInfo) return fallbackInfo;
          }
        }

        return null;
      }

      function report(reason) {
        var count = readUnreadCount();
        var title = document.title || '';
        var messageInfo = readLastMessageInfo();
        var signature = reason + '|' + count + '|' + title + '|' + JSON.stringify(messageInfo || {});
        if (signature === lastSignature) return;
        lastSignature = signature;

        if (window.messengerApp && typeof window.messengerApp.reportUnreadSignal === 'function') {
          window.messengerApp.reportUnreadSignal({ reason: reason, count: count, title: title, messageInfo: messageInfo });
        }
      }

      function scheduleReport(reason) {
        clearTimeout(pendingTimer);
        pendingTimer = setTimeout(function() { report(reason); }, 120);
      }

      var titleElement = document.querySelector('title');
      if (titleElement) {
        new MutationObserver(function() { scheduleReport('title'); }).observe(titleElement, {
          childList: true,
          characterData: true,
          subtree: true
        });
      }

      new MutationObserver(function() { scheduleReport('dom'); }).observe(document.documentElement, {
        childList: true,
        characterData: true,
        subtree: true
      });

      setInterval(function() { report('fast-timer'); }, 1000);
      report('init');
    })();
  `;
}

function installMessengerUnreadObserver(contents) {
  if (!contents || contents.isDestroyed()) return;
  contents.executeJavaScript(buildMessengerUnreadObserverScript()).catch(() => {});
}

function toggleBlockSeen(enable) {
  settings.blockSeen = enable;
  saveSettings(settings);
}

function toggleBlockTyping(enable) {
  settings.blockTyping = enable;
  saveSettings(settings);
}

// ============================================================
//  AUTO UPDATER
// ============================================================
let isManualUpdateCheck = false;

function setupAutoUpdater() {
  autoUpdater.autoDownload = false;

  autoUpdater.on('before-quit-for-update', () => {
    prepareForFullQuit();
  });

  autoUpdater.on('update-available', (info) => {
    dialog.showMessageBox({
      type: 'info',
      title: 'Có bản cập nhật mới',
      message: `Đã có bản cập nhật mới v${info.version}. Bạn có muốn tải xuống và cài đặt không?`,
      buttons: ['Tải xuống', 'Bỏ qua']
    }).then(result => {
      if (result.response === 0) {
        autoUpdater.downloadUpdate();
      }
    });
  });

  autoUpdater.on('update-not-available', (info) => {
    if (isManualUpdateCheck) {
      dialog.showMessageBox({
        title: 'Không có cập nhật',
        message: 'Bạn đang sử dụng phiên bản mới nhất.'
      });
      isManualUpdateCheck = false;
    }
  });

  autoUpdater.on('update-downloaded', () => {
    dialog.showMessageBox({
      title: 'Đã tải xong cập nhật',
      message: 'Bản cập nhật đã được tải xuống. Ứng dụng sẽ khởi động lại để cài đặt.',
      buttons: ['Cài đặt và Khởi động lại']
    }).then(() => {
      prepareForFullQuit();
      autoUpdater.quitAndInstall();
      setTimeout(() => app.exit(0), 5000).unref();
    });
  });

  autoUpdater.on('error', (err) => {
    if (isManualUpdateCheck) {
      let errorMessage = err == null ? "Lỗi không xác định" : (err.stack || err).toString();
      if (errorMessage.includes('No published versions on GitHub') || errorMessage.includes('404 Not Found')) {
        dialog.showMessageBox({
          type: 'info',
          title: 'Thông tin cập nhật',
          message: 'Chưa có bản cập nhật nào được phát hành. Bạn đang sử dụng phiên bản mới nhất!'
        });
      } else {
        dialog.showErrorBox('Lỗi cập nhật', errorMessage);
      }
      isManualUpdateCheck = false;
    }
  });

  // Tự động kiểm tra cập nhật khi khởi động
  setTimeout(() => {
    autoUpdater.checkForUpdates();
  }, 5000);
}

function checkForUpdates(manual = false) {
  isManualUpdateCheck = manual;
  autoUpdater.checkForUpdates();
}

function toggleAutoLaunch(enable) {
  settings.autoLaunch = enable;
  saveSettings(settings);
  app.setLoginItemSettings({ openAtLogin: enable, path: app.getPath('exe') });
}

// ============================================================
//  QUẢN LÝ BROWSERVIEW
// ============================================================
function updateBrowserViewBounds() {
  if (!mainWindow || !activeProfileId || !browserViews[activeProfileId]) return;
  const bounds = mainWindow.getContentBounds();
  // Left sidebar: 52px, Right sidebar: 42px
  const LEFT_SIDEBAR = 52;
  const RIGHT_SIDEBAR = 42;
  browserViews[activeProfileId].setBounds({
    x: LEFT_SIDEBAR,
    y: 0,
    width: Math.max(bounds.width - LEFT_SIDEBAR - RIGHT_SIDEBAR, 0),
    height: Math.max(bounds.height, 0)
  });
}

function setupDownloadHandler(sess) {
  if (sess._downloadHandlerSet) return;
  sess._downloadHandlerSet = true;

  sess.on('will-download', (event, item, webContents) => {
    const id = ++downloadCounter;
    const filename = item.getFilename() || 'download';
    const downloadsPath = app.getPath('downloads');
    const savePath = path.join(downloadsPath, filename);
    item.setSavePath(savePath);

    const total = item.getTotalBytes();
    activeDownloads.set(id, { item, filename, savePath, received: 0, total });

    // Notify renderer about new download
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('download-started', {
        id, filename, savePath, total,
      });
    }

    item.on('updated', (event, state) => {
      const received = item.getReceivedBytes();
      const dl = activeDownloads.get(id);
      if (dl) dl.received = received;

      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('download-progress', {
          id, received, total: item.getTotalBytes(), state,
        });
      }
    });

    item.once('done', (event, state) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('download-done', {
          id, state, savePath, filename,
        });
      }
      activeDownloads.delete(id);
    });
  });
}

function isMessengerUrl(url) {
  if (!url) return false;
  if (url === 'about:blank' || url.startsWith('about:blank#')) return true;

  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    return (
      host === 'facebook.com' ||
      host.endsWith('.facebook.com') ||
      host === 'messenger.com' ||
      host.endsWith('.messenger.com') ||
      host === 'fbcdn.net' ||
      host.endsWith('.fbcdn.net')
    );
  } catch {
    return false;
  }
}

function isExternalWebUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function getMessengerPopupOptions(partition) {
  return {
    width: 1100,
    height: 760,
    minWidth: 420,
    minHeight: 520,
    title: APP_NAME,
    icon: path.join(__dirname, 'icon.png'),
    backgroundColor: settings.isDarkMode ? '#242526' : '#ffffff',
    autoHideMenuBar: true,
    webPreferences: {
      partition,
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  };
}

function setupWebContents(contents, profileId, partition, options = {}) {
  if (profileId) {
    webContentsProfiles.set(contents.id, profileId);
    contents.once('destroyed', () => webContentsProfiles.delete(contents.id));
  }

  // Setup download handler for this view's session
  setupDownloadHandler(contents.session);

  contents.setWindowOpenHandler(({ url }) => {
    if (isMessengerUrl(url)) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: getMessengerPopupOptions(partition),
      };
    }

    if (isExternalWebUrl(url)) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  contents.on('did-create-window', (childWindow) => {
    const childContents = childWindow.webContents;
    childContents.setUserAgent(USER_AGENT);
    setupWebContents(childContents, profileId, partition, { skipMessengerPolling: true });
  });

  contents.on('context-menu', (event, params) => {
    const menu = new Menu();
    if (params.misspelledWord) {
      for (const suggestion of params.dictionarySuggestions) {
        menu.append(new MenuItem({ label: suggestion, click: () => contents.replaceMisspelling(suggestion) }));
      }
      if (params.dictionarySuggestions.length > 0) menu.append(new MenuItem({ type: 'separator' }));
    }
    if (params.selectionText) menu.append(new MenuItem({ label: '📋 Sao chép', role: 'copy' }));
    if (params.isEditable) {
      menu.append(new MenuItem({ label: '📋 Dán', role: 'paste' }));
      menu.append(new MenuItem({ label: '✂️ Cắt', role: 'cut' }));
      menu.append(new MenuItem({ label: '📝 Chọn tất cả', role: 'selectAll' }));
    }
    if (params.linkURL) {
      menu.append(new MenuItem({ type: 'separator' }));
      menu.append(new MenuItem({ label: '🔗 Mở liên kết', click: () => shell.openExternal(params.linkURL) }));
      menu.append(new MenuItem({ label: '📋 Sao chép liên kết', click: () => require('electron').clipboard.writeText(params.linkURL) }));
    }
    if (params.mediaType === 'image') {
      menu.append(new MenuItem({ type: 'separator' }));
      menu.append(new MenuItem({ label: '💾 Lưu ảnh', click: () => contents.downloadURL(params.srcURL) }));
    }
    menu.append(new MenuItem({ type: 'separator' }));
    menu.append(new MenuItem({ label: '🔄 Tải lại trang', click: () => contents.reload() }));
    menu.append(new MenuItem({ label: '◀️ Quay lại', enabled: contents.canGoBack(), click: () => contents.goBack() }));
    if (menu.items.length > 0) menu.popup({ window: mainWindow });
  });

  contents.on('did-finish-load', async () => {
    const cssPath = path.join(__dirname, 'custom_style.css');
    try {
      const cssData = fs.readFileSync(cssPath, 'utf8');
      contents.insertCSS(cssData);
    } catch(e) {}
    setWebContentsAwayMode(contents, isMessengerAwayModeActive());
    installMessengerNotificationBridge(contents);
    installMessengerUnreadObserver(contents);
  });

  contents.on('page-title-updated', (event, title) => {
    const count = parseUnreadCountFromTitle(title);
    if (count !== null) {
      updateProfileUnreadCount(profileId, count);
    }
  });

  if (!options.skipMessengerPolling) {
  const avatarInterval = setInterval(async () => {
    if (contents.isDestroyed()) {
      clearInterval(avatarInterval);
      return;
    }
    try {
      const cookies = await contents.session.cookies.get({ name: 'c_user' });
      if (cookies && cookies.length > 0) {
        const uid = cookies[0].value;
        const fbAvatar = `https://graph.facebook.com/${uid}/picture?width=150&height=150`;
        if (mainWindow && profileId) {
          mainWindow.webContents.send('update-profile-avatar', { id: profileId, avatarUrl: fbAvatar });
        }
      }
    } catch(e) {}
  }, 5000);
  trackWebContentsInterval(contents, avatarInterval);

  // ── Unread badge per profile ──
  const unreadInterval = setInterval(async () => {
    if (contents.isDestroyed()) {
      clearInterval(unreadInterval);
      return;
    }
    try {
      const count = await contents.executeJavaScript(`
        (function() {
          var title = document.title || '';
          var match = title.match(/\\((\\d+)\\)/);
          if (match) return parseInt(match[1]);
          var badges = document.querySelectorAll('[data-testid="MWJewelThreadListUnread"], span.pq6dq46d');
          var total = 0;
          badges.forEach(function(b) {
            var n = parseInt(b.textContent);
            if (!isNaN(n)) total += n;
          });
          return total;
        })();
      `);
      updateProfileUnreadCount(profileId, count || 0);
    } catch(e) {}
  }, 1000);
  trackWebContentsInterval(contents, unreadInterval);
  }

  if (app.isPackaged) {
    contents.on('before-input-event', (event, input) => {
      if (input.key === 'F12' || (input.control && input.shift && input.key === 'I')) event.preventDefault();
    });
    contents.on('devtools-opened', () => contents.closeDevTools());
  } else {
    contents.on('before-input-event', (event, input) => {
      if (input.key === 'F12' || (input.control && input.shift && input.key === 'I')) contents.toggleDevTools();
    });
  }
}

// ============================================================
//  TẠO CỬA SỔ CHÍNH
// ============================================================
function createWindow() {
  const { windowBounds } = settings;

  mainWindow = new BrowserWindow({
    width: windowBounds.width || 1200,
    height: windowBounds.height || 800,
    x: windowBounds.x,
    y: windowBounds.y,
    minWidth: 400,
    minHeight: 300,
    title: APP_NAME,
    icon: path.join(__dirname, 'icon.png'),
    backgroundColor: settings.isDarkMode ? '#242526' : '#ffffff',
    show: !settings.startMinimized,
    autoHideMenuBar: true,
    titleBarOverlay: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      spellcheck: false,
    },
  });

  app.on('session-created', (sess) => {
    // Setup download handler on every new session
    setupDownloadHandler(sess);

    sess.webRequest.onBeforeRequest({ urls: ['*://*.facebook.com/*', '*://*.messenger.com/*'] }, (details, callback) => {
      let cancel = false;
      
      // Chặn Đã xem (Block Seen)
      if (settings.blockSeen || isMessengerAwayModeActive()) {
        if (details.url.includes('/change_read_status.php') || details.url.includes('/ajax/mercury/change_read_status.php')) {
          cancel = true;
        }
        if (details.uploadData && details.uploadData.length > 0) {
          const body = details.uploadData[0].bytes ? details.uploadData[0].bytes.toString() : '';
          if (body.includes('LSThreadMarkRead') || body.includes('markThreadRead') || body.includes('ThreadMarkReadMutation') || body.includes('"name":"mark_read"')) {
            cancel = true;
          }
        }
      }

      // Chặn Đang nhập (Block Typing)
      if (settings.blockTyping) {
        if (details.url.includes('/typ.php') || details.url.includes('/ajax/messaging/typ.php')) {
          cancel = true;
        }
        if (details.uploadData && details.uploadData.length > 0) {
          const body = details.uploadData[0].bytes ? details.uploadData[0].bytes.toString() : '';
          if (body.includes('TypingIndicator') || body.includes('LSTypingIndicator') || body.includes('typing_indicator')) {
            cancel = true;
          }
        }
      }

      callback({ cancel });
    });

    sess.setPermissionRequestHandler((webContents, permission, callback, details = {}) => {
      const currentUrl = webContents.getURL();
      const requestingUrl = details.requestingUrl || details.securityOrigin || details.embeddingOrigin || currentUrl;
      if (isMessengerUrl(currentUrl) || isMessengerUrl(requestingUrl)) {
        const allowedPermissions = [
          'notifications', 'media', 'mediaKeySystem', 'microphone', 
          'camera', 'clipboard-read', 'clipboard-sanitized-write',
        ];
        if (allowedPermissions.includes(permission)) {
          callback(true);
          return;
        }
      }
      callback(false);
    });

    sess.setPermissionCheckHandler((webContents, permission, requestingOrigin, details = {}) => {
      const currentUrl = webContents?.getURL() || '';
      const requestingUrl = requestingOrigin || details.requestingUrl || details.securityOrigin || details.embeddingOrigin || currentUrl;
      if (isMessengerUrl(currentUrl) || isMessengerUrl(requestingUrl)) {
        return true;
      }
      return false;
    });
  });

  mainWindow.loadFile('index.html');

  if (app.isPackaged) {
    mainWindow.webContents.on('before-input-event', (event, input) => {
      if (input.key === 'F12' || (input.control && input.shift && input.key === 'I')) event.preventDefault();
    });
    mainWindow.webContents.on('devtools-opened', () => mainWindow.webContents.closeDevTools());
  } else {
    mainWindow.webContents.on('before-input-event', (event, input) => {
      if (input.key === 'F12' || (input.control && input.shift && input.key === 'I')) mainWindow.webContents.toggleDevTools();
    });
  }

  mainWindow.on('focus', () => {
    mainWindow.flashFrame(false);
    updateMessengerAwayMode();
  });

  mainWindow.on('show', updateMessengerAwayMode);
  mainWindow.on('restore', updateMessengerAwayMode);
  mainWindow.on('minimize', updateMessengerAwayMode);
  mainWindow.on('hide', updateMessengerAwayMode);

  mainWindow.on('resize', updateBrowserViewBounds);
  mainWindow.on('maximize', updateBrowserViewBounds);
  mainWindow.on('unmaximize', updateBrowserViewBounds);

  mainWindow.on('close', (event) => {
    if (!isQuitting && settings.minimizeToTray) {
      event.preventDefault();
      mainWindow.hide();
      return;
    }
    settings.windowBounds = mainWindow.getBounds();
    saveSettings(settings);
  });

  // IPC
  ipcMain.on('switch-profile', (event, profile) => {
    activeProfileId = profile.id;
    profileNames[profile.id] = profile.name || 'Messenger';
    if (!browserViews[profile.id]) {
      const view = new BrowserView({
        webPreferences: {
          partition: profile.partition,
          preload: path.join(__dirname, 'preload.js'),
          contextIsolation: true,
          nodeIntegration: false,
        }
      });
      browserViews[profile.id] = view;
      setupWebContents(view.webContents, profile.id, profile.partition);
      view.webContents.loadURL(MESSENGER_URL, { userAgent: USER_AGENT });
    }
    mainWindow.setBrowserView(browserViews[profile.id]);
    updateBrowserViewBounds();
    updateMessengerAwayMode();
  });

  // ── Đăng xuất / Xóa session cho 1 profile ──
  ipcMain.on('logout-profile', async (event, profileData) => {
    const { id, partition } = profileData;
    if (profileData.name) profileNames[id] = profileData.name;
    try {
      // 1. Destroy BrowserView nếu đang tồn tại
      if (browserViews[id]) {
        destroyBrowserView(id);
      }

      // 2. Xóa sạch cookies + cache + storage của partition
      const sess = session.fromPartition(partition);
      await sess.clearStorageData({
        storages: ['cookies', 'localstorage', 'sessionstorage', 'cachestorage', 'indexdb', 'shadercache', 'websql', 'serviceworkers'],
      });
      await sess.clearCache();
      await sess.clearAuthCache();

      // 3. Tạo lại BrowserView mới với session sạch
      const view = new BrowserView({
        webPreferences: {
          partition: partition,
          preload: path.join(__dirname, 'preload.js'),
          contextIsolation: true,
          nodeIntegration: false,
        }
      });
      browserViews[id] = view;
      setupWebContents(view.webContents, id, partition);
      view.webContents.loadURL(MESSENGER_URL, { userAgent: USER_AGENT });

      // 4. Hiển thị lại
      if (activeProfileId === id) {
        mainWindow.setBrowserView(view);
        updateBrowserViewBounds();
        updateMessengerAwayMode();
      }

      event.reply('logout-profile-done', { id, success: true });
    } catch (err) {
      event.reply('logout-profile-done', { id, success: false, error: err.message });
    }
  });

  // ── Xóa session sạch khi tạo profile mới (đảm bảo không dùng lại cookie cũ) ──
  ipcMain.on('clear-new-profile-session', async (event, partition) => {
    try {
      const sess = session.fromPartition(partition);
      await sess.clearStorageData({
        storages: ['cookies', 'localstorage', 'sessionstorage', 'cachestorage', 'indexdb', 'shadercache', 'websql', 'serviceworkers'],
      });
      await sess.clearCache();
    } catch (err) {}
  });

  ipcMain.on('set-browserview-visibility', (event, visible) => {
    if (!mainWindow) return;
    if (visible && activeProfileId && browserViews[activeProfileId]) {
      mainWindow.setBrowserView(browserViews[activeProfileId]);
      updateBrowserViewBounds();
    } else {
      mainWindow.setBrowserView(null);
    }
  });

  ipcMain.on('delete-profile', (event, id) => {
    if (browserViews[id]) {
      destroyBrowserView(id);
    }
    delete profileUnreadCounts[id];
    delete profileNames[id];
  });

  ipcMain.on('update-badge', (event, count) => {
    if (count !== unreadCount) {
      const hadNewMessages = count > unreadCount;
      unreadCount = count;
      updateBadge(unreadCount);
      if (hadNewMessages && !mainWindow.isFocused()) {
        mainWindow.flashFrame(true);
      }
    }
  });

  ipcMain.on('messenger-unread-signal', (event, data = {}) => {
    const profileId = webContentsProfiles.get(event.sender.id);
    if (!profileId) return;

    let count = typeof data.count === 'number' ? data.count : null;
    if (count === null) {
      count = parseUnreadCountFromTitle(data.title);
    }
    if (typeof count === 'number' && !Number.isNaN(count)) {
      updateProfileUnreadCount(profileId, count, data.messageInfo || null);
    }
  });

  ipcMain.on('messenger-web-notification', (event, data = {}) => {
    const profileId = webContentsProfiles.get(event.sender.id);
    if (!profileId) return;

    const messageInfo = {
      sender: normalizeNotificationText(data.sender) || (profileNames[profileId] || 'Messenger'),
      message: normalizeNotificationText(data.message),
    };

    if (shouldNotifyUser()) {
      showMessageNotification(profileId, 1, messageInfo);
    } else {
      playMessageSound();
    }
  });

  ipcMain.on('set-theme', (event, isDark) => {
    settings.isDarkMode = isDark;
    saveSettings(settings);
    nativeTheme.themeSource = isDark ? 'dark' : 'light';
  });

  ipcMain.on('toggle-always-on-top', () => {
    settings.alwaysOnTop = !settings.alwaysOnTop;
    mainWindow.setAlwaysOnTop(settings.alwaysOnTop);
    saveSettings(settings);
  });

  ipcMain.on('toggle-fullscreen', () => {
    mainWindow.setFullScreen(!mainWindow.isFullScreen());
    setTimeout(updateBrowserViewBounds, 100);
  });

  ipcMain.on('zoom-in', () => {
    if (activeProfileId && browserViews[activeProfileId]) {
      const wc = browserViews[activeProfileId].webContents;
      wc.setZoomLevel(wc.getZoomLevel() + 0.5);
    }
  });

  ipcMain.on('zoom-out', () => {
    if (activeProfileId && browserViews[activeProfileId]) {
      const wc = browserViews[activeProfileId].webContents;
      wc.setZoomLevel(wc.getZoomLevel() - 0.5);
    }
  });

  ipcMain.on('reload-page', () => {
    if (activeProfileId && browserViews[activeProfileId]) {
      browserViews[activeProfileId].webContents.reload();
    }
  });

  ipcMain.on('go-home', () => {
    if (activeProfileId && browserViews[activeProfileId]) {
      browserViews[activeProfileId].webContents.loadURL(MESSENGER_URL, { userAgent: USER_AGENT });
    }
  });

  ipcMain.on('go-back', () => {
    if (activeProfileId && browserViews[activeProfileId]) {
      const wc = browserViews[activeProfileId].webContents;
      if (wc.canGoBack()) wc.goBack();
    }
  });

  ipcMain.on('get-settings', (event) => {
    event.returnValue = {
      isDarkMode: settings.isDarkMode,
      alwaysOnTop: settings.alwaysOnTop,
      appLockEnabled: settings.appLockEnabled,
      appLockHash: settings.appLockHash,
      appLockTimeout: settings.appLockTimeout,
    };
  });

  ipcMain.on('save-lock-settings', (event, data) => {
    if (data.enabled !== undefined) settings.appLockEnabled = data.enabled;
    if (data.hash !== undefined) settings.appLockHash = data.hash;
    if (data.timeout !== undefined) settings.appLockTimeout = data.timeout;
    saveSettings(settings);
  });

  ipcMain.on('get-lock-settings', (event) => {
    event.returnValue = {
      enabled: settings.appLockEnabled,
      hash: settings.appLockHash,
      timeout: settings.appLockTimeout,
    };
  });

  // ── Download IPC handlers ──
  ipcMain.on('open-download-file', (event, filePath) => {
    if (filePath && fs.existsSync(filePath)) {
      shell.openPath(filePath);
    }
  });

  ipcMain.on('open-download-folder', (event, filePath) => {
    if (filePath && fs.existsSync(filePath)) {
      shell.showItemInFolder(filePath);
    } else {
      shell.openPath(app.getPath('downloads'));
    }
  });

  ipcMain.on('cancel-download', (event, id) => {
    const dl = activeDownloads.get(id);
    if (dl && dl.item) {
      dl.item.cancel();
      activeDownloads.delete(id);
    }
  });
}

// ============================================================
//  CẬP NHẬT BADGE TRÊN TASKBAR & TRAY
// ============================================================
function updateBadge(count) {
  if (!mainWindow) return;
  if (process.platform === 'win32') {
    if (count > 0) {
      try {
        mainWindow.setOverlayIcon(createBadgeIcon(count), `${count} tin nhắn chưa đọc`);
      } catch {
        mainWindow.setOverlayIcon(null, '');
      }
    } else {
      mainWindow.setOverlayIcon(null, '');
    }
  }
  if (tray) {
    tray.setToolTip(count > 0 ? `${APP_NAME} — ${count} tin nhắn chưa đọc` : APP_NAME);
  }
}

// ============================================================
//  ĐĂNG KÝ PHÍM TẮT
// ============================================================
function registerGlobalShortcuts() {
  const hotkey = settings.globalHotkey || 'Ctrl+Shift+M';
  try {
    globalShortcut.register(hotkey, () => {
      if (!mainWindow) return;
      if (mainWindow.isVisible() && mainWindow.isFocused()) {
        mainWindow.hide();
      } else {
        showExistingInstance();
      }
    });
  } catch (err) {}
}

// ============================================================
//  KHỞI ĐỘNG ỨNG DỤNG
// ============================================================
app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  nativeTheme.themeSource = settings.isDarkMode ? 'dark' : 'light';
  createWindow();
  createTray();
  registerGlobalShortcuts();
  setupAutoUpdater();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// ============================================================
//  XỬ LÝ THOÁT
// ============================================================
app.on('before-quit', () => {
  prepareForFullQuit();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

