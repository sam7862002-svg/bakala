const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

let dataDir;
try {
  const electron = require('electron');
  const app = electron.app || (electron.remote && electron.remote.app);
  if (app) {
    dataDir = path.join(app.getPath('userData'), 'data');
  } else {
    dataDir = path.join(__dirname, 'data');
  }
} catch (e) {
  dataDir = path.join(__dirname, 'data');
}

if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const db = new Database(path.join(dataDir, 'pos.db'));
db.pragma('foreign_keys = ON');
db.pragma('journal_mode = WAL');

db.exec(`
  -- 1. STORE & BANK SETTINGS & ZATCA PHASE 2
  CREATE TABLE IF NOT EXISTS settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    company_name_en TEXT DEFAULT 'My Retail Store',
    company_name_ar TEXT DEFAULT 'متجري',
    vat_number TEXT DEFAULT '',
    cr_number TEXT DEFAULT '',
    phone TEXT DEFAULT '',
    email TEXT DEFAULT '',
    address_en TEXT DEFAULT '',
    address_ar TEXT DEFAULT '',
    national_address TEXT DEFAULT '',
    short_address TEXT DEFAULT '',
    building_no TEXT DEFAULT '',
    street_en TEXT DEFAULT '',
    street_ar TEXT DEFAULT '',
    district_en TEXT DEFAULT '',
    district_ar TEXT DEFAULT '',
    city_en TEXT DEFAULT 'Jeddah',
    city_ar TEXT DEFAULT 'جدة',
    postal_code TEXT DEFAULT '',
    additional_no TEXT DEFAULT '',
    bank_name TEXT DEFAULT '',
    account_number TEXT DEFAULT '',
    iban TEXT DEFAULT '',
    currency TEXT DEFAULT 'SAR',
    cost_cipher_key TEXT DEFAULT 'COMPUTERSX',
    store_seal_img TEXT DEFAULT '',
    printer_pos_name TEXT DEFAULT '',
    printer_a4_name TEXT DEFAULT '',
    template_config TEXT DEFAULT '',
    supabase_url TEXT DEFAULT '',
    supabase_key TEXT DEFAULT '',
    initial_cash REAL DEFAULT 0.00,
    initial_bank REAL DEFAULT 0.00,
    zatca_env TEXT DEFAULT 'sandbox',
    zatca_csid TEXT,
    zatca_secret TEXT,
    zatca_private_key TEXT,
    zatca_public_key TEXT,
    zatca_compliance_request_id TEXT,
    zatca_certificate TEXT,
    license_key TEXT DEFAULT '',
    admin_password TEXT DEFAULT 'admin123',
    server_port INTEGER DEFAULT 5050
  );
  INSERT OR IGNORE INTO settings (id) VALUES (1);

  -- 2. PRODUCTS
  CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    item_code TEXT UNIQUE,
    barcode1 TEXT UNIQUE NOT NULL,
    barcode2 TEXT,
    barcode3 TEXT,
    name_en TEXT NOT NULL,
    name_ar TEXT NOT NULL,
    category TEXT DEFAULT 'GENERAL',
    unit TEXT DEFAULT 'PCS',
    wholesale_unit TEXT DEFAULT 'BOX',
    wholesale_unit_size REAL DEFAULT 1.00,
    cost_price REAL DEFAULT 0.00,
    selling_price REAL NOT NULL,
    wholesale_price REAL DEFAULT 0.00,
    vat_rate REAL DEFAULT 15.00,
    stock_quantity REAL DEFAULT 0.00,
    min_stock_alert REAL DEFAULT 5.00,
    batch_no TEXT,
    expiry_date DATE,
    is_active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- 3. SALES AGENTS
  CREATE TABLE IF NOT EXISTS agents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name_en TEXT NOT NULL,
    name_ar TEXT,
    phone TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- 4. PARTIES
  CREATE TABLE IF NOT EXISTS parties (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    party_type TEXT DEFAULT 'customer',
    type TEXT DEFAULT 'customer',
    sub_type TEXT DEFAULT 'credit',
    name_en TEXT NOT NULL,
    name_ar TEXT,
    phone TEXT UNIQUE,
    vat_number TEXT,
    cr_number TEXT DEFAULT '',
    short_address TEXT DEFAULT '',
    building_no TEXT DEFAULT '',
    street_en TEXT DEFAULT '',
    street_ar TEXT DEFAULT '',
    district_en TEXT DEFAULT '',
    district_ar TEXT DEFAULT '',
    city_en TEXT DEFAULT 'Jeddah',
    city_ar TEXT DEFAULT 'جدة',
    postal_code TEXT DEFAULT '',
    additional_no TEXT DEFAULT '',
    credit_limit REAL DEFAULT 0.00,
    opening_balance REAL DEFAULT 0.00,
    current_balance REAL DEFAULT 0.00,
    agent_id INTEGER,
    bank_name TEXT DEFAULT '',
    account_number TEXT DEFAULT '',
    iban TEXT DEFAULT '',
    is_active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (agent_id) REFERENCES agents(id)
  );

  INSERT OR IGNORE INTO parties (id, type, party_type, sub_type, name_en, name_ar, phone, current_balance) 
  VALUES (147, 'vendor', 'vendor', 'cash', 'LOCAL CASH VENDOR', 'مورد نقدي محلي', '0500000000', 0.00);

  -- 5. PURCHASES
  CREATE TABLE IF NOT EXISTS purchases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    purchase_no TEXT UNIQUE,
    bill_number TEXT NOT NULL,
    supplier_inv_no TEXT,
    is_return INTEGER DEFAULT 0,
    return_ref_no TEXT,
    vendor_id INTEGER NOT NULL,
    party_id INTEGER,
    vendor_name TEXT,
    vendor_phone TEXT,
    vendor_vat TEXT,
    vendor_cr TEXT,
    purchase_date TEXT,
    purchase_time TEXT,
    subtotal REAL NOT NULL,
    vat_amount REAL NOT NULL,
    total_amount REAL NOT NULL,
    payment_type TEXT DEFAULT 'cash',
    payment_mode TEXT DEFAULT 'CASH',
    payment_method TEXT DEFAULT 'CASH',
    paid_cash REAL DEFAULT 0,
    paid_bank REAL DEFAULT 0,
    paid_credit REAL DEFAULT 0,
    prev_balance REAL DEFAULT 0,
    net_balance REAL DEFAULT 0,
    notes TEXT,
    status TEXT DEFAULT 'COMPLETED',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (vendor_id) REFERENCES parties(id)
  );

  -- 6. PURCHASE ITEMS
  CREATE TABLE IF NOT EXISTS purchase_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    purchase_id INTEGER NOT NULL,
    product_id INTEGER,
    item_code TEXT,
    barcode TEXT,
    name_en TEXT NOT NULL,
    name_ar TEXT,
    unit TEXT DEFAULT 'PCS',
    quantity REAL NOT NULL,
    unit_cost REAL NOT NULL,
    cost_price REAL DEFAULT 0,
    vat_rate REAL NOT NULL,
    vat_amount REAL NOT NULL,
    total_line_amount REAL NOT NULL,
    line_total REAL DEFAULT 0,
    selling_price REAL DEFAULT 0,
    batch_no TEXT,
    expiry_date DATE,
    FOREIGN KEY (purchase_id) REFERENCES purchases(id) ON DELETE CASCADE,
    FOREIGN KEY (product_id) REFERENCES products(id)
  );

  -- 7. INVOICES (With ZATCA Phase 2, ICV, PIH, Signed XML)
  CREATE TABLE IF NOT EXISTS invoices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    invoice_no TEXT UNIQUE NOT NULL,
    invoice_uuid TEXT UNIQUE,
    invoice_type TEXT DEFAULT 'simplified',
    invoice_subtype TEXT DEFAULT '0200000',
    is_return INTEGER DEFAULT 0,
    return_ref_no TEXT,
    party_id INTEGER,
    customer_name TEXT,
    customer_phone TEXT,
    customer_vat TEXT,
    customer_cr TEXT,
    customer_address TEXT,
    invoice_date TEXT,
    invoice_time TEXT,
    subtotal REAL NOT NULL,
    vat_amount REAL NOT NULL,
    total_amount REAL NOT NULL,
    payment_method TEXT DEFAULT 'CASH',
    paid_cash REAL DEFAULT 0,
    paid_bank REAL DEFAULT 0,
    paid_credit REAL DEFAULT 0,
    change_amount REAL DEFAULT 0,
    prev_balance REAL DEFAULT 0,
    net_balance REAL DEFAULT 0,
    zatca_qr TEXT,
    notes TEXT,
    icv INTEGER DEFAULT 1,
    pih TEXT,
    zatca_hash TEXT,
    zatca_signature TEXT,
    zatca_xml TEXT,
    zatca_status TEXT DEFAULT 'PENDING',
    zatca_errors TEXT,
    zatca_warnings TEXT,
    reported_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (party_id) REFERENCES parties(id)
  );

  -- 8. INVOICE ITEMS
  CREATE TABLE IF NOT EXISTS invoice_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    invoice_id INTEGER NOT NULL,
    product_id INTEGER,
    item_code TEXT,
    barcode TEXT,
    name_en TEXT NOT NULL,
    name_ar TEXT,
    unit TEXT DEFAULT 'PCS',
    cost_price REAL DEFAULT 0,
    selling_price REAL NOT NULL,
    quantity REAL NOT NULL,
    discount_amount REAL DEFAULT 0.00,
    vat_rate REAL DEFAULT 15.00,
    vat_amount REAL NOT NULL,
    line_total REAL NOT NULL,
    batch_no TEXT,
    expiry_date DATE,
    FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE CASCADE,
    FOREIGN KEY (product_id) REFERENCES products(id)
  );

  -- 9. CASHIER SHIFTS
  CREATE TABLE IF NOT EXISTS cashier_shifts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cashier_name TEXT DEFAULT 'Cashier',
    opened_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    closed_at DATETIME,
    opening_cash REAL DEFAULT 0.00,
    expected_cash REAL DEFAULT 0.00,
    actual_cash REAL DEFAULT 0.00,
    difference REAL DEFAULT 0.00,
    status TEXT DEFAULT 'OPEN'
  );

  -- 10. PARTY LEDGER
  CREATE TABLE IF NOT EXISTS ledger (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    party_id INTEGER NOT NULL,
    entry_date TEXT,
    entry_type TEXT,
    reference_no TEXT,
    description TEXT,
    debit REAL DEFAULT 0.00,
    credit REAL DEFAULT 0.00,
    balance_after REAL NOT NULL,
    payment_mode TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (party_id) REFERENCES parties(id)
  );

  -- 11. EMPLOYEES & PAYROLL
  CREATE TABLE IF NOT EXISTS employees (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name_en TEXT NOT NULL,
    name_ar TEXT,
    phone TEXT NOT NULL,
    iqama_no TEXT,
    iqama_expiry TEXT,
    baladiya_expiry TEXT,
    joining_date TEXT,
    monthly_salary REAL DEFAULT 0.00,
    opening_balance REAL DEFAULT 0.00,
    current_balance REAL DEFAULT 0.00,
    last_accrual_date TEXT,
    status TEXT DEFAULT 'active',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS employee_ledger (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_id INTEGER NOT NULL,
    entry_date TEXT,
    entry_type TEXT,
    description TEXT,
    debit REAL DEFAULT 0.00,
    credit REAL DEFAULT 0.00,
    balance_after REAL NOT NULL,
    payment_mode TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (employee_id) REFERENCES employees(id)
  );

  -- 12. UTILITIES
  CREATE TABLE IF NOT EXISTS utilities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name_en TEXT NOT NULL,
    name_ar TEXT,
    category TEXT DEFAULT 'GENERAL',
    account_no TEXT,
    current_due REAL DEFAULT 0.00,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS utility_transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    utility_id INTEGER NOT NULL,
    entry_date TEXT,
    type TEXT,
    amount REAL DEFAULT 0.00,
    payment_mode TEXT,
    description TEXT,
    balance_after REAL NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (utility_id) REFERENCES utilities(id)
  );

  -- 13. PETTY EXPENSES
  CREATE TABLE IF NOT EXISTS petty_categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name_en TEXT NOT NULL,
    name_ar TEXT,
    icon TEXT DEFAULT '🏷️',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS petty_expenses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    expense_date TEXT,
    category TEXT NOT NULL,
    amount REAL NOT NULL,
    payment_mode TEXT DEFAULT 'CASH',
    description TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- 14. ACCOUNT TRANSACTIONS
  CREATE TABLE IF NOT EXISTS account_transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entry_date TEXT,
    account_type TEXT CHECK(account_type IN ('CASH', 'BANK')),
    flow TEXT CHECK(flow IN ('IN', 'OUT')),
    amount REAL NOT NULL,
    category TEXT,
    reference_id INTEGER,
    reference_no TEXT,
    description TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

function addColumnIfNotExists(table, column, definition) {
  try {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
    if (!cols.includes(column)) {
      db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`).run();
    }
  } catch (e) {}
}

addColumnIfNotExists('settings', 'bank_name', "TEXT DEFAULT ''");
addColumnIfNotExists('settings', 'account_number', "TEXT DEFAULT ''");
addColumnIfNotExists('settings', 'iban', "TEXT DEFAULT ''");
addColumnIfNotExists('settings', 'server_port', "INTEGER DEFAULT 5050");
addColumnIfNotExists('settings', 'zatca_certificate', 'TEXT');
addColumnIfNotExists('settings', 'zatca_public_key', 'TEXT');

addColumnIfNotExists('invoices', 'invoice_uuid', 'TEXT');
addColumnIfNotExists('invoices', 'invoice_subtype', "TEXT DEFAULT '0200000'");
addColumnIfNotExists('invoices', 'icv', 'INTEGER DEFAULT 1');
addColumnIfNotExists('invoices', 'pih', 'TEXT');
addColumnIfNotExists('invoices', 'zatca_signature', 'TEXT');
addColumnIfNotExists('invoices', 'zatca_xml', 'TEXT');
addColumnIfNotExists('invoices', 'zatca_errors', 'TEXT');
addColumnIfNotExists('invoices', 'zatca_warnings', 'TEXT');

addColumnIfNotExists('products', 'wholesale_unit', "TEXT DEFAULT 'BOX'");
addColumnIfNotExists('products', 'wholesale_unit_size', 'REAL DEFAULT 1.00');
addColumnIfNotExists('products', 'wholesale_price', 'REAL DEFAULT 0.00');
addColumnIfNotExists('products', 'batch_no', 'TEXT');
addColumnIfNotExists('products', 'expiry_date', 'DATE');

try {
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_products_barcode1 ON products(barcode1);
    CREATE INDEX IF NOT EXISTS idx_products_barcode2 ON products(barcode2);
    CREATE INDEX IF NOT EXISTS idx_products_barcode3 ON products(barcode3);
    CREATE INDEX IF NOT EXISTS idx_products_item_code ON products(item_code);
    CREATE INDEX IF NOT EXISTS idx_invoices_no ON invoices(invoice_no);
    CREATE INDEX IF NOT EXISTS idx_invoices_date ON invoices(invoice_date);
    CREATE INDEX IF NOT EXISTS idx_invoices_icv ON invoices(icv);
  `);
} catch (e) {}


// =========================================================================
// SUPABASE CLOUD SYNC TRACKING COLUMNS & TRIGGERS
// =========================================================================
const syncTables = [
  'products', 'parties', 'purchases', 'invoices', 
  'ledger', 'employees', 'employee_ledger', 
  'utilities', 'utility_transactions', 'petty_expenses', 
  'account_transactions', 'cashier_shifts'
];

syncTables.forEach(tbl => {
  addColumnIfNotExists(tbl, 'is_synced', 'INTEGER DEFAULT 0');
  addColumnIfNotExists(tbl, 'source_device', "TEXT DEFAULT 'PC'");
});

// Automatically mark rows as unsynced (is_synced = 0) when updated on local PC
const triggerTables = ['products', 'parties', 'invoices', 'purchases'];
triggerTables.forEach(tbl => {
  try {
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS trg_${tbl}_unsync_after_update
      AFTER UPDATE ON ${tbl}
      FOR EACH ROW
      WHEN NEW.is_synced = OLD.is_synced AND NEW.is_synced = 1
      BEGIN
        UPDATE ${tbl} SET is_synced = 0 WHERE id = NEW.id;
      END;
    `);
  } catch (e) {}
});

console.log('Database connected: data/pos.db ready.');
module.exports = db;
