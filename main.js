const { app, BrowserWindow, ipcMain, shell, Tray, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');

const { verifyLicense } = require('./license.js');
require('./server.js');

let mainWindow;
let tray = null;
let isQuitting = false;

// Dynamic port calculation
function getEffectivePort() {
  let p = 6060;
  try {
    const configPath = path.join(app.getPath('userData'), 'config.json');
    if (fs.existsSync(configPath)) {
      const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (cfg.port) p = parseInt(cfg.port, 10);
    }
  } catch (e) {}
  return p || process.env.PORT || 6060;
}

// Automatic backup function with multi-drive redundancy
function performAutoBackup() {
  try {
    const userData = app.getPath('userData');
    const dbFile = path.join(userData, 'data', 'pos.db');
    if (!fs.existsSync(dbFile)) return;

    // 1. Primary AppData backup
    const backupFolder = path.join(userData, 'backups');
    if (!fs.existsSync(backupFolder)) {
      fs.mkdirSync(backupFolder, { recursive: true });
    }

    const today = new Date().toISOString().slice(0, 10);
    const backupFileName = `pos_autobackup_${today}.db`;
    const destPath = path.join(backupFolder, backupFileName);
    fs.copyFileSync(dbFile, destPath);
    console.log('[Auto-Backup] Primary backup saved to:', destPath);

    // 2. Secondary Drive backup (D: or E: drives for Google Drive sync / offline safety)
    const targetDrives = ['D:\\POS_BACKUPS', 'E:\\POS_BACKUPS'];
    for (const drivePath of targetDrives) {
      const rootDrive = drivePath.substring(0, 3);
      if (fs.existsSync(rootDrive)) {
        try {
          if (!fs.existsSync(drivePath)) {
            fs.mkdirSync(drivePath, { recursive: true });
          }
          fs.copyFileSync(dbFile, path.join(drivePath, backupFileName));
          console.log('[Auto-Backup] Secondary backup saved to:', path.join(drivePath, backupFileName));
        } catch (e) {}
        break;
      }
    }

    // Retain up to 30 recent daily backups
    const files = fs.readdirSync(backupFolder);
    if (files.length > 30) {
      files.sort().slice(0, files.length - 30).forEach(oldFile => {
        try { fs.unlinkSync(path.join(backupFolder, oldFile)); } catch (e) {}
      });
    }
  } catch (e) {
    console.error('[Auto-Backup Error]', e.message);
  }
}

function waitForServer(callback) {
  const port = getEffectivePort();
  const checkServer = () => {
    http.get(`http://127.0.0.1:${port}/api/health`, (res) => {
      callback();
    }).on('error', () => {
      setTimeout(checkServer, 300);
    });
  };
  checkServer();
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  const port = getEffectivePort();

  waitForServer(() => {
    const lic = verifyLicense();
    if (lic && lic.valid) {
      mainWindow.loadURL(`http://127.0.0.1:${port}/index.html`);
    } else {
      mainWindow.loadURL(`http://127.0.0.1:${port}/activation.html`);
    }
  });

  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      isQuitting = true;
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.includes('web.whatsapp.com') || url.includes('api.whatsapp.com')) {
      shell.openExternal(url);
      return { action: 'deny' };
    }

    if (url.includes('invoice_') || url.includes('receipt_') || url.includes('purchase_') || url.includes('/templates/')) {
      const parsedUrl = new URL(url);
      const targetPrinter = parsedUrl.searchParams.get('printer') || '';
      createSilentPrintWindow(url, targetPrinter);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  createSystemTray();
}

function createSilentPrintWindow(url, targetPrinter = '') {
  let printWin = new BrowserWindow({
    show: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  printWin.loadURL(url);

  printWin.webContents.on('did-finish-load', () => {
    setTimeout(async () => {
      const printOptions = {
        silent: true,
        printBackground: true
      };

      if (targetPrinter && targetPrinter.trim() !== '') {
        printOptions.deviceName = targetPrinter.trim();
      }

      try {
        printWin.webContents.print(printOptions, (success, failureReason) => {
          if (!success) {
            console.error('Silent print failed:', failureReason);
          }
          if (printWin) {
            printWin.close();
            printWin = null;
          }
        });
      } catch (err) {
        console.error('Print error:', err);
        if (printWin) {
          printWin.close();
          printWin = null;
        }
      }
    }, 600);
  });

  printWin.webContents.on('did-fail-load', () => {
    if (printWin) {
      printWin.close();
      printWin = null;
    }
  });
}

function createSystemTray() {
  if (tray) return;

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Open POS Screen / സ്ക്രീൻ തുറക്കുക',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        }
      }
    },
    {
      label: 'Backup Database Now / ബാക്കപ്പ് എടുക്കുക',
      click: () => {
        performAutoBackup();
      }
    },
    { type: 'separator' },
    {
      label: 'Quit POS Completely / സെർവർ ഓഫ് ചെയ്യുക',
      click: () => {
        isQuitting = true;
        performAutoBackup();
        app.quit();
      }
    }
  ]);

  try {
    tray = new Tray(path.join(__dirname, 'icon.ico'));
  } catch (e) {
    const { nativeImage } = require('electron');
    tray = new Tray(nativeImage.createEmpty());
  }

  tray.setToolTip('SAMPOS - Server Running');
  tray.setContextMenu(contextMenu);

  tray.on('double-click', () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

app.whenReady().then(() => {
  createWindow();

  app.setLoginItemSettings({
    openAtLogin: true,
    path: process.execPath
  });

  setTimeout(() => {
    performAutoBackup();
  }, 10000);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    } else if (mainWindow) {
      mainWindow.show();
    }
  });
});

app.on('before-quit', () => {
  isQuitting = true;
  performAutoBackup();
});

app.on('window-all-closed', () => {
  performAutoBackup();
  if (process.platform !== 'darwin') {
    app.quit();
    process.exit(0);
  }
});

ipcMain.handle('get-local-printers', async () => {
  if (!mainWindow) return [];
  try {
    const printers = await mainWindow.webContents.getPrintersAsync();
    return printers.map(p => p.name);
  } catch (err) {
    return [];
  }
});

ipcMain.handle('get-system-printers', async () => {
  if (!mainWindow) return [];
  return await mainWindow.webContents.getPrintersAsync();
});

ipcMain.on('print-direct', (event, { url, printerName }) => {
  if (url) {
    createSilentPrintWindow(url, printerName);
  }
});

ipcMain.on('open-external-url', (event, targetUrl) => {
  if (targetUrl) {
    shell.openExternal(targetUrl);
  }
});

ipcMain.handle('get-config', () => {
  try {
    const configPath = path.join(app.getPath('userData'), 'config.json');
    if (fs.existsSync(configPath)) {
      return JSON.parse(fs.readFileSync(configPath, 'utf8'));
    }
  } catch (e) {}
  return { port: 6060 };
});

ipcMain.handle('save-config', (event, newCfg) => {
  try {
    const configPath = path.join(app.getPath('userData'), 'config.json');
    fs.writeFileSync(configPath, JSON.stringify(newCfg, null, 2), 'utf8');
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// Expose silent print window to global scope for mobile HTTP print requests
global.createSilentPrintWindow = createSilentPrintWindow;
