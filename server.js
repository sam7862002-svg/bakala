require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const db = require('./db');
const license = require('./license');

// Start Supabase Background Sync Worker safely
let syncWorker = null;
try {
  syncWorker = require('./syncWorker');
} catch (err) {
  console.warn('[SyncWorker Warning] Could not start Supabase sync:', err.message);
}

function getDynamicPort() {
  let p = 6060;
  try {
    const electron = require('electron');
    const app = electron.app || (electron.remote && electron.remote.app);
    if (app) {
      const configPath = path.join(app.getPath('userData'), 'config.json');
      if (fs.existsSync(configPath)) {
        const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        if (cfg.port) p = parseInt(cfg.port, 10);
      }
    }
  } catch (e) {}
  return p || process.env.PORT || 6060;
}

const PORT = getDynamicPort();
const app = express();

app.use(cors());
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ limit: '100mb', extended: true }));

app.get('/api/license/status', (req, res) => {
  res.json({ success: true, ...license.verifyLicense() });
});

app.post('/api/license/activate', (req, res) => {
  try {
    const result = license.activateLicense(req.body.key || '');
    res.json(result);
  } catch (err) {
    console.error('Activation Error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.use((req, res, next) => {
  if (req.path.startsWith('/api/license') || req.path === '/activation.html' || req.path.endsWith('.css') || req.path.endsWith('.js')) {
    return next();
  }
  const status = license.verifyLicense();
  if (!status.valid) {
    if (req.path.startsWith('/api/')) {
      return res.status(403).json({ success: false, error: 'Software not licensed on this machine.' });
    }
    return res.redirect('/activation.html');
  }
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

function getTemplatesDir() {
  if (process.resourcesPath && fs.existsSync(path.join(process.resourcesPath, 'templates'))) {
    return path.join(process.resourcesPath, 'templates');
  }
  return path.join(__dirname, 'templates');
}

app.use('/templates', express.static(getTemplatesDir()));

function mountRoute(apiPath, filePath) {
  if (fs.existsSync(path.join(__dirname, filePath + '.js'))) {
    app.use(apiPath, require(filePath));
  }
}

mountRoute('/api/products', './routes/products');
mountRoute('/api/sales', './routes/sales');
mountRoute('/api/purchases', './routes/purchases');
mountRoute('/api/parties', './routes/parties');
mountRoute('/api/expenses', './routes/expenses');
mountRoute('/api/reports', './routes/reports');
mountRoute('/api/settings', './routes/settings');
mountRoute('/api/zatca', './routes/zatca');

const invoicesRouter = require('./routes/invoices');
app.use('/api/invoices', invoicesRouter);

// Endpoint for mobile / client devices to trigger silent print on main server PC
app.post('/api/print/network-ticket', (req, res) => {
  try {
    const { url, printerName } = req.body;
    const store = db.prepare("SELECT printer_pos_name FROM settings WHERE id = 1").get() || {};
    const targetPrinter = printerName || store.printer_pos_name || '';

    if (global.createSilentPrintWindow) {
      global.createSilentPrintWindow(url, targetPrinter);
      return res.json({ success: true, message: 'Print job dispatched to server printer' });
    }
    res.json({ success: false, error: 'Silent print service not available on server' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});


app.get('/api/health', (req, res) => {
  res.json({ status: 'OK', port: PORT, database: 'userData/pos.db' });
});

// Manual trigger endpoint for immediate Supabase Cloud Sync
app.post('/api/sync/now', async (req, res) => {
  try {
    if (syncWorker && syncWorker.runSyncCycle) {
      await syncWorker.runSyncCycle();
      return res.json({ success: true, message: 'Cloud sync cycle completed' });
    }
    res.json({ success: false, error: 'Sync worker not initialized (Check @supabase/supabase-js)' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log('=======================================================');
  console.log(`SAMPOS Server Running on Port: ${PORT}`);
  console.log(`Open Dashboard: http://127.0.0.1:${PORT}`);
  console.log('=======================================================');
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.log(`[INFO] Port ${PORT} already in use. Continuing safely.`);
  } else {
    console.error('Server error:', err);
  }
});
