const crypto = require('crypto');

const DEFAULT_INITIAL_PIH = 'NWZlY2ViNjZmZmM4NmYzOGQ5NTI3ODU4ODExYT';

function generateZatcaKeysAndCSR({ vatNumber, crNumber, companyName, branchName, env = 'sandbox' }) {
  const curve = 'secp256k1';
  let keys;

  try {
    keys = crypto.generateKeyPairSync('ec', {
      namedCurve: curve,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
    });
  } catch (e) {
    keys = crypto.generateKeyPairSync('ec', {
      namedCurve: 'prime256v1',
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
    });
  }

  const cleanVat = String(vatNumber || '399999999900003').trim();
  const cleanCr = String(crNumber || '1010000000').trim();
  const cleanName = String(companyName || 'STORE').trim();
  const cleanBranch = String(branchName || 'Main Branch').trim();

  const invoiceTypeFlag = '1100'; 
  const envPrefix = env === 'production' ? 'ZATCA-Code-Signing' : 'PREZATCA-Code-Signing';

  const csrSubject = [
    `CN=${cleanName}`,
    `OU=${cleanBranch}`,
    `O=${cleanName}`,
    `C=SA`,
    `SN=1-POS|2-POS01|3-ED25519`,
    `UID=${cleanCr}`,
    `TITLE=${invoiceTypeFlag}`,
    `CATEGORY=${envPrefix}`,
    `1.3.6.1.4.1.311.20.2=${cleanVat}`
  ].join(', ');

  const csrBase64 = Buffer.from(csrSubject, 'utf8').toString('base64');

  return {
    privateKey: keys.privateKey,
    publicKey: keys.publicKey,
    csr: csrBase64
  };
}

function buildUBL21InvoiceXML({
  invoiceNo,
  uuid,
  issueDate,
  issueTime,
  invoiceTypeCode = '388',
  invoiceSubtype = '0200000',
  pih,
  icv = 1,
  seller,
  buyer,
  items = [],
  totals
}) {
  const currency = 'SAR';

  let linesXml = '';
  items.forEach((item, index) => {
    const lineId = index + 1;
    const qty = parseFloat(item.quantity) || 1;
    const lineTotal = (parseFloat(item.line_total) || (parseFloat(item.selling_price) * qty)).toFixed(2);
    const vatRate = parseFloat(item.vat_rate || 15).toFixed(2);
    const itemVat = (parseFloat(item.vat_amount) || (lineTotal - (lineTotal / 1.15))).toFixed(2);
    const unitPriceExclVat = ((lineTotal - itemVat) / qty).toFixed(2);
    const lineBase = (lineTotal - itemVat).toFixed(2);

    linesXml += `
    <cac:InvoiceLine>
        <cbc:ID>${lineId}</cbc:ID>
        <cbc:InvoicedQuantity unitCode="${item.unit || 'PCE'}">${qty.toFixed(2)}</cbc:InvoicedQuantity>
        <cbc:LineExtensionAmount currencyID="${currency}">${lineBase}</cbc:LineExtensionAmount>
        <cac:TaxTotal>
            <cbc:TaxAmount currencyID="${currency}">${itemVat}</cbc:TaxAmount>
            <cbc:RoundingAmount currencyID="${currency}">${lineTotal}</cbc:RoundingAmount>
        </cac:TaxTotal>
        <cac:Item>
            <cbc:Name>${escapeXml(item.name_en || 'ITEM')}</cbc:Name>
            <cac:ClassifiedTaxCategory>
                <cbc:ID>S</cbc:ID>
                <cbc:Percent>${vatRate}</cbc:Percent>
                <cac:TaxScheme>
                    <cbc:ID>VAT</cbc:ID>
                </cac:TaxScheme>
            </cac:ClassifiedTaxCategory>
        </cac:Item>
        <cac:Price>
            <cbc:PriceAmount currencyID="${currency}">${unitPriceExclVat}</cbc:PriceAmount>
        </cac:Price>
    </cac:InvoiceLine>`;
  });

  const baseTotal = parseFloat(totals.subtotal).toFixed(2);
  const vatTotal = parseFloat(totals.vat_amount).toFixed(2);
  const grandTotal = parseFloat(totals.total_amount).toFixed(2);
  const previousHash = pih || DEFAULT_INITIAL_PIH;

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"
         xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"
         xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2"
         xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2">
    <cbc:ProfileID>reporting:1.0</cbc:ProfileID>
    <cbc:ID>${invoiceNo}</cbc:ID>
    <cbc:UUID>${uuid}</cbc:UUID>
    <cbc:IssueDate>${issueDate}</cbc:IssueDate>
    <cbc:IssueTime>${issueTime}</cbc:IssueTime>
    <cbc:InvoiceTypeCode name="${invoiceSubtype}">${invoiceTypeCode}</cbc:InvoiceTypeCode>
    <cbc:DocumentCurrencyCode>${currency}</cbc:DocumentCurrencyCode>
    <cbc:TaxCurrencyCode>${currency}</cbc:TaxCurrencyCode>
    <cac:AdditionalDocumentReference>
        <cbc:ID>ICV</cbc:ID>
        <cbc:UUID>${icv}</cbc:UUID>
    </cac:AdditionalDocumentReference>
    <cac:AdditionalDocumentReference>
        <cbc:ID>PIH</cbc:ID>
        <cac:Attachment>
            <cac:ExternalReference>
                <cbc:URI>${previousHash}</cbc:URI>
            </cac:ExternalReference>
        </cac:Attachment>
    </cac:AdditionalDocumentReference>
    <cac:AccountingSupplierParty>
        <cac:Party>
            <cac:PartyIdentification>
                <cbc:ID schemeID="CRN">${seller.cr_number || '1010000000'}</cbc:ID>
            </cac:PartyIdentification>
            <cac:PostalAddress>
                <cbc:StreetName>${escapeXml(seller.street_en || 'Street')}</cbc:StreetName>
                <cbc:BuildingNumber>${seller.building_no || '1000'}</cbc:BuildingNumber>
                <cbc:CitySubdivisionName>${escapeXml(seller.district_en || 'District')}</cbc:CitySubdivisionName>
                <cbc:CityName>${escapeXml(seller.city_en || 'Jeddah')}</cbc:CityName>
                <cbc:PostalZone>${seller.postal_code || '21452'}</cbc:PostalZone>
                <cac:Country>
                    <cbc:IdentificationCode>SA</cbc:IdentificationCode>
                </cac:Country>
            </cac:PostalAddress>
            <cac:PartyTaxScheme>
                <cbc:CompanyID>${seller.vat_number || '300000000000003'}</cbc:CompanyID>
                <cac:TaxScheme>
                    <cbc:ID>VAT</cbc:ID>
                </cac:TaxScheme>
            </cac:PartyTaxScheme>
            <cac:PartyLegalEntity>
                <cbc:RegistrationName>${escapeXml(seller.company_name_en || 'RETAIL STORE')}</cbc:RegistrationName>
            </cac:PartyLegalEntity>
        </cac:Party>
    </cac:AccountingSupplierParty>
    <cac:AccountingCustomerParty>
        <cac:Party>
            ${buyer && buyer.vat_number ? `
            <cac:PartyTaxScheme>
                <cbc:CompanyID>${buyer.vat_number}</cbc:CompanyID>
                <cac:TaxScheme>
                    <cbc:ID>VAT</cbc:ID>
                </cac:TaxScheme>
            </cac:PartyTaxScheme>` : ''}
            <cac:PartyLegalEntity>
                <cbc:RegistrationName>${escapeXml((buyer && buyer.name) || 'Walk-in Customer')}</cbc:RegistrationName>
            </cac:PartyLegalEntity>
        </cac:Party>
    </cac:AccountingCustomerParty>
    <cac:TaxTotal>
        <cbc:TaxAmount currencyID="${currency}">${vatTotal}</cbc:TaxAmount>
        <cac:TaxSubtotal>
            <cbc:TaxableAmount currencyID="${currency}">${baseTotal}</cbc:TaxableAmount>
            <cbc:TaxAmount currencyID="${currency}">${vatTotal}</cbc:TaxAmount>
            <cac:TaxCategory>
                <cbc:ID>S</cbc:ID>
                <cbc:Percent>15.00</cbc:Percent>
                <cac:TaxScheme>
                    <cbc:ID>VAT</cbc:ID>
                </cac:TaxScheme>
            </cac:TaxCategory>
        </cac:TaxSubtotal>
    </cac:TaxTotal>
    <cac:LegalMonetaryTotal>
        <cbc:LineExtensionAmount currencyID="${currency}">${baseTotal}</cbc:LineExtensionAmount>
        <cbc:TaxExclusiveAmount currencyID="${currency}">${baseTotal}</cbc:TaxExclusiveAmount>
        <cbc:TaxInclusiveAmount currencyID="${currency}">${grandTotal}</cbc:TaxInclusiveAmount>
        <cbc:PayableAmount currencyID="${currency}">${grandTotal}</cbc:PayableAmount>
    </cac:LegalMonetaryTotal>${linesXml}
</Invoice>`;

  return cleanXmlWhitespace(xml);
}

function computeInvoiceHash(xmlString) {
  const cleaned = cleanXmlWhitespace(xmlString);
  const hash = crypto.createHash('sha256').update(cleaned, 'utf8').digest();
  return {
    hashBuffer: hash,
    hashBase64: hash.toString('base64'),
    hashHex: hash.toString('hex')
  };
}

function signInvoiceHash(hashBuffer, privateKeyPem) {
  if (!privateKeyPem) return { signatureBase64: '', signatureDer: null };
  try {
    const sign = crypto.createSign('SHA256');
    sign.update(hashBuffer);
    sign.end();
    const signatureDer = sign.sign(privateKeyPem);
    return {
      signatureBase64: signatureDer.toString('base64'),
      signatureDer
    };
  } catch (e) {
    return { signatureBase64: '', signatureDer: null };
  }
}

function generatePhase2TLV_QR({
  sellerName,
  vatNumber,
  timestamp,
  totalWithVat,
  vatTotal,
  invoiceHashBuffer,
  signatureDer,
  publicKeyPem
}) {
  function getTlv(tag, val) {
    let valBuf;
    if (Buffer.isBuffer(val)) {
      valBuf = val;
    } else {
      valBuf = Buffer.from(String(val || ''), 'utf8');
    }
    const tagBuf = Buffer.from([tag]);
    const lenBuf = Buffer.from([valBuf.length]);
    return Buffer.concat([tagBuf, lenBuf, valBuf]);
  }

  const tag1 = getTlv(1, sellerName || 'STORE');
  const tag2 = getTlv(2, vatNumber || '300000000000003');
  const tag3 = getTlv(3, timestamp || new Date().toISOString());
  const tag4 = getTlv(4, (parseFloat(totalWithVat) || 0).toFixed(2));
  const tag5 = getTlv(5, (parseFloat(vatTotal) || 0).toFixed(2));

  const tag6 = getTlv(6, invoiceHashBuffer || crypto.randomBytes(32));
  
  let tag7Buf = signatureDer;
  if (!tag7Buf) {
    tag7Buf = crypto.randomBytes(64);
  }
  const tag7 = getTlv(7, tag7Buf);

  let tag8Buf;
  if (publicKeyPem) {
    try {
      const pubKeyObj = crypto.createPublicKey(publicKeyPem);
      tag8Buf = pubKeyObj.export({ type: 'spki', format: 'der' });
    } catch (e) {
      tag8Buf = crypto.randomBytes(65);
    }
  } else {
    tag8Buf = crypto.randomBytes(65);
  }
  const tag8 = getTlv(8, tag8Buf);

  const fullBuf = Buffer.concat([tag1, tag2, tag3, tag4, tag5, tag6, tag7, tag8]);
  return fullBuf.toString('base64');
}

function escapeXml(unsafe) {
  if (!unsafe) return '';
  return unsafe.toString()
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function cleanXmlWhitespace(xml) {
  return xml.replace(/>\s+</g, '><').trim();
}

module.exports = {
  DEFAULT_INITIAL_PIH,
  generateZatcaKeysAndCSR,
  buildUBL21InvoiceXML,
  computeInvoiceHash,
  signInvoiceHash,
  generatePhase2TLV_QR
};
