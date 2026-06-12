const { app, BrowserWindow, session, ipcMain, dialog } = require('electron');
const path   = require('path');
const fs     = require('fs');
const http   = require('http');
const https  = require('https');
const os     = require('os');
const { exec } = require('child_process');

const isDev  = !app.isPackaged;
let   localPort = 0;
let   localServer = null;

// ── MIME types ─────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript',
  '.mjs':  'application/javascript',
  '.css':  'text/css',
  '.json': 'application/json',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.woff': 'font/woff',
  '.woff2':'font/woff2',
  '.ttf':  'font/ttf',
  '.map':  'application/json',
};

// ── Static file server for Expo web build ──────────────────────
function startStaticServer(distPath) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      // strip query string
      let urlPath = req.url.split('?')[0];
      if (urlPath === '/') urlPath = '/index.html';

      let filePath = path.join(distPath, urlPath);

      // SPA fallback → serve index.html for unknown routes
      if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
        filePath = path.join(distPath, 'index.html');
      }

      fs.readFile(filePath, (err, data) => {
        if (err) {
          res.writeHead(404);
          res.end('Not found');
          return;
        }
        const ext  = path.extname(filePath).toLowerCase();
        const mime = MIME[ext] || 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': mime });
        res.end(data);
      });
    });

    server.listen(0, '127.0.0.1', () => {
      localPort = server.address().port;
      localServer = server;
      console.log(`Static server on http://127.0.0.1:${localPort}`);
      resolve(localPort);
    });
    server.on('error', reject);
  });
}

// ── CRX public-key extractor (preserves Chrome Web Store extension ID) ─────
function readVarInt(buf, offset) {
  let value = 0, shift = 0, pos = offset;
  while (pos < buf.length) {
    const b = buf[pos++];
    value |= (b & 0x7f) << shift;
    if (!(b & 0x80)) break;
    shift += 7;
  }
  return { value, pos };
}

// Extracts the RSA/ECDSA public key from a CRX3 protobuf header buffer.
// CrxFileHeader { sha256_with_rsa=2, sha256_with_ecdsa=3 }
// AsymmetricKeyProof { public_key=1, signature=2 }
function extractCrx3PubKey(headerBuf) {
  let pos = 0;
  while (pos < headerBuf.length) {
    const tag = readVarInt(headerBuf, pos); pos = tag.pos;
    const field = tag.value >>> 3, wire = tag.value & 7;
    if (wire === 0) { pos = readVarInt(headerBuf, pos).pos; }
    else if (wire === 1) { pos += 8; }
    else if (wire === 5) { pos += 4; }
    else if (wire === 2) {
      const len = readVarInt(headerBuf, pos); pos = len.pos;
      const data = headerBuf.slice(pos, pos + len.value); pos += len.value;
      if (field === 2 || field === 3) { // sha256_with_rsa / sha256_with_ecdsa
        let ip = 0;
        while (ip < data.length) {
          const it = readVarInt(data, ip); ip = it.pos;
          const ifield = it.value >>> 3, iwire = it.value & 7;
          if (iwire === 0) { ip = readVarInt(data, ip).pos; }
          else if (iwire === 1) { ip += 8; }
          else if (iwire === 5) { ip += 4; }
          else if (iwire === 2) {
            const il = readVarInt(data, ip); ip = il.pos;
            const id = data.slice(ip, ip + il.value); ip += il.value;
            if (ifield === 1) return id; // public_key !
          } else break;
        }
      }
    } else break;
  }
  return null;
}

// Returns base64 public key from a CRX2 or CRX3 buffer (null if unrecognised)
function extractCrxPubKey(buf) {
  try {
    if (buf.slice(0, 4).toString('ascii') !== 'Cr24') return null;
    const version = buf.readUInt32LE(4);
    if (version === 2) {
      const pkLen = buf.readUInt32LE(8);
      return buf.slice(16, 16 + pkLen).toString('base64');
    }
    if (version === 3) {
      const headerSize = buf.readUInt32LE(8);
      const headerBuf = buf.slice(12, 12 + headerSize);
      const key = extractCrx3PubKey(headerBuf);
      return key ? key.toString('base64') : null;
    }
  } catch {}
  return null;
}

// ── CRX downloader ─────────────────────────────────────────────
function downloadBuffer(url, hops = 0) {
  if (hops > 10) return Promise.reject(new Error('Too many redirects'));
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    mod.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36' }
    }, res => {
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
        return resolve(downloadBuffer(res.headers.location, hops + 1));
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

// ── Extension support ──────────────────────────────────────────
async function loadExtensions() {
  const extDir = path.join(app.getPath('userData'), 'extensions');
  if (!fs.existsSync(extDir)) { fs.mkdirSync(extDir, { recursive: true }); return; }

  for (const entry of fs.readdirSync(extDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const folderPath = path.join(extDir, entry.name);
    try {
      const ext = await session.defaultSession.loadExtension(folderPath, { allowFileAccess: true });
      const hasKey = (() => {
        try { return !!JSON.parse(fs.readFileSync(path.join(folderPath, 'manifest.json'), 'utf8')).key; } catch { return false; }
      })();
      console.log(`Extension loaded: folder=${entry.name} → id=${ext.id} key=${hasKey ? 'OK' : 'MISSING (ID may differ)'}`);
    } catch (e) {
      console.warn('Extension failed:', entry.name, e.message);
    }
  }
}

// ── IPC ────────────────────────────────────────────────────────
ipcMain.handle('open-extension-folder', () => {
  const extDir = path.join(app.getPath('userData'), 'extensions');
  if (!fs.existsSync(extDir)) fs.mkdirSync(extDir, { recursive: true });
  require('child_process').exec(`explorer "${extDir}"`);
  return extDir;
});

ipcMain.handle('install-extension', async () => {
  const result = await dialog.showOpenDialog({
    title: '選擇擴充套件資料夾（已解壓縮的 Chrome 擴充套件）',
    properties: ['openDirectory'],
  });
  if (result.canceled || !result.filePaths.length) return { ok: false };

  const src  = result.filePaths[0];
  const dest = path.join(app.getPath('userData'), 'extensions', path.basename(src));
  fs.cpSync(src, dest, { recursive: true });
  try {
    await session.defaultSession.loadExtension(dest, { allowFileAccess: true });
    return { ok: true, name: path.basename(src) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('list-extensions', () =>
  session.defaultSession.getAllExtensions().map(e => ({
    id: e.id, name: e.name, version: e.version,
  }))
);

ipcMain.handle('remove-extension', async (_, extId) => {
  try {
    await session.defaultSession.removeExtension(extId);
    // Also delete the folder so it isn't reloaded on next startup
    const extDir = path.join(app.getPath('userData'), 'extensions');
    for (const entry of fs.readdirSync(extDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const folderPath = path.join(extDir, entry.name);
      try {
        const manifest = JSON.parse(fs.readFileSync(path.join(folderPath, 'manifest.json'), 'utf8'));
        // Match by folder name (CWS id) OR by key-derived id
        if (entry.name === extId || manifest.key) {
          // Verify it's actually this extension by loading its id
          // Folder named with extId → safe to delete
          if (entry.name === extId) {
            fs.rmSync(folderPath, { recursive: true, force: true });
            console.log('Extension folder deleted:', folderPath);
          }
        }
      } catch {}
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('get-extension-details', () => {
  return session.defaultSession.getAllExtensions().map(ext => {
    let popup = null;
    let icon  = null;
    try {
      const manifest = JSON.parse(
        fs.readFileSync(path.join(ext.path, 'manifest.json'), 'utf8')
      );
      // Popup path
      const popupRel = manifest.action?.default_popup
        || manifest.browser_action?.default_popup
        || manifest.page_action?.default_popup
        || null;
      if (popupRel) popup = `chrome-extension://${ext.id}/${popupRel}`;

      // Best available icon → base64 data URL
      const iconMap = manifest.action?.default_icon
        || manifest.browser_action?.default_icon
        || manifest.icons || {};
      const rel = typeof iconMap === 'string' ? iconMap
        : (iconMap['48'] || iconMap['32'] || iconMap['128'] || iconMap['16'] || Object.values(iconMap)[0]);
      if (rel) {
        const full = path.join(ext.path, rel);
        if (fs.existsSync(full)) {
          const mime = rel.endsWith('.svg') ? 'image/svg+xml' : 'image/png';
          icon = `data:${mime};base64,${fs.readFileSync(full).toString('base64')}`;
        }
      }
    } catch {}
    return { id: ext.id, name: ext.name, version: ext.version, popup, icon };
  });
});

ipcMain.handle('open-extension-popup', (_, { popupUrl, name }) => {
  const win = new BrowserWindow({
    width: 420,
    height: 600,
    resizable: true,
    alwaysOnTop: false,
    title: name,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: false,   // allow preload to patch chrome.* APIs
      preload: path.join(__dirname, 'extension-preload.js'),
      // no partition → uses defaultSession which has extensions loaded
    },
  });
  win.setMenuBarVisibility(false);
  win.loadURL(popupUrl);
  return { ok: true };
});

ipcMain.handle('install-from-id', async (_, extId) => {
  try {
    // Download CRX from Google
    const crxUrl = `https://clients2.google.com/service/update2/crx?response=redirect&acceptformat=crx2,crx3&x=id%3D${extId}%26uc&prodversion=130.0.0.0`;
    const buf = await downloadBuffer(crxUrl);

    // Extract public key BEFORE parsing ZIP (to preserve Chrome extension ID)
    const pubKeyBase64 = extractCrxPubKey(buf);

    // Parse CRX header to find ZIP payload
    const magic = buf.slice(0, 4).toString('ascii');
    if (magic !== 'Cr24') throw new Error(`非 CRX 格式 (magic=${magic})`);
    const version = buf.readUInt32LE(4);
    let zipStart;
    if (version === 2) {
      const pubKeyLen = buf.readUInt32LE(8);
      const sigLen    = buf.readUInt32LE(12);
      zipStart = 16 + pubKeyLen + sigLen;
    } else if (version === 3) {
      const headerSize = buf.readUInt32LE(8);
      zipStart = 12 + headerSize;
    } else {
      throw new Error(`不支援的 CRX 版本: ${version}`);
    }
    const zipBuf = buf.slice(zipStart);

    // Write ZIP to temp dir
    const tmpZip = path.join(os.tmpdir(), `lance_ext_${extId}.zip`);
    fs.writeFileSync(tmpZip, zipBuf);

    // Extract with PowerShell
    const destDir = path.join(app.getPath('userData'), 'extensions', extId);
    if (fs.existsSync(destDir)) fs.rmSync(destDir, { recursive: true });
    fs.mkdirSync(destDir, { recursive: true });

    await new Promise((resolve, reject) => {
      exec(
        `powershell -NoProfile -Command "Expand-Archive -Force -Path '${tmpZip}' -DestinationPath '${destDir}'"`,
        { timeout: 30000 },
        err => err ? reject(err) : resolve()
      );
    });

    try { fs.unlinkSync(tmpZip); } catch {}

    // Inject public key into manifest so Electron assigns the original Chrome ID
    if (pubKeyBase64) {
      try {
        const manifestFile = path.join(destDir, 'manifest.json');
        const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
        manifest.key = pubKeyBase64;
        fs.writeFileSync(manifestFile, JSON.stringify(manifest));
        console.log('[install-from-id] Public key injected → ID preserved');
      } catch (e) {
        console.warn('[install-from-id] Could not inject key:', e.message);
      }
    }

    // Load into session
    const ext = await session.defaultSession.loadExtension(destDir, { allowFileAccess: true });
    return { ok: true, name: ext.name };
  } catch (e) {
    console.error('[install-from-id]', e.message);
    return { ok: false, error: e.message };
  }
});

// ── Create window ──────────────────────────────────────────────
async function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: 'EvoluBrowser',
    icon: path.join(__dirname, '..', 'assets', 'favicon.ico'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      webviewTag: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  win.setMenuBarVisibility(false);

  if (isDev) {
    // Dev: try Metro server first
    win.loadURL('http://localhost:8081').catch(() => {
      // Metro not running — fall back to dist
      loadDist(win);
    });
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    await loadDist(win);
  }

  win.webContents.once('did-finish-load', () => loadExtensions());
}

async function loadDist(win) {
  // Find the dist folder
  const candidates = [
    path.join(__dirname, '..', 'dist'),
    path.join(process.resourcesPath || '', 'web'),
  ];
  const distPath = candidates.find(p => fs.existsSync(path.join(p, 'index.html')));

  if (!distPath) {
    win.loadURL('data:text/html,<h2>找不到 web build。請先執行：<br><code>npx expo export --platform web</code></h2>');
    return;
  }

  // Start static server if not already running
  if (!localPort) {
    await startStaticServer(distPath);
  }
  win.loadURL(`http://127.0.0.1:${localPort}/`);
}

// ── App lifecycle ──────────────────────────────────────────────
app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  localServer?.close();
  if (process.platform !== 'darwin') app.quit();
});
