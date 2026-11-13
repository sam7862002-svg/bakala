const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');
const db = require('./db');
const zatcaCrypto = require('./zatca_crypto');

let supabase = null;
let currentUrl = '';
let currentKey = '';
let isSyncing = false;

function initSupabase() {
  try {
    const settings = db.prepare("SELECT supabase_url, supabase_key FROM settings WHERE id = 1").get();
    if (!settings || !settings.supabase_url || !settings.supabase_key) {
      return false;
    }
    const url = settings.supabase_url.trim();
    const key = settings.supabase_key.trim();
    if (url !== currentUrl || key !== currentKey || !supabase) {
      supabase = createClient(url, key, {
        auth: { persistSession: false }
      });
      currentUrl = url;
      currentKey = key;
      console.log('[Supabase Sync] Initialized client for:', url);
    }
    return true;
  } catch (err) {
    console.error('[Supabase Sync] Init Error:', err.message);
    return false;
  }
}

function cleanRowForSupabase(row, omitCols = ['is_synced']) {
  const cleaned = {};
  for (const [k, v] of Object.entries(row)) {
    if (!omitCols.includes(k)) {
      cleaned[k] = v === '' ? null : v;
    }
  }
  return cleaned;
}

async function syncSettings() {
  const row = db.prepare("SELECT * FROM settings WHERE id = 1").get();
  if (!row) return;
  const payload = cleanRowForSupabase(row, ['is_synced', 'zatca_private_key', 'zatca_secret']);
  const { error } = await supabase.from('settings').upsert(payload, { onConflict: 'id' });
  if (error) console.error('[Supabase Sync] Settings Warning:', error.message);
}

async function syncMasterTable(tableName, conflictCol = 'id') {
  const unsynced = db.prepare(`SELECT * FROM ${tableName} WHERE is_synced = 0 OR is_synced IS NULL LIMIT 100`).all();
  if (unsynced.length === 0) return;

  const payloads = unsynced.map(r => {
    const clean = cleanRowForSupabase(r, ['is_synced']);
    clean.is_synced = 1;
    clean.source_device = r.source_device || 'PC';
    return clean;
  });

  const { error } = await supabase.from(tableName).upsert(payloads, { onConflict: conflictCol });
  if (error) throw new Error(`${tableName} Sync: ` + error.message);

  const markStmt = db.prepare(`UPDATE ${tableName} SET is_synced = 1 WHERE id = ?`);
  const tx = db.transaction((rows) => {
    for (const r of rows) markStmt.run(r.id);
  });
  tx(unsynced);
  console.log(`[Supabase Sync] Pushed ${unsynced.length} rows to ${tableName}`);
}

async function syncInvoices() {
  const unsynced = db.prepare("SELECT * FROM invoices WHERE is_synced = 0 OR is_synced IS NULL LIMIT 50").all();
  if (unsynced.length === 0) return;

  for (const inv of unsynced) {
    const cleanInv = cleanRowForSupabase(inv, ['id', 'is_synced']);
    cleanInv.is_synced = 1;
    cleanInv.source_device = inv.source_device || 'PC';

    const { data: upsertedInv, error: invErr } = await supabase
      .from('invoices')
      .upsert(cleanInv, { onConflict: 'invoice_no' })
      .select('id')
      .single();

    if (invErr) throw new Error('Invoice Sync (' + inv.invoice_no + '): ' + invErr.message);

    const items = db.prepare("SELECT * FROM invoice_items WHERE invoice_id = ?").all(inv.id);
    if (items.length > 0 && upsertedInv) {
      await supabase.from('invoice_items').delete().eq('invoice_id', upsertedInv.id);
      const cleanItems = items.map(it => {
        const c = cleanRowForSupabase(it, ['id', 'invoice_id', 'is_synced']);
        c.invoice_id = upsertedInv.id;
        c.is_synced = 1;
        c.source_device = inv.source_device || 'PC';
        return c;
      });
      const { error: itemErr } = await supabase.from('invoice_items').insert(cleanItems);
      if (itemErr) throw new Error('Invoice Items Sync: ' + itemErr.message);
    }

    db.prepare("UPDATE invoices SET is_synced = 1 WHERE id = ?").run(inv.id);
  }
  console.log(`[Supabase Sync] Pushed ${unsynced.length} invoices`);
}

async function syncPurchases() {
  const unsynced = db.prepare("SELECT * FROM purchases WHERE is_synced = 0 OR is_synced IS NULL LIMIT 50").all();
  if (unsynced.length === 0) return;

  for (const pur of unsynced) {
    const cleanPur = cleanRowForSupabase(pur, ['id', 'is_synced']);
    cleanPur.is_synced = 1;
    cleanPur.source_device = pur.source_device || 'PC';
    const conflictKey = pur.purchase_no ? 'purchase_no' : 'id';

    const { data: upsertedPur, error: purErr } = await supabase
      .from('purchases')
      .upsert(cleanPur, { onConflict: conflictKey })
      .select('id')
      .single();

    if (purErr) throw new Error('Purchase Sync: ' + purErr.message);

    const items = db.prepare("SELECT * FROM purchase_items WHERE purchase_id = ?").all(pur.id);
    if (items.length > 0 && upsertedPur) {
      await supabase.from('purchase_items').delete().eq('purchase_id', upsertedPur.id);
      const cleanItems = items.map(it => {
        const c = cleanRowForSupabase(it, ['id', 'purchase_id', 'is_synced']);
        c.purchase_id = upsertedPur.id;
        c.is_synced = 1;
        return c;
      });
      const { error: itemErr } = await supabase.from('purchase_items').insert(cleanItems);
      if (itemErr) throw new Error('Purchase Items Sync: ' + itemErr.message);
    }

    db.prepare("UPDATE purchases SET is_synced = 1 WHERE id = ?").run(pur.id);
  }
  console.log(`[Supabase Sync] Pushed ${unsynced.length} purchases`);
}

async function syncLedgerAndLogs() {
  const simpleTables = [
    'ledger', 'employees', 'employee_ledger',
    'utilities', 'utility_transactions',
    'petty_expenses', 'account_transactions', 'cashier_shifts'
  ];

  for (const tbl of simpleTables) {
    try {
      const unsynced = db.prepare(`SELECT * FROM ${tbl} WHERE is_synced = 0 OR is_synced IS NULL LIMIT 100`).all();
      if (unsynced.length === 0) continue;

      const payloads = unsynced.map(r => {
        const c = cleanRowForSupabase(r, ['is_synced']);
        c.is_synced = 1;
        return c;
      });
      const { error } = await supabase.from(tbl).upsert(payloads, { onConflict: 'id' });
      if (error) continue;

      const stmt = db.prepare(`UPDATE ${tbl} SET is_synced = 1 WHERE id = ?`);
      const tx = db.transaction((rows) => {
        for (const r of rows) stmt.run(r.id);
      });
      tx(unsynced);
      console.log(`[Supabase Sync] Pushed ${unsynced.length} rows to ${tbl}`);
    } catch (e) {}
  }
}

// Safely pull Mobile Invoices (and generate full ZATCA Phase 2 UBL 2.1 XML + Hash + PIH Chain), Purchases & Ledger
async function pullMobileTransactions() {
  try {
    const settings = db.prepare("SELECT * FROM settings WHERE id = 1").get() || {};

    // 1. Pull Mobile Invoices
    const { data: mobInvoices, error: invErr } = await supabase
      .from('invoices')
      .select('*')
      .eq('source_device', 'MOBILE')
      .order('id', { ascending: true })
      .limit(50);

    if (invErr) throw new Error('Fetch Mobile Invoices: ' + invErr.message);

    if (mobInvoices && mobInvoices.length > 0) {
      for (const mInv of mobInvoices) {
        const exists = db.prepare("SELECT id FROM invoices WHERE invoice_no = ?").get(mInv.invoice_no);
        if (!exists) {
          const { data: mItems } = await supabase.from('invoice_items').select('*').eq('invoice_id', mInv.id);
          const itemsList = mItems || [];

          // Build ZATCA Phase 2 Compliant UBL 2.1 XML, ICV, PIH Chain & Cryptographic Signature
          const lastZatcaInv = db.prepare("SELECT icv, zatca_hash FROM invoices WHERE zatca_hash IS NOT NULL ORDER BY id DESC LIMIT 1").get();
          const nextIcv = lastZatcaInv && lastZatcaInv.icv ? (parseInt(lastZatcaInv.icv, 10) + 1) : 1;
          const prevHash = (lastZatcaInv && lastZatcaInv.zatca_hash) ? lastZatcaInv.zatca_hash : zatcaCrypto.DEFAULT_INITIAL_PIH;
          const invUuid = mInv.invoice_uuid || crypto.randomUUID();
          const isB2B = !!(mInv.customer_vat && String(mInv.customer_vat).trim().length === 15);
          const invTypeCode = mInv.is_return ? '381' : '388';
          const invSubtype = isB2B ? '0100000' : '0200000';

          const xmlString = zatcaCrypto.buildUBL21InvoiceXML({
            invoiceNo: mInv.invoice_no,
            uuid: invUuid,
            issueDate: mInv.invoice_date,
            issueTime: mInv.invoice_time || '12:00:00',
            invoiceTypeCode: invTypeCode,
            invoiceSubtype: invSubtype,
            pih: prevHash,
            icv: nextIcv,
            seller: settings,
            buyer: {
              name: mInv.customer_name || 'Walk-in Customer',
              vat_number: mInv.customer_vat || ''
            },
            items: itemsList,
            totals: {
              subtotal: mInv.subtotal || 0,
              vat_amount: mInv.vat_amount || 0,
              total_amount: mInv.total_amount || 0
            }
          });

          const { hashBuffer, hashBase64 } = zatcaCrypto.computeInvoiceHash(xmlString);
          const { signatureDer } = zatcaCrypto.signInvoiceHash(hashBuffer, settings.zatca_private_key);
          const phase2Qr = zatcaCrypto.generatePhase2TLV_QR({
            sellerName: settings.company_name_en || 'STORE',
            vatNumber: settings.vat_number || '300000000000003',
            timestamp: `${mInv.invoice_date}T${mInv.invoice_time || '12:00:00'}Z`,
            totalWithVat: mInv.total_amount || 0,
            vatTotal: mInv.vat_amount || 0,
            invoiceHashBuffer: hashBuffer,
            signatureDer,
            publicKeyPem: settings.zatca_public_key
          });

          // Insert into local SQLite with ZATCA Phase 2 metadata
          const res = db.prepare(`
            INSERT INTO invoices (
              invoice_no, invoice_uuid, invoice_type, is_return, party_id,
              customer_name, customer_phone, customer_vat,
              invoice_date, invoice_time, subtotal, vat_amount, total_amount,
              payment_method, paid_cash, paid_bank, paid_credit,
              icv, zatca_hash, zatca_xml, zatca_qr, zatca_status,
              is_synced, source_device
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', 1, 'MOBILE')
          `).run(
            mInv.invoice_no,
            invUuid,
            isB2B ? 'standard' : 'simplified',
            mInv.is_return || 0,
            mInv.party_id || null,
            mInv.customer_name || 'Walk-in Customer',
            mInv.customer_phone || '',
            mInv.customer_vat || '',
            mInv.invoice_date,
            mInv.invoice_time || '12:00:00',
            mInv.subtotal || 0,
            mInv.vat_amount || 0,
            mInv.total_amount || 0,
            mInv.payment_method || 'CASH',
            mInv.paid_cash || 0,
            mInv.paid_bank || 0,
            mInv.paid_credit || 0,
            nextIcv,
            hashBase64,
            xmlString,
            phase2Qr
          );

          const localInvId = res.lastInsertRowid;

          if (itemsList.length > 0) {
            const insItem = db.prepare(`
              INSERT INTO invoice_items (
                invoice_id, product_id, barcode, name_en, name_ar,
                unit, cost_price, selling_price, quantity, vat_amount, line_total
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `);
            const updStock = db.prepare("UPDATE products SET stock_quantity = COALESCE(stock_quantity, 0) - ?, is_synced = 1 WHERE id = ?");

            for (const it of itemsList) {
              insItem.run(
                localInvId,
                it.product_id || null,
                it.barcode || '',
                it.name_en || '',
                it.name_ar || '',
                it.unit || 'PCS',
                it.cost_price || 0,
                it.selling_price || 0,
                it.quantity || 1,
                it.vat_amount || 0,
                it.line_total || 0
              );
              if (it.product_id) {
                const qtyDelta = mInv.is_return ? -Math.abs(it.quantity) : Math.abs(it.quantity);
                updStock.run(qtyDelta, it.product_id);
              }
            }
          }

          if (mInv.party_id && mInv.paid_credit > 0) {
            const balDelta = mInv.is_return ? -Math.abs(mInv.paid_credit) : Math.abs(mInv.paid_credit);
            db.prepare("UPDATE parties SET current_balance = COALESCE(current_balance, 0) + ?, is_synced = 1 WHERE id = ?")
              .run(balDelta, mInv.party_id);
          }

          await supabase.from('invoices').update({
            is_synced: 1,
            zatca_qr: phase2Qr
          }).eq('id', mInv.id);

          console.log(`[Supabase Sync] Pulled & ZATCA-Signed Mobile Invoice: ${mInv.invoice_no} (ICV: ${nextIcv})`);
        }
      }
    }

    // 2. Pull Mobile Purchases
    const { data: mobPurchases, error: purErr } = await supabase
      .from('purchases')
      .select('*')
      .eq('source_device', 'MOBILE')
      .order('id', { ascending: false })
      .limit(30);

    if (!purErr && mobPurchases && mobPurchases.length > 0) {
      for (const mPur of mobPurchases) {
        const exists = db.prepare("SELECT id FROM purchases WHERE purchase_no = ?").get(mPur.purchase_no);
        if (!exists) {
          const { data: pItems } = await supabase.from('purchase_items').select('*').eq('purchase_id', mPur.id);

          const res = db.prepare(`
            INSERT INTO purchases (
              purchase_no, supplier_inv_no, party_id, vendor_name, purchase_date,
              subtotal, vat_amount, total_amount, payment_method,
              paid_cash, paid_credit, is_synced, source_device
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'MOBILE')
          `).run(
            mPur.purchase_no,
            mPur.supplier_inv_no || '',
            mPur.party_id || null,
            mPur.vendor_name || 'Vendor',
            mPur.purchase_date,
            mPur.subtotal || 0,
            mPur.vat_amount || 0,
            mPur.total_amount || 0,
            mPur.payment_method || 'CREDIT',
            mPur.paid_cash || 0,
            mPur.paid_credit || 0
          );

          const localPurId = res.lastInsertRowid;

          if (pItems && pItems.length > 0) {
            const insItem = db.prepare(`
              INSERT INTO purchase_items (
                purchase_id, product_id, barcode, name_en, quantity, cost_price, line_total
              ) VALUES (?, ?, ?, ?, ?, ?, ?)
            `);
            const updStock = db.prepare("UPDATE products SET stock_quantity = COALESCE(stock_quantity, 0) + ?, cost_price = ?, is_synced = 1 WHERE id = ?");

            for (const it of pItems) {
              insItem.run(
                localPurId,
                it.product_id || null,
                it.barcode || '',
                it.name_en || '',
                it.quantity || 1,
                it.cost_price || 0,
                it.line_total || 0
              );
              if (it.product_id) {
                updStock.run(Math.abs(it.quantity), it.cost_price || 0, it.product_id);
              }
            }
          }

          await supabase.from('purchases').update({ is_synced: 1 }).eq('id', mPur.id);
          console.log('[Supabase Sync] Pulled Mobile Purchase to PC:', mPur.purchase_no);
        }
      }
    }

    // 3. Pull Mobile Ledger Entries (Receipts / Payments)
    const { data: mobLedger } = await supabase
      .from('ledger')
      .select('*')
      .eq('source_device', 'MOBILE')
      .eq('is_synced', 0)
      .limit(30);

    if (mobLedger && mobLedger.length > 0) {
      for (const lg of mobLedger) {
        try {
          db.prepare(`
            INSERT OR IGNORE INTO ledger (
              id, party_id, transaction_date, type, reference_no, debit, credit, balance_after, notes, is_synced, source_device
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'MOBILE')
          `).run(
            lg.id, lg.party_id, lg.transaction_date, lg.type, lg.reference_no,
            lg.debit || 0, lg.credit || 0, lg.balance_after || 0, lg.notes || ''
          );
          if (lg.party_id) {
            db.prepare("UPDATE parties SET current_balance = ?, is_synced = 1 WHERE id = ?").run(lg.balance_after, lg.party_id);
          }
          await supabase.from('ledger').update({ is_synced: 1 }).eq('id', lg.id);
        } catch (e) {}
      }
    }
  } catch (err) {
    console.error('[Supabase Sync] Pull Error:', err.message);
  }
}

async function runSyncCycle() {
  if (isSyncing) return;
  if (!initSupabase()) return;

  isSyncing = true;
  try {
    await syncSettings();
    await syncMasterTable('parties', 'id');
    await syncMasterTable('products', 'id');
    await syncInvoices();
    await syncPurchases();
    await syncLedgerAndLogs();
    await pullMobileTransactions();
  } catch (err) {
    console.error('[Supabase Sync Error]', err.message);
  } finally {
    isSyncing = false;
  }
}

setTimeout(() => {
  runSyncCycle();
  setInterval(runSyncCycle, 15000);
}, 5000);

module.exports = { runSyncCycle };
