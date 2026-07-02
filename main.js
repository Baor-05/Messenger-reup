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
} = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs');
const {
  buildPrivacyPatchScript,
  buildPrivacyWorkerPatchScript,
  extractMessengerRequestInfo,
  registerPrivacyScriptForNewDocuments,
  shouldBlockMessengerRequest,
  shouldBlockMessengerWebSocketSend,
  shouldUseMessengerAwayMode,
} = require('./privacy');

// ============================================================
//  HỆ THỐNG DOWNLOAD
// ============================================================
let activeDownloads = new Map(); // id -> { item, filename, savePath, received, total }
let completedDownloadPaths = new Set();
let downloadCounter = 0;

// ============================================================
//  CẤU HÌNH CHUNG
// ============================================================
const MESSENGER_URL = 'https://www.facebook.com/messages';
const APP_NAME = 'Messenger';
const APP_ID = 'com.messenger.desktop';
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.6261.156 Safari/537.36';

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
  sleepBackgroundProfiles: true,
  backgroundSleepMinutes: 10,
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
let profilePartitions = {}; // { profileId: partition }

let browserViews = {}; // { profileId: BrowserView }
let webContentsIntervals = new Map(); // webContents.id -> Set<Timeout>
let webContentsProfiles = new Map(); // webContents.id -> profileId
let privacyScriptIdentifiers = new Map(); // webContents.id -> CDP script identifier
let activeProfileId = null;
let profileSleepTimers = new Map();
let updateTrayState = {
  available: false,
  downloaded: false,
  version: '',
  releaseNotes: '',
  error: '',
};

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
  const updateLabel = updateTrayState.downloaded
    ? `Cài bản cập nhật v${updateTrayState.version}`
    : (updateTrayState.available
      ? `Tải bản cập nhật v${updateTrayState.version}`
      : 'Kiểm tra cập nhật');
  const contextMenu = Menu.buildFromTemplate([
    { label: 'Mở Messenger', click: () => showExistingInstance() },
    { label: `Phiên bản hiện tại: ${app.getVersion()}`, enabled: false },
    updateTrayState.available || updateTrayState.downloaded
      ? { label: `Có bản mới: v${updateTrayState.version}`, enabled: false }
      : { label: 'Chưa có thông tin cập nhật mới', enabled: false },
    { type: 'separator' },
    { label: 'Tải lại trang', click: () => {
      if (activeProfileId && browserViews[activeProfileId]) {
        browserViews[activeProfileId].webContents.reload();
      }
    }},
    { label: 'Khởi động cùng Windows', type: 'checkbox', checked: settings.autoLaunch, click: (item) => toggleAutoLaunch(item.checked) },
    { label: 'Thu nhỏ xuống Tray khi đóng', type: 'checkbox', checked: settings.minimizeToTray, click: (item) => { settings.minimizeToTray = item.checked; saveSettings(settings); } },
    { label: 'Sleep profile nền để giảm RAM', type: 'checkbox', checked: !!settings.sleepBackgroundProfiles, click: (item) => toggleBackgroundProfileSleep(item.checked) },
    { label: 'Dọn cache', submenu: [
        { label: 'Chỉ dọn cache', click: () => clearAppCache(false) },
        { label: 'Dọn cache và đăng xuất tất cả', click: () => clearAppCache(true) },
    ]},
    { type: 'separator' },
    { label: 'Bảo mật', submenu: [
        { label: 'Chặn hiển thị "Đã xem"', type: 'checkbox', checked: settings.blockSeen, click: (item) => toggleBlockSeen(item.checked) },
        { label: 'Chặn hiển thị "Đang nhập"', type: 'checkbox', checked: settings.blockTyping, click: (item) => toggleBlockTyping(item.checked) }
    ]},
    { type: 'separator' },
    { label: updateLabel, click: () => {
      if (updateTrayState.downloaded) installDownloadedUpdate();
      else if (updateTrayState.available) startUpdateDownload();
      else checkForUpdates(true);
    }},
    { type: 'separator' },
    { label: 'Thoát hoàn toàn', click: () => quitAppCompletely() },
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
  profileSleepTimers.forEach((timerId) => clearTimeout(timerId));
  profileSleepTimers.clear();
}

function getKnownProfilePartitions() {
  const partitions = new Set(Object.values(profilePartitions).filter(Boolean));
  Object.values(browserViews).forEach((view) => {
    const partition = view?.webContents?.session?.getPartition?.();
    if (partition) partitions.add(partition);
  });
  return [...partitions];
}

async function clearAppCache(clearSessionData = false) {
  const title = clearSessionData ? 'Dọn cache và đăng xuất tất cả' : 'Dọn cache';
  const message = clearSessionData
    ? 'Thao tác này sẽ xóa cache, cookies và session của tất cả tài khoản. Bạn sẽ cần đăng nhập lại.'
    : 'Thao tác này chỉ xóa cache tạm để giảm dung lượng và xử lý lỗi tải trang. Tài khoản vẫn được giữ đăng nhập.';

  const result = await dialog.showMessageBox({
    type: clearSessionData ? 'warning' : 'question',
    title,
    message,
    buttons: [clearSessionData ? 'Xóa và đăng xuất' : 'Dọn cache', 'Hủy'],
    defaultId: 0,
    cancelId: 1,
  });
  if (result.response !== 0) return;

  const partitions = getKnownProfilePartitions();
  try {
    const sessions = [session.defaultSession, ...partitions.map((partition) => session.fromPartition(partition))];
    await Promise.all(sessions.map(async (sess) => {
      await sess.clearCache();
      if (clearSessionData) {
        await sess.clearStorageData({
          storages: ['cookies', 'localstorage', 'sessionstorage', 'cachestorage', 'indexdb', 'shadercache', 'websql', 'serviceworkers'],
        });
        await sess.clearAuthCache();
      }
    }));

    if (clearSessionData) {
      destroyAllBrowserViews();
      profileUnreadCounts = {};
      unreadCount = 0;
      updateBadge(0);
      const activePartition = activeProfileId && profilePartitions[activeProfileId];
      if (activePartition && mainWindow && !mainWindow.isDestroyed()) {
        const view = new BrowserView({
          webPreferences: {
            partition: activePartition,
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
          },
        });
        browserViews[activeProfileId] = view;
        await setupWebContents(view.webContents, activeProfileId, activePartition);
        await view.webContents.loadURL(MESSENGER_URL, { userAgent: USER_AGENT });
        mainWindow.setBrowserView(view);
        updateBrowserViewBounds();
        updateMessengerAwayMode();
      }
    } else {
      Object.values(browserViews).forEach((view) => {
        if (view?.webContents && !view.webContents.isDestroyed()) view.webContents.reloadIgnoringCache();
      });
    }

    dialog.showMessageBox({
      type: 'info',
      title: 'Hoàn tất',
      message: clearSessionData ? 'Đã xóa cache và session.' : 'Đã dọn cache.',
    });
  } catch (error) {
    dialog.showErrorBox('Không thể dọn cache', error?.message || String(error));
  }
}

function clearProfileSleepTimer(profileId) {
  const timerId = profileSleepTimers.get(profileId);
  if (timerId) clearTimeout(timerId);
  profileSleepTimers.delete(profileId);
}

function scheduleProfileSleep(profileId) {
  clearProfileSleepTimer(profileId);
  if (!settings.sleepBackgroundProfiles || !profileId || profileId === activeProfileId || !browserViews[profileId]) return;

  const minutes = Math.max(1, Number(settings.backgroundSleepMinutes || 10));
  const timerId = setTimeout(() => {
    if (settings.sleepBackgroundProfiles && profileId !== activeProfileId && browserViews[profileId]) {
      destroyBrowserView(profileId);
    }
    profileSleepTimers.delete(profileId);
  }, minutes * 60 * 1000);
  timerId.unref?.();
  profileSleepTimers.set(profileId, timerId);
}

function toggleBackgroundProfileSleep(enable) {
  settings.sleepBackgroundProfiles = !!enable;
  saveSettings(settings);
  if (!enable) {
    profileSleepTimers.forEach((timerId) => clearTimeout(timerId));
    profileSleepTimers.clear();
  } else {
    Object.keys(browserViews).forEach((profileId) => scheduleProfileSleep(profileId));
  }
  updateTrayMenu();
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

function sendProfileBadge(profileId, count) {
  if (mainWindow && !mainWindow.isDestroyed() && profileId) {
    mainWindow.webContents.send('update-profile-badge', { id: profileId, count: count || 0 });
  }
}

function updateProfileUnreadCount(profileId, count, messageInfo = null) {
  if (!profileId || typeof count !== 'number' || Number.isNaN(count)) return;

  const normalizedCount = Math.max(0, count);
  const previousCount = profileUnreadCounts[profileId];
  if (isMessengerAwayModeActive() && previousCount > 0 && normalizedCount === 0 && !messageInfo) {
    return;
  }

  profileUnreadCounts[profileId] = normalizedCount;
  sendProfileBadge(profileId, normalizedCount);
}

function parseUnreadCountFromTitle(title) {
  const match = String(title || '').match(/\((\d+)\)/);
  return match ? parseInt(match[1], 10) : null;
}

function updateMessengerAwayMode() {
  updatePagePrivacyProtection();
}

function buildMessengerProfileAvatarScript() {
  return `
    (function() {
      function normalizeUrl(url) {
        if (!url) return null;
        try {
          return new URL(url, location.href).href;
        } catch (e) {
          return null;
        }
      }

      function isAvatarUrl(url) {
        return !!url && (
          url.includes('scontent') ||
          url.includes('fbcdn') ||
          url.includes('platform-lookaside') ||
          url.includes('graph.facebook.com')
        );
      }

      function imageFromElement(element) {
        if (!element) return null;

        var img = element.querySelector && element.querySelector('img[src]');
        var src = normalizeUrl(img && img.getAttribute('src'));
        if (isAvatarUrl(src)) return src;

        var image = element.querySelector && element.querySelector('svg image');
        var href = image && (image.getAttribute('xlink:href') || image.getAttribute('href'));
        href = normalizeUrl(href);
        if (isAvatarUrl(href)) return href;

        var nodes = element.querySelectorAll ? element.querySelectorAll('[style*="background-image"]') : [];
        for (var i = 0; i < nodes.length; i += 1) {
          var style = nodes[i].getAttribute('style') || '';
          var match = style.match(/url\\(["']?([^"')]+)["']?\\)/);
          var bg = normalizeUrl(match && match[1]);
          if (isAvatarUrl(bg)) return bg;
        }

        return null;
      }

      var candidates = [
        'a[href*="/me/"]',
        'a[aria-label*="profile" i]',
        'a[aria-label*="trang cá nhân" i]',
        'div[aria-label*="account" i]',
        'div[aria-label*="tài khoản" i]',
        'div[role="button"][aria-label*="profile" i]',
        'div[role="button"][aria-label*="tài khoản" i]',
        '[data-testid*="profile"]',
        '[data-testid*="Profile"]'
      ];

      for (var c = 0; c < candidates.length; c += 1) {
        var elements = document.querySelectorAll(candidates[c]);
        for (var j = 0; j < elements.length; j += 1) {
          var found = imageFromElement(elements[j]);
          if (found) return found;
        }
      }

      var nav = document.querySelector('[role="navigation"]');
      if (nav) {
        var navButtons = nav.querySelectorAll('a, div[role="button"]');
        for (var n = 0; n < Math.min(navButtons.length, 8); n += 1) {
          var navImage = imageFromElement(navButtons[n]);
          if (navImage) return navImage;
        }
      }

      return null;
    })();
  `;
}

async function getFacebookUserId(contents) {
  try {
    const cookies = await contents.session.cookies.get({ name: 'c_user' });
    return cookies && cookies.length > 0 ? cookies[0].value : null;
  } catch {
    return null;
  }
}

async function resolveProfileAvatar(contents) {
  const uid = await getFacebookUserId(contents);

  try {
    const domAvatar = await contents.executeJavaScript(buildMessengerProfileAvatarScript());
    if (domAvatar) return domAvatar;
  } catch {}

  if (uid) {
    return `https://graph.facebook.com/${uid}/picture?type=large&redirect=true`;
  }

  return null;
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

const privacyRequestSessions = new WeakSet();

function getPrivacySettings() {
  return {
    blockSeen: settings.blockSeen || isMessengerAwayModeActive(),
    blockTyping: settings.blockTyping,
  };
}

const PRIVACY_DEBUG_LOG = path.join(app.getPath('userData'), 'privacy-debug.log');
let privacyDebugStream = null;

function getPrivacyDebugStream() {
  if (!privacyDebugStream) {
    try {
      privacyDebugStream = fs.createWriteStream(PRIVACY_DEBUG_LOG, { flags: 'w' });
    } catch { return null; }
  }
  return privacyDebugStream;
}

function privacyDebugLog(msg) {
  const stream = getPrivacyDebugStream();
  if (stream) stream.write(`[${new Date().toISOString()}] ${msg}\n`);
}

function setupPrivacyRequestBlocker(sess) {
  if (!sess || privacyRequestSessions.has(sess)) return;
  privacyRequestSessions.add(sess);

  privacyDebugLog('=== Privacy request blocker installed ===');

  sess.webRequest.onBeforeRequest(
    { urls: ['*://*.facebook.com/*', '*://*.messenger.com/*'] },
    (details, callback) => {
      const body = (details.uploadData || [])
        .map((part) => {
          if (part.bytes) return part.bytes.toString('utf8');
          if (part.blobUUID) return `[blobUUID:${part.blobUUID}]`;
          return '';
        })
        .join('');

      const privSettings = getPrivacySettings();
      const shouldBlock = shouldBlockMessengerRequest(details.url, body, privSettings);
      const debugInfo = extractMessengerRequestInfo(details.url, body, privSettings);

      // Log các request có chứa keyword liên quan đến read/typing/seen
      const lowerUrl = details.url.toLowerCase();
      const lowerBody = body.toLowerCase();
      const isInteresting = lowerBody.includes('mark') || lowerBody.includes('read')
        || lowerBody.includes('seen') || lowerBody.includes('typing')
        || lowerBody.includes('indicator') || lowerUrl.includes('typ')
        || lowerUrl.includes('mark') || lowerUrl.includes('read');

      if (debugInfo.isInteresting || isInteresting || shouldBlock) {
        let parsedFriendlyName = 'N/A';
        let parsedDocId = 'N/A';
        try {
          const params = new URLSearchParams(body);
          if (params.has('fb_api_req_friendly_name')) {
            parsedFriendlyName = params.get('fb_api_req_friendly_name');
          }
          if (params.has('doc_id')) {
            parsedDocId = params.get('doc_id');
          }
        } catch (e) {}

        privacyDebugLog(
          `[${shouldBlock ? 'BLOCKED' : 'ALLOWED'}] URL=${details.url.substring(0, 150)}\n` +
          `  Settings: blockSeen=${privSettings.blockSeen} blockTyping=${privSettings.blockTyping}\n` +
          `  Method: ${details.method || '?'}\n` +
          `  FriendlyName: ${debugInfo.friendlyName || parsedFriendlyName} | DocId: ${debugInfo.docId || parsedDocId}\n` +
          `  BodyLength: ${debugInfo.textLength}\n` +
          `  BodyPreview: ${debugInfo.sanitizedPreview}\n` +
          `  UploadData parts: ${(details.uploadData || []).length}\n`
        );
      }

      callback({ cancel: shouldBlock });
    },
  );
}

function buildTrayTooltip() {
  const unreadPart = unreadCount > 0 ? ` — ${unreadCount} tin nhắn chưa đọc` : '';
  const updatePart = updateTrayState.downloaded
    ? ` — bản v${updateTrayState.version} đã tải xong`
    : (updateTrayState.available ? ` — có bản mới v${updateTrayState.version}` : '');
  return `${APP_NAME}${unreadPart}${updatePart}`;
}

const privacyNetworkDebuggerContents = new Set();
const privacyWebSocketUrls = new Map();
const privacyWorkerSessionsByContents = new Map();
let privacyWebSocketSampleCount = 0;
const MAX_PRIVACY_WEBSOCKET_SAMPLES = 160;

function decodeCdpWebSocketPayload(frame = {}) {
  const payloadData = frame.payloadData || '';
  if (frame.opcode === 2) {
    try {
      return Buffer.from(payloadData, 'base64');
    } catch {
      return payloadData;
    }
  }
  return payloadData;
}

function isPrivacyHostUrl(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === 'facebook.com' || host.endsWith('.facebook.com')
      || host === 'messenger.com' || host.endsWith('.messenger.com');
  } catch {
    return false;
  }
}

async function setupPrivacyNetworkDebugger(contents) {
  if (!contents || contents.isDestroyed() || privacyNetworkDebuggerContents.has(contents.id)) return;

  const debuggerApi = contents.debugger;
  const workerSessions = new Set();
  privacyWorkerSessionsByContents.set(contents.id, workerSessions);
  privacyNetworkDebuggerContents.add(contents.id);

  const cleanup = () => {
    privacyNetworkDebuggerContents.delete(contents.id);
    privacyWorkerSessionsByContents.delete(contents.id);
    try {
      debuggerApi.removeListener('message', onDebuggerMessage);
    } catch {}
  };

  const installWorkerPrivacyPatch = async (sessionId, targetInfo = {}) => {
    if (!sessionId) return;
    try {
      workerSessions.add(sessionId);
      await debuggerApi.sendCommand('Runtime.enable', {}, sessionId);
      await debuggerApi.sendCommand('Runtime.evaluate', {
        expression: buildPrivacyWorkerPatchScript(getPrivacySettings()),
      }, sessionId);
      privacyDebugLog(`[CDP] Worker privacy patch installed type=${targetInfo.type || '?'} session=${sessionId}`);
    } catch (err) {
      privacyDebugLog(`[CDP ERROR] Failed to install worker privacy patch: ${err.message}`);
    } finally {
      try {
        await debuggerApi.sendCommand('Runtime.runIfWaitingForDebugger', {}, sessionId);
      } catch {}
    }
  };

  const writeCdpHttpLog = (request, payload, privacySettings) => {
    const debugInfo = extractMessengerRequestInfo(request.url, payload, privacySettings);
    const isGraphql = String(request.url).toLowerCase().includes('/api/graphql');
    if (!debugInfo.isInteresting && !debugInfo.shouldBlock && !isGraphql) return;

    privacyDebugLog(
      `[CDP HTTP ${debugInfo.shouldBlock ? 'MATCH_BLOCK_RULE' : 'OBSERVED'}] URL=${String(request.url).substring(0, 180)}\n` +
      `  Settings: blockSeen=${privacySettings.blockSeen} blockTyping=${privacySettings.blockTyping}\n` +
      `  Method: ${request.method || '?'} | HasPostData: ${request.hasPostData ? 'yes' : 'no'} | BodyLength: ${debugInfo.textLength}\n` +
      `  FriendlyName: ${debugInfo.friendlyName || 'N/A'} | DocId: ${debugInfo.docId || 'N/A'}\n` +
      `  BodyPreview: ${debugInfo.sanitizedPreview}\n`
    );
  };

  const onDebuggerMessage = (event, method, params = {}, sessionId = '') => {
    const privacySettings = getPrivacySettings();

    if (method === 'Target.attachedToTarget') {
      const type = params.targetInfo?.type || '';
      if (type.includes('worker')) {
        installWorkerPrivacyPatch(params.sessionId, params.targetInfo);
      } else if (params.sessionId) {
        debuggerApi.sendCommand('Runtime.runIfWaitingForDebugger', {}, params.sessionId).catch(() => {});
      }
      return;
    }

    if (method === 'Target.detachedFromTarget') {
      if (params.sessionId) workerSessions.delete(params.sessionId);
      return;
    }

    if (method === 'Network.webSocketCreated') {
      if (params.requestId && params.url) privacyWebSocketUrls.set(params.requestId, params.url);
      return;
    }

    if (method === 'Network.webSocketClosed') {
      if (params.requestId) privacyWebSocketUrls.delete(params.requestId);
      return;
    }

    if (method === 'Network.webSocketFrameSent') {
      const url = privacyWebSocketUrls.get(params.requestId) || 'wss://unknown';
      const payload = decodeCdpWebSocketPayload(params.response);
      const debugInfo = extractMessengerRequestInfo(url, payload, privacySettings);
      const wsShouldBlock = shouldBlockMessengerWebSocketSend(url, payload, privacySettings);
      const shouldSample = (privacySettings.blockSeen || privacySettings.blockTyping)
        && privacyWebSocketSampleCount < MAX_PRIVACY_WEBSOCKET_SAMPLES;

      if (debugInfo.isInteresting || wsShouldBlock || shouldSample) {
        privacyWebSocketSampleCount += 1;
        privacyDebugLog(
          `[CDP WS ${wsShouldBlock ? 'MATCH_WS_BLOCK_RULE' : 'SENT'}] URL=${String(url).substring(0, 180)}\n` +
          `  Settings: blockSeen=${privacySettings.blockSeen} blockTyping=${privacySettings.blockTyping}\n` +
          `  Opcode: ${params.response?.opcode ?? '?'} | Mask: ${params.response?.mask ?? '?'} | Length: ${debugInfo.textLength}\n` +
          `  FriendlyName: ${debugInfo.friendlyName || 'N/A'} | DocId: ${debugInfo.docId || 'N/A'}\n` +
          `  PayloadPreview: ${debugInfo.sanitizedPreview}\n`
        );
      }
      return;
    }

    if (method !== 'Network.requestWillBeSent') return;

    const request = params.request || {};
    if (!request.url || !isPrivacyHostUrl(request.url)) return;
    if (request.method && request.method !== 'POST') return;

    if (!request.postData && request.hasPostData && params.requestId) {
      debuggerApi.sendCommand('Network.getRequestPostData', { requestId: params.requestId })
        .then((result) => writeCdpHttpLog(request, result?.postData || '', privacySettings))
        .catch(() => writeCdpHttpLog(request, '', privacySettings));
      return;
    }

    writeCdpHttpLog(request, request.postData || '', privacySettings);
  };

  try {
    debuggerApi.on('message', onDebuggerMessage);
    contents.once('destroyed', cleanup);
    await debuggerApi.sendCommand('Network.enable');
    privacyDebugLog(`[CDP] Network probe installed for contents.id=${contents.id}`);
  } catch (err) {
    cleanup();
    privacyDebugLog(`[CDP ERROR] Failed to install network probe: ${err.message}`);
  }
}

function updateWorkerPrivacyProtection(contents, privacySettings) {
  if (!contents || contents.isDestroyed()) return;
  const workerSessions = privacyWorkerSessionsByContents.get(contents.id);
  if (!workerSessions || workerSessions.size === 0) return;

  workerSessions.forEach((sessionId) => {
    contents.debugger.sendCommand('Runtime.evaluate', {
      expression: buildPrivacyWorkerPatchScript(privacySettings),
    }, sessionId).catch((err) => {
      privacyDebugLog(`[CDP ERROR] Failed to update worker privacy settings: ${err.message}`);
    });
  });
}

function updatePagePrivacyProtection() {
  const privacySettings = getPrivacySettings();
  Object.values(browserViews).forEach((view) => {
    const contents = view?.webContents;
    if (!contents || contents.isDestroyed()) return;
    registerPrivacyScript(contents, privacySettings);
    updateWorkerPrivacyProtection(contents, privacySettings);
    contents.send('privacy-settings-updated', privacySettings);
    contents.executeJavaScript(buildPrivacyPatchScript(privacySettings)).catch(() => {});
  });
}

function toggleBlockSeen(enable) {
  settings.blockSeen = enable;
  saveSettings(settings);
  updateMessengerAwayMode();
}

function toggleBlockTyping(enable) {
  settings.blockTyping = enable;
  saveSettings(settings);
  updatePagePrivacyProtection();
}

// ============================================================
//  AUTO UPDATER
// ============================================================
let isManualUpdateCheck = false;
let isUpdateDownloadActive = false;
let pendingUpdateVersion = '';
let pendingUpdateReleaseNotes = '';

function showUpdateProgress(state) {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  restoreMainWindow();
  mainWindow.setBrowserView(null);
  mainWindow.webContents.send('update-progress-state', {
    visible: true,
    version: pendingUpdateVersion,
    releaseNotes: pendingUpdateReleaseNotes,
    ...state,
  });

  if (state.phase === 'error') {
    mainWindow.setProgressBar(1, { mode: 'error' });
  } else if (Number.isFinite(state.percent)) {
    mainWindow.setProgressBar(Math.max(0, Math.min(100, state.percent)) / 100, {
      mode: 'normal',
    });
  } else {
    mainWindow.setProgressBar(0.01, { mode: 'indeterminate' });
  }
}

function setUpdateTrayState(nextState = {}) {
  updateTrayState = {
    ...updateTrayState,
    ...nextState,
  };
  updateTrayMenu();
  if (tray) {
    tray.setToolTip(buildTrayTooltip());
  }
}

function startUpdateDownload() {
  if (!updateTrayState.available || isUpdateDownloadActive) return;
  isUpdateDownloadActive = true;
  showUpdateProgress({
    phase: 'downloading',
    percent: 0,
    transferred: 0,
    total: 0,
    bytesPerSecond: 0,
  });
  autoUpdater.downloadUpdate().catch((error) => {
    isUpdateDownloadActive = false;
    setUpdateTrayState({ error: error?.message || 'Không thể tải bản cập nhật.' });
    showUpdateProgress({
      phase: 'error',
      message: `${error?.message || 'Không thể tải bản cập nhật.'} Ứng dụng vẫn giữ phiên bản hiện tại.`,
    });
  });
}

function installDownloadedUpdate() {
  if (!updateTrayState.downloaded) return;
  showUpdateProgress({
    phase: 'installing',
    percent: 100,
  });
  prepareForFullQuit();
  autoUpdater.quitAndInstall();
  setTimeout(() => app.exit(0), 5000).unref();
}

function closeUpdateProgress() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.setProgressBar(-1);
  mainWindow.webContents.send('update-progress-state', { visible: false });
  if (activeProfileId && browserViews[activeProfileId]) {
    mainWindow.setBrowserView(browserViews[activeProfileId]);
    updateBrowserViewBounds();
    updateMessengerAwayMode();
  }
}

function setupAutoUpdater() {
  autoUpdater.autoDownload = false;

  autoUpdater.on('before-quit-for-update', () => {
    prepareForFullQuit();
  });

  autoUpdater.on('update-available', (info) => {
    pendingUpdateVersion = info.version || '';
    pendingUpdateReleaseNotes = Array.isArray(info.releaseNotes)
      ? info.releaseNotes.map((item) => item.note || item).join('\n')
      : (info.releaseNotes || '');
    setUpdateTrayState({
      available: true,
      downloaded: false,
      version: pendingUpdateVersion,
      releaseNotes: pendingUpdateReleaseNotes,
      error: '',
    });
    dialog.showMessageBox({
      type: 'info',
      title: 'Có bản cập nhật mới',
      message: `Đã có bản cập nhật mới v${info.version}. Bạn có muốn tải xuống và cài đặt không?`,
      buttons: ['Tải xuống', 'Cài sau']
    }).then(result => {
      if (result.response === 0) {
        startUpdateDownload();
      }
    });
  });

  autoUpdater.on('update-not-available', (info) => {
    setUpdateTrayState({
      available: false,
      downloaded: false,
      version: '',
      releaseNotes: '',
      error: '',
    });
    if (isManualUpdateCheck) {
      dialog.showMessageBox({
        title: 'Không có cập nhật',
        message: 'Bạn đang sử dụng phiên bản mới nhất.'
      });
      isManualUpdateCheck = false;
    }
  });

  autoUpdater.on('download-progress', (progress) => {
    if (!isUpdateDownloadActive) return;
    showUpdateProgress({
      phase: 'downloading',
      percent: progress.percent,
      transferred: progress.transferred,
      total: progress.total,
      bytesPerSecond: progress.bytesPerSecond,
    });
  });

  autoUpdater.on('update-downloaded', () => {
    isUpdateDownloadActive = false;
    setUpdateTrayState({
      available: true,
      downloaded: true,
      version: pendingUpdateVersion,
      releaseNotes: pendingUpdateReleaseNotes,
      error: '',
    });
    showUpdateProgress({
      phase: 'downloaded',
      percent: 100,
    });
  });

  autoUpdater.on('error', (err) => {
    const errorMessage = err == null ? 'Lỗi không xác định' : (err.stack || err).toString();
    if (isUpdateDownloadActive) {
      isUpdateDownloadActive = false;
      setUpdateTrayState({ error: errorMessage });
      showUpdateProgress({
        phase: 'error',
        message: `${errorMessage} Ứng dụng vẫn giữ phiên bản hiện tại.`,
      });
    }

    if (isManualUpdateCheck) {
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
    const filename = path.basename(item.getFilename() || 'download') || 'download';
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
      if (state === 'completed') {
        completedDownloadPaths.add(path.resolve(savePath));
        if (completedDownloadPaths.size > 200) {
          completedDownloadPaths = new Set([...completedDownloadPaths].slice(-100));
        }
      }
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('download-done', {
          id, state, savePath, filename,
        });
      }
      activeDownloads.delete(id);
    });
  });
}

const MESSENGER_HOSTS = ['facebook.com', 'messenger.com', 'fbcdn.net'];

function isAllowedHttpsHost(url, hosts) {
  if (!url) return false;

  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return false;
    const host = parsed.hostname.toLowerCase();
    return hosts.some((allowedHost) => host === allowedHost || host.endsWith(`.${allowedHost}`));
  } catch {
    return false;
  }
}

function isSafeDownloadPath(filePath) {
  if (!filePath || typeof filePath !== 'string') return false;
  try {
    const resolvedFile = path.resolve(filePath);
    const resolvedDownloads = path.resolve(app.getPath('downloads'));
    return completedDownloadPaths.has(resolvedFile)
      || resolvedFile === resolvedDownloads
      || resolvedFile.startsWith(`${resolvedDownloads}${path.sep}`);
  } catch {
    return false;
  }
}

function isMessengerUrl(url) {
  if (!url) return false;
  if (url === 'about:blank' || url.startsWith('about:blank#')) return true;
  return isAllowedHttpsHost(url, MESSENGER_HOSTS);
}

function isOAuthPopupUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return false;

    const host = parsed.hostname.toLowerCase();
    if (host === 'accounts.google.com' || host.endsWith('.accounts.google.com')) return true;
    if (host === 'appleid.apple.com' || host.endsWith('.appleid.apple.com')) return true;

    const isGoogleHost = host === 'google.com' || host.endsWith('.google.com');
    if (isGoogleHost) {
      return /^\/(oauth2|accounts|signin)(\/|$)/.test(parsed.pathname);
    }

    return false;
  } catch {
    return false;
  }
}

function isInAppPopupUrl(url) {
  return isMessengerUrl(url) || isOAuthPopupUrl(url);
}

function isMessengerLoginCompleteUrl(url) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    const isFacebookHost = host === 'facebook.com' || host.endsWith('.facebook.com');
    const isMessengerHost = host === 'messenger.com' || host.endsWith('.messenger.com');
    if (!isFacebookHost && !isMessengerHost) return false;

    const pathname = parsed.pathname.replace(/\/+$/, '') || '/';
    if (isMessengerHost) {
      return pathname === '/' || pathname.startsWith('/t') || pathname.startsWith('/messages');
    }
    return pathname === '/' || pathname.startsWith('/messages');
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

async function registerPrivacyScript(contents, privacySettings = getPrivacySettings()) {
  if (!contents || contents.isDestroyed()) return null;

  try {
    const previousIdentifier = privacyScriptIdentifiers.get(contents.id) || null;
    privacyDebugLog(`[CDP] Attempting to attach debugger for contents.id=${contents.id}. Previous identifier=${previousIdentifier}`);

    if (!contents.debugger.isAttached()) {
      contents.debugger.attach('1.3');
      privacyDebugLog(`[CDP] Debugger attached successfully for contents.id=${contents.id}`);
    }

    await setupPrivacyNetworkDebugger(contents);

    const identifier = await registerPrivacyScriptForNewDocuments(
      contents.debugger,
      privacySettings,
      previousIdentifier,
    );

    if (identifier) {
      if (!previousIdentifier) {
        contents.once('destroyed', () => privacyScriptIdentifiers.delete(contents.id));
      }
      privacyScriptIdentifiers.set(contents.id, identifier);
      privacyDebugLog(`[CDP] Privacy script registered on new documents successfully. Identifier=${identifier}`);
    } else {
      privacyDebugLog(`[CDP] Privacy script registration returned null identifier`);
    }
    return identifier;
  } catch (err) {
    privacyDebugLog(`[CDP ERROR] Failed to register privacy script: ${err.message}\nStack: ${err.stack}`);
    return null;
  }
}

async function preparePrivacyScript(contents) {
  if (!contents || contents.isDestroyed()) return null;
  if (!contents.getURL()) {
    await contents.loadURL('about:blank');
  }
  return registerPrivacyScript(contents);
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

async function setupWebContents(contents, profileId, partition, options = {}) {
  if (profileId) {
    webContentsProfiles.set(contents.id, profileId);
    contents.once('destroyed', () => webContentsProfiles.delete(contents.id));
  }

  // Setup download handler for this view's session
  setupDownloadHandler(contents.session);
  setupPrivacyRequestBlocker(contents.session);

  // Register CDP privacy script BEFORE page loads to intercept from the start
  await preparePrivacyScript(contents);

  contents.setWindowOpenHandler(({ url }) => {
    if (isInAppPopupUrl(url)) {
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

  contents.on('did-create-window', async (childWindow) => {
    const childContents = childWindow.webContents;
    childContents.setUserAgent(USER_AGENT);
    await setupWebContents(childContents, profileId, partition, { skipMessengerPolling: true });

    let sawOAuthHost = false;
    const closeCompletedOAuthPopup = (navUrl) => {
      if (isOAuthPopupUrl(navUrl)) {
        sawOAuthHost = true;
        return;
      }
      if (!sawOAuthHost || !isMessengerLoginCompleteUrl(navUrl)) return;
      contents.loadURL(MESSENGER_URL, { userAgent: USER_AGENT });
      setTimeout(() => {
        if (!childWindow.isDestroyed()) childWindow.close();
      }, 500);
    };

    childContents.on('did-navigate', (event, navUrl) => closeCompletedOAuthPopup(navUrl));
    childContents.on('did-redirect-navigation', (event, navUrl) => closeCompletedOAuthPopup(navUrl));
  });

  contents.on('context-menu', (event, params) => {
    const menu = new Menu();
    if (params.misspelledWord) {
      for (const suggestion of params.dictionarySuggestions) {
        menu.append(new MenuItem({ label: suggestion, click: () => contents.replaceMisspelling(suggestion) }));
      }
      if (params.dictionarySuggestions.length > 0) menu.append(new MenuItem({ type: 'separator' }));
    }
    if (params.selectionText) menu.append(new MenuItem({ label: 'Sao chép', role: 'copy' }));
    if (params.isEditable) {
      menu.append(new MenuItem({ label: 'Dán', role: 'paste' }));
      menu.append(new MenuItem({ label: 'Cắt', role: 'cut' }));
      menu.append(new MenuItem({ label: 'Chọn tất cả', role: 'selectAll' }));
    }
    if (params.linkURL) {
      menu.append(new MenuItem({ type: 'separator' }));
      menu.append(new MenuItem({
        label: 'Mở liên kết',
        enabled: isExternalWebUrl(params.linkURL),
        click: () => {
          if (isExternalWebUrl(params.linkURL)) shell.openExternal(params.linkURL);
        },
      }));
      menu.append(new MenuItem({ label: 'Sao chép liên kết', click: () => require('electron').clipboard.writeText(params.linkURL) }));
    }
    if (params.mediaType === 'image') {
      menu.append(new MenuItem({ type: 'separator' }));
      menu.append(new MenuItem({ label: 'Lưu ảnh', click: () => contents.downloadURL(params.srcURL) }));
    }
    menu.append(new MenuItem({ type: 'separator' }));
    menu.append(new MenuItem({ label: 'Tải lại trang', click: () => contents.reload() }));
    menu.append(new MenuItem({ label: 'Quay lại', enabled: contents.canGoBack(), click: () => contents.goBack() }));
    if (menu.items.length > 0) menu.popup({ window: mainWindow });
  });

  contents.on('did-finish-load', async () => {
    const cssPath = path.join(__dirname, 'custom_style.css');
    try {
      const cssData = fs.readFileSync(cssPath, 'utf8');
      contents.insertCSS(cssData);
    } catch(e) {}
    contents.executeJavaScript(buildPrivacyPatchScript(getPrivacySettings())).catch(() => {});
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
      const avatarUrl = await resolveProfileAvatar(contents);
      if (avatarUrl && mainWindow && profileId) {
        mainWindow.webContents.send('update-profile-avatar', { id: profileId, avatarUrl });
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

  return preparePrivacyScript(contents);
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

    setupPrivacyRequestBlocker(sess);

    sess.setPermissionRequestHandler((webContents, permission, callback, details = {}) => {
      const currentUrl = webContents.getURL();
      const requestingUrl = details.requestingUrl || details.securityOrigin || details.embeddingOrigin || currentUrl;
      if (isMessengerUrl(currentUrl) || isMessengerUrl(requestingUrl)) {
        const allowedPermissions = [
          'media', 'mediaKeySystem', 'microphone',
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
      if (permission === 'notifications') {
        return false;
      }
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
  ipcMain.on('switch-profile', async (event, profile) => {
    const previousProfileId = activeProfileId;
    activeProfileId = profile.id;
    profileNames[profile.id] = profile.name || 'Messenger';
    profilePartitions[profile.id] = profile.partition;
    clearProfileSleepTimer(profile.id);
    if (previousProfileId && previousProfileId !== profile.id) {
      scheduleProfileSleep(previousProfileId);
    }
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
      await setupWebContents(view.webContents, profile.id, profile.partition);
      await view.webContents.loadURL(MESSENGER_URL, { userAgent: USER_AGENT });
    }
    mainWindow.setBrowserView(browserViews[profile.id]);
    updateBrowserViewBounds();
    updateMessengerAwayMode();
  });

  ipcMain.on('profiles-updated', (event, profiles = []) => {
    if (!Array.isArray(profiles)) return;
    profiles.forEach((profile) => {
      if (!profile?.id) return;
      if (profile.name) profileNames[profile.id] = profile.name;
      if (profile.partition) profilePartitions[profile.id] = profile.partition;
    });
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
      await setupWebContents(view.webContents, id, partition);
      await view.webContents.loadURL(MESSENGER_URL, { userAgent: USER_AGENT });

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

  ipcMain.on('close-update-progress', () => {
    if (!isUpdateDownloadActive) {
      closeUpdateProgress();
    }
  });

  ipcMain.on('install-update-now', () => installDownloadedUpdate());

  ipcMain.on('install-update-later', () => {
    closeUpdateProgress();
    setUpdateTrayState({ downloaded: !!updateTrayState.downloaded });
  });

  ipcMain.on('delete-profile', (event, id) => {
    if (browserViews[id]) {
      destroyBrowserView(id);
    }
    delete profileUnreadCounts[id];
    delete profileNames[id];
    delete profilePartitions[id];
    clearProfileSleepTimer(id);
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
      blockSeen: settings.blockSeen,
      blockTyping: settings.blockTyping,
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
    if (isSafeDownloadPath(filePath) && fs.existsSync(filePath)) {
      shell.openPath(filePath);
    }
  });

  ipcMain.on('open-download-folder', (event, filePath) => {
    if (isSafeDownloadPath(filePath) && fs.existsSync(filePath)) {
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
    tray.setToolTip(buildTrayTooltip());
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

