const { machineIdSync } = require('node-machine-id');
const crypto = require('crypto');
const db = require('./db');

const SECRET_SALT = 'RETAIL_POS_SECURE_KEY_2026';

function getHardwareId() {
  try {
    return machineIdSync({ original: true });
  } catch (e) {
    return 'UNKNOWN_HARDWARE_ID';
  }
}

function generateValidKey(hwId) {
  const hash = crypto.createHmac('sha256', SECRET_SALT).update(hwId).digest('hex').toUpperCase();
  return `${hash.slice(0, 4)}-${hash.slice(4, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}`;
}

// ഡാറ്റാബേസിൽ നിന്ന് ലൈസൻസ് കീ ശരിയാണോ എന്ന് പരിശോധിക്കുന്നു
function verifyLicense() {
  try {
    const row = db.prepare('SELECT license_key, zatca_csid FROM settings WHERE id = 1').get();
    // പുതിയ license_key-യോ അല്ലെങ്കിൽ നേരത്തെ സൂക്ഷിച്ച zatca_csid-യോ പരിശോധിക്കുന്നു
    const savedKey = (row && row.license_key ? row.license_key : (row && row.zatca_csid ? row.zatca_csid : '')).trim();
    
    const validKey = generateValidKey(getHardwareId());
    const isValid = (savedKey !== '' && savedKey.toUpperCase() === validKey.toUpperCase());
    
    return { valid: isValid, machineId: getHardwareId() };
  } catch (e) {
    console.error('License Verification Error:', e);
    return { valid: false, machineId: getHardwareId() };
  }
}

// ആക്ടിവേഷൻ കീ ഡാറ്റാബേസിൽ സേവ് ചെയ്യുന്നു
function activateLicense(key) {
  const expectedKey = generateValidKey(getHardwareId());
  const inputKey = key ? key.trim().toUpperCase() : '';

  if (inputKey === expectedKey) {
    try {
      db.prepare('UPDATE settings SET license_key = ? WHERE id = 1').run(inputKey);
      return { success: true };
    } catch (e) {
      console.error('License Save Error:', e);
      return { success: false, error: 'Database save failed' };
    }
  }
  return { success: false, error: 'Invalid activation key for this PC' };
}

module.exports = { getHardwareId, verifyLicense, activateLicense };