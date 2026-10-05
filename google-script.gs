/*************************************************************
 * Returns Pricing System - Google Apps Script backend
 * ------------------------------------------------------------
 * THIS IS THE OPTIONAL WRITE PATH ONLY.
 *   Reading is done by the front-end through the public gviz endpoint
 *   (docs.google.com/spreadsheets/d/<id>/gviz/tq), loaded as a <script>:
 *   no API key, no Cloud project, and a <script> tag is not subject to CORS
 *   so it works cross-origin from a page on GitHub Pages. Apps Script's
 *   ContentService cannot be made to send CORS headers, so reading through
 *   here needed a JSONP hack that broke whenever the deployment was not
 *   public. Reading no longer goes through here at all.
 *
 *   If you would rather not publish a web app, skip this file entirely:
 *   the dashboard's "copy for pasting" button exports the same values as
 *   tab-separated text you can paste into the Returns sheet by hand.
 *
 * WHAT THIS DOES
 *   doPost() -> accepts { action:'update', updates:[...] } and writes
 *               Calculated_Value + Status back into the "Returns" sheet
 *   doGet()  -> still implemented, and still the same shape as before, as a
 *               convenience endpoint for scripts and debugging. The web app
 *               does not call it any more.
 *
 * HOW TO INSTALL
 *   1. Open your Google Sheet.
 *   2. Extensions > Apps Script.
 *   3. Delete the placeholder "myFunction" code, paste this whole file in.
 *   4. Save (Ctrl+S), then run setupSheets once from the dropdown and
 *      authorise when prompted (it creates the Sales / Returns tabs).
 *   5. Deploy > New deployment > type "Web app".
 *        - Execute as:      Me
 *        - Who has access:  Anyone            <-- IMPORTANT, see README
 *   6. Copy the Web app URL. It ends with /exec, e.g.
 *        https://script.google.com/macros/s/AKfycbXXXXXXXX/exec
 *   7. Paste that URL into the app's Settings page, write section, and
 *      press "Save write settings".
 *
 * NOTE ON CORS (the POST)
 *   Apps Script's ContentService does not let you set response headers, so
 *   we cannot literally "add CORS headers" the way you would in a normal
 *   server. Instead we avoid needing them: the POST is sent with
 *   `Content-Type: text/plain`, making it a CORS "simple request" so the
 *   browser never sends a preflight OPTIONS request that Apps Script cannot
 *   answer. The JSON body still arrives intact in doPost().
 *************************************************************/


/* -----------------------------------------------------------------
 * Configuration
 * ----------------------------------------------------------------- */

var CONFIG = {
  SALES_SHEET: 'Sales',
  RETURNS_SHEET: 'Returns',

  // These are the *English* header names of the user's own sheet, in her
  // order. setupSheets() only writes them when a tab is new or empty, so an
  // existing sheet is never re-headed; headerMap_() below matches by name, so
  // order does not matter to anything that reads it.
  SALES_HEADERS: ['Sales order', 'Customer account', 'CSName', 'Date',
                  'Item', 'Name', 'Size', 'Color', 'Item group', 'Unit',
                  'Unit_Price', 'Quantity', 'Amount'],
  RETURNS_HEADERS: ['Sales order', 'Customer account', 'CSName',
                    'Item', 'Name', 'Size', 'Color', 'Item group', 'Unit',
                    'Quantity', 'Unit_Price', 'Calculated_Value', 'Status'],

  // What applyUpdates_ needs to *find* on the Returns tab, which is a different
  // question from what the tab is *called*. Return_ID is not part of the user's
  // Returns layout, so pointing the write path at RETURNS_HEADERS broke it the
  // moment the layout changed. Keep the two lists separate.
  WRITE_FIELDS: ['Return_ID', 'Unit_Price', 'Calculated_Value', 'Status'],

  LOCK_TIMEOUT_MS: 30000, // concurrent-writer guard
  MAX_UPDATE_ROWS: 2000   // sanity limit per doPost call
};

/**
 * Status written to the sheet once a return has been priced.
 *
 * Arabic, because the sheet is read by people. It must match STATUS_PRICED in
 * app.js exactly: the front-end treats these two spellings as the same state,
 * so a mismatch would make every re-run re-price every row.
 */
var STATUS_PRICED = 'تم التسعير';


/* -----------------------------------------------------------------
 * HTTP entry points
 * ----------------------------------------------------------------- */

/**
 * doGet - read data out of the spreadsheet.
 *
 * Query parameters (all optional):
 *   callback  - name of a global JS function; when present we reply with
 *               JSONP, which is the bulletproof way to read this from a
 *               page served from GitHub Pages.
 *   action    - 'ping' returns a tiny health payload without touching
 *               the sheets. Handy for the "Test Connection" button.
 *
 * @param {GoogleAppsScript.Events.DoGet} e
 * @return {!GoogleAppsScript.HTML.HtmlOutput|string} JSON or JSONP.
 */
function doGet(e) {
  var params = (e && e.parameter) || {};
  var callback = params.callback || '';

  try {
    if (params.action === 'ping') {
      return respond_({
        ok: true,
        message: 'pong',
        serverTime: new Date().toISOString(),
        scriptVersion: '1.0.0'
      }, callback);
    }

    return respond_(readEverything_(), callback);
  } catch (err) {
    return respond_({
      ok: false,
      error: describeError_(err)
    }, callback);
  }
}

/**
 * doPost - write data back into the "Returns" sheet.
 *
 * Accepted bodies (JSON, sent by the app as text/plain):
 *
 *   { action:'update',
 *     updates:[ { Return_ID:'R-1', Calculated_Value: 129.9, Status:'Priced' },
 *               ... ] }
 *
 *   { action:'update', Return_ID:'R-1', Calculated_Value:129.9, Status:'Priced' }
 *      // single-row shorthand
 *
 *   { action:'setup' }   // create/overwrite the header rows
 *
 * Reply: { ok, action, updated, updatedIds, notFound, serverTime }
 *
 * @param {GoogleAppsScript.Events.DoPost} e
 * @return {!GoogleAppsScript.HTML.HtmlOutput}
 */
function doPost(e) {
  var body = {};

  try {
    body = parseBody_(e);
    var action = String(body.action || 'update');

    if (action === 'setup') {
      return respond_(setupSheets(true));
    }

    if (action !== 'update') {
      return respond_({ ok: false, error: 'Unknown action: ' + action });
    }

    var updates = normaliseUpdates_(body);
    if (!updates.length) {
      return respond_({ ok: false, error: 'No rows to update.' });
    }
    if (updates.length > CONFIG.MAX_UPDATE_ROWS) {
      return respond_({
        ok: false,
        error: 'Too many rows in one request (' + updates.length +
               '). Max is ' + CONFIG.MAX_UPDATE_ROWS + '.'
      });
    }

    return respond_(applyUpdates_(updates));
  } catch (err) {
    return respond_({ ok: false, error: describeError_(err) });
  }
}


/* -----------------------------------------------------------------
 * Request / response plumbing
 * ----------------------------------------------------------------- */

/**
 * parseBody_ - pull the payload out of a doPost event.
 *
 * We accept three shapes so the script is forgiving if you test it by
 * hand (curl / Postman):
 *   1. raw JSON            Content-Type: text/plain   -> e.postData.contents
 *   2. form field "payload" with the JSON as a string
 *   3. plain form fields   Return_ID=...&Calculated_Value=...
 *
 * @param {!GoogleAppsScript.Events.DoPost} e
 * @return {!Object}
 */
function parseBody_(e) {
  if (!e) return {};

  var raw = (e.postData && e.postData.contents) || '';
  if (raw) {
    try {
      return JSON.parse(raw);
    } catch (err) {
      // Not JSON - fall through to the form-field route below.
      if (e.parameter && (e.parameter.payload || e.parameter.Return_ID)) {
        return e.parameter;
      }
      throw new Error('Request body was not valid JSON.');
    }
  }

  if (e.parameter) {
    if (e.parameter.payload) return JSON.parse(e.parameter.payload);
    if (e.parameter.Return_ID) return e.parameter;
  }

  return {};
}

/**
 * respond_ - wrap a payload in a ContentService response.
 * If `callback` is a sane JS identifier we emit JSONP instead of JSON.
 *
 * @param {!Object} payload
 * @param {string=} callback
 * @return {!GoogleAppsScript.HTML.HtmlOutput}
 */
function respond_(payload, callback) {
  payload.serverTime = new Date().toISOString();

  var output = ContentService.createTextOutput(
    callback ? wrapJsonp_(callback, payload) : JSON.stringify(payload)
  );

  // setMimeType is what makes the browser treat this as JSON. The charset
  // suffix is required, otherwise fetch() decodes the bytes as Latin-1
  // and any non-ASCII characters in your SKUs get mangled.
  output.setMimeType(
    callback
      ? ContentService.MimeType.JAVASCRIPT
      : ContentService.MimeType.JSON + ';charset=utf-8'
  );

  return output;
}

/**
 * wrapJsonp_ - "cb(payload);"
 * The callback name is validated against a strict identifier pattern so a
 * crafted request can never inject arbitrary script into the response.
 *
 * @param {string} callback
 * @param {!Object} payload
 * @return {string}
 */
function wrapJsonp_(callback, payload) {
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(callback)) {
    throw new Error('Invalid JSONP callback name.');
  }
  return callback + '(' + JSON.stringify(payload) + ');';
}

/**
 * describeError_ - turn anything throwable into a short readable string.
 * @param {*} err
 * @return {string}
 */
function describeError_(err) {
  if (!err) return 'Unknown error.';
  if (err.message) return err.message;
  return String(err);
}


/* -----------------------------------------------------------------
 * Reading
 * ----------------------------------------------------------------- */

/**
 * readEverything_ - the payload behind the app's "Fetch Data" button.
 * @return {!Object}
 */
function readEverything_() {
  return {
    ok: true,
    sales: readSheet_(CONFIG.SALES_SHEET, CONFIG.SALES_HEADERS),
    returns: readSheet_(CONFIG.RETURNS_SHEET, CONFIG.RETURNS_HEADERS),
    counts: {
      sales: null,
      returns: null
    }
  };
}

/**
 * readSheet_ - read a tab into an array of objects keyed by header name.
 *
 * Blank rows are skipped. Missing optional tabs/columns degrade to an
 * empty array rather than blowing up the whole response.
 *
 * @param {string} sheetName
 * @param {!Array<string>} expectedHeaders
 * @return {!Array<!Object>}
 */
function readSheet_(sheetName, expectedHeaders) {
  var sheet = getSheet_(sheetName);
  if (!sheet) return [];

  var values = sheet.getDataRange().getValues();
  if (values.length < 2) return [];

  var index = headerMap_(values[0], expectedHeaders);
  var out = [];

  for (var r = 1; r < values.length; r++) {
    var row = values[r];
    // A row that is entirely empty should not become a phantom return.
    if (isBlankRow_(row)) continue;

    var record = {};
    for (var name in index) {
      if (!index.hasOwnProperty(name)) continue;
      record[name] = row[index[name]];
    }
    record.__row = r + 1; // 1-based sheet row, handy for debugging
    out.push(record);
  }

  return out;
}

/**
 * headerMap_ - map logical field name -> column index, by header text.
 *
 * Matching is case- and whitespace-insensitive so "order id" in the sheet
 * still binds to Order_ID in the code. Columns are optional: anything the
 * sheet does not have simply never appears in the result objects.
 *
 * @param {!Array<*>} headerRow
 * @param {!Array<string>} expectedHeaders
 * @return {!Object<string, number>}
 */
function headerMap_(headerRow, expectedHeaders) {
  var map = {};
  if (!headerRow) return map;

  for (var c = 0; c < headerRow.length; c++) {
    var label = normalise_(headerRow[c]);
    if (!label) continue;
    map[label] = c;
  }

  var result = {};
  for (var i = 0; i < expectedHeaders.length; i++) {
    var key = normalise_(expectedHeaders[i]);
    if (map.hasOwnProperty(key)) result[expectedHeaders[i]] = map[key];
  }
  return result;
}

/**
 * Invisible-but-real characters: bidi marks, zero-width spaces, BOMs.
 *
 * Written as escapes on purpose. The same class pasted as literal characters
 * into a source file is invisible to the next reader and to every diff, so it
 * would be deleted by accident and the bug would come back with no trace.
 * U+200C (ZWNJ) and U+200D (ZWJ) are excluded on purpose: they mean something
 * inside Arabic words.
 */
var INVISIBLE_RE_ = /[\u00AD\u00A0\u200B\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;

/**
 * normalise_ - squashed, lower-cased header form used for column matching.
 *
 * The bidi marks are the reason this function exists in this shape. A header
 * typed in an RTL-aware editor picks up a leading U+200E, and `String.trim()`
 * does NOT remove it (it is a format character, not whitespace), so "‎Sales
 * order" would never match "Sales order" and the column would silently go
 * missing. U+200C and U+200D are deliberately left alone: they carry meaning
 * inside Arabic words.
 *
 * @param {*} v
 * @return {string}
 */
function normalise_(v) {
  if (v === null || v === undefined) return '';
  return String(v)
    .replace(INVISIBLE_RE_, '')
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '');
}


/* -----------------------------------------------------------------
 * Writing
 * ----------------------------------------------------------------- */

/**
 * normaliseUpdates_ - coerce the incoming payload into a clean array of
 * { Return_ID, Calculated_Value, Status }, accepting either the batch or
 * the single-row shape.
 *
 * @param {!Object} body
 * @return {!Array<!Object>}
 */
function normaliseUpdates_(body) {
  var raw = body.updates;
  if (!raw && body.Return_ID) raw = [body];
  if (!raw || !raw.length) return [];

  var out = [];
  for (var i = 0; i < raw.length; i++) {
    var u = raw[i] || {};
    var id = cleanText_(u.Return_ID || u.return_id || u.returnId);
    if (!id) continue; // nothing to key on - skip

    out.push({
      Return_ID: id,
      // Optional: the front-end sends it, but an older caller may not.
      Unit_Price: toNumber_(u.Unit_Price !== undefined
        ? u.Unit_Price
        : (u.unit_price !== undefined ? u.unit_price : u.price)),
      Calculated_Value: toNumber_(u.Calculated_Value !== undefined
        ? u.Calculated_Value
        : (u.calculated_value !== undefined ? u.calculated_value : u.value)),
      Status: cleanText_(u.Status || u.status) || STATUS_PRICED
    });
  }
  return out;
}

/**
 * applyUpdates_ - write Calculated_Value + Status into the Returns tab.
 *
 * Uses a script lock so two people pressing "Execute" at the same moment
 * cannot interleave reads and writes. Writes are grouped into contiguous
 * row ranges and pushed with setValues() - one round trip per block
 * instead of two per row.
 *
 * @param {!Array<!Object>} updates
 * @return {!Object}
 */
function applyUpdates_(updates) {
  var lock = LockService.getScriptLock();
  lock.waitLock(CONFIG.LOCK_TIMEOUT_MS);

  try {
    var sheet = getSheet_(CONFIG.RETURNS_SHEET);
    if (!sheet) {
      return { ok: false, error: 'Sheet "' + CONFIG.RETURNS_SHEET + '" not found.' };
    }

    var headerIndex = headerMap_(
      sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0],
      CONFIG.WRITE_FIELDS
    );

    var idCol = headerIndex.Return_ID;
    var priceCol = headerIndex.Unit_Price;
    var valueCol = headerIndex.Calculated_Value;
    var statusCol = headerIndex.Status;

    if (idCol === undefined) {
      return { ok: false, error: 'Returns sheet is missing the Return_ID column.' };
    }
    if (valueCol === undefined || statusCol === undefined) {
      return { ok: false, error: 'Returns sheet is missing Calculated_Value or Status column.' };
    }

    // Pass 1: build Return_ID -> row number (one linear scan).
    var lastRow = sheet.getLastRow();
    var ids = sheet.getRange(2, idCol + 1, Math.max(lastRow - 1, 1), 1).getValues();
    var rowById = {};
    for (var r = 0; r < ids.length; r++) {
      var key = cleanText_(ids[r][0]);
      if (key && !rowById.hasOwnProperty(key)) rowById[key] = r + 2;
    }

    // Pass 2: turn the updates into located write operations.
    var writes = [];
    var notFound = [];
    var updatedIds = [];

    for (var i = 0; i < updates.length; i++) {
      var u = updates[i];
      if (!rowById.hasOwnProperty(u.Return_ID)) {
        notFound.push(u.Return_ID);
        continue;
      }
      writes.push({
        row: rowById[u.Return_ID],
        price: u.Unit_Price === null ? undefined : u.Unit_Price,
        value: u.Calculated_Value,
        status: u.Status,
        id: u.Return_ID
      });
    }

    // Pass 3: flush contiguous blocks.
    var block = [];
    var updated = 0;

    for (var w = 0; w < writes.length; w++) {
      if (block.length && writes[w].row !== block[block.length - 1].row + 1) {
        flushBlock_(sheet, block, priceCol, valueCol, statusCol);
        updated += block.length;
        block = [];
      }
      block.push(writes[w]);
    }
    if (block.length) {
      flushBlock_(sheet, block, priceCol, valueCol, statusCol);
      updated += block.length;
    }

    for (var k = 0; k < writes.length; k++) updatedIds.push(writes[k].id);

    return {
      ok: true,
      action: 'update',
      updated: updated,
      updatedIds: updatedIds,
      notFound: notFound,
      requested: updates.length
    };
  } finally {
    lock.releaseLock();
  }
}

/**
 * flushBlock_ - write one contiguous run of rows.
 *
 * Unit_Price is optional: a sheet laid out without it still gets its
 * Calculated_Value and Status written, because a partial write is better than
 * refusing the whole batch over one missing column.
 *
 * @param {!GoogleApps.Spreadsheet.SpreadsheetSheet} sheet
 * @param {!Array<!Object>} block rows known to be contiguous & ascending
 * @param {number|undefined} priceCol 0-based column of Unit_Price
 * @param {number} valueCol 0-based column of Calculated_Value
 * @param {number} statusCol 0-based column of Status
 */
function flushBlock_(sheet, block, priceCol, valueCol, statusCol) {
  var first = block[0].row;
  var last = block[block.length - 1].row;
  var height = last - first + 1;

  var prices = [];
  var values = [];
  var statuses = [];
  for (var i = 0; i < block.length; i++) {
    prices.push([block[i].price === undefined ? '' : block[i].price]);
    values.push([block[i].value]);
    statuses.push([block[i].status]);
  }

  if (priceCol !== undefined) {
    sheet.getRange(first, priceCol + 1, height, 1).setValues(prices);
  }
  sheet.getRange(first, valueCol + 1, height, 1).setValues(values);
  sheet.getRange(first, statusCol + 1, height, 1).setValues(statuses);
}


/* -----------------------------------------------------------------
 * Setup helpers (also exposed as the `setupSheets` menu action)
 * ----------------------------------------------------------------- */

/**
 * setupSheets - create the Sales and Returns tabs with header rows if they
 * are missing, and seed a couple of demo rows on a brand new sheet.
 *
 * Run it once from the Apps Script editor dropdown (or POST {action:'setup'}).
 * Existing data is never touched unless `forceHeaders` is true.
 *
 * @param {boolean=} forceHeaders overwrite the header row
 * @return {!Object}
 */
function setupSheets(forceHeaders) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var created = [];

  created.push(ensureSheet_(ss, CONFIG.SALES_SHEET, CONFIG.SALES_HEADERS, forceHeaders));
  created.push(ensureSheet_(ss, CONFIG.RETURNS_SHEET, CONFIG.RETURNS_HEADERS, forceHeaders));

  // Seed demo data only on a completely empty Returns tab. The rows have to be
  // exactly RETURNS_HEADERS.length wide or setValues() throws, so they are
  // built from the header list rather than typed out by hand.
  var returnsSheet = ss.getSheetByName(CONFIG.RETURNS_SHEET);
  if (returnsSheet && returnsSheet.getLastRow() < 2) {
    var demoReturns = [
      ['SO-5001', 'CUST-001', 'عميل تجريبي', 'SKU-RED-01', 'قميص أحمر', '', 'أحمر', 'ملابس', 'قطعة', 2],
      ['SO-5002', 'CUST-002', 'عميل تجريبي', 'SKU-BLU-02', 'قميص أزرق', '', 'أزرق', 'ملابس', 'قطعة', 1],
      ['SO-5003', 'CUST-003', 'عميل تجريبي', 'SKU-GRN-03', 'بنطال أخضر', '', 'أخضر', 'ملابس', 'قطعة', 3]
    ];
    returnsSheet.getRange(2, 1, demoReturns.length, CONFIG.RETURNS_HEADERS.length)
      .setValues(padRows_(demoReturns, CONFIG.RETURNS_HEADERS.length));
  }

  var salesSheet = ss.getSheetByName(CONFIG.SALES_SHEET);
  if (salesSheet && salesSheet.getLastRow() < 2) {
    var demoSales = [
      ['SO-5001', 'CUST-001', 'عميل تجريبي', '2026-01-05', 'SKU-RED-01', 'قميص أحمر', '', 'أحمر', 'ملابس', 'قطعة', 24.5, 5, 122.5],
      ['SO-5002', 'CUST-002', 'عميل تجريبي', '2026-01-06', 'SKU-BLU-02', 'قميص أزرق', '', 'أزرق', 'ملابس', 'قطعة', 89.99, 1, 89.99],
      ['SO-5003', 'CUST-003', 'عميل تجريبي', '2026-01-07', 'SKU-GRN-03', 'بنطال أخضر', '', 'أخضر', 'ملابس', 'قطعة', 12, 4, 48]
    ];
    salesSheet.getRange(2, 1, demoSales.length, CONFIG.SALES_HEADERS.length)
      .setValues(padRows_(demoSales, CONFIG.SALES_HEADERS.length));
  }

  SpreadsheetApp.flush();

  return {
    ok: true,
    action: 'setup',
    message: 'Sheets ready: ' + created.join(', '),
    spreadsheetUrl: ss.getUrl()
  };
}

/**
 * padRows_ - right-pad every row with '' until it is `width` wide.
 *
 * setValues() throws "value must match number of columns" if even one row is
 * short, so demo data is written from the header length rather than by hand.
 *
 * @param {!Array<!Array<*>>} rows
 * @param {number} width
 * @return {!Array<!Array<*>>}
 */
function padRows_(rows, width) {
  return rows.map(function (row) {
    var copy = row.slice(0, width);
    while (copy.length < width) copy.push('');
    return copy;
  });
}

/**
 * onOpen - adds a convenience menu to the spreadsheet UI.
 * @param {!GoogleAppsScript.Events.OnOpen} e
 */
function onOpen(e) {
  SpreadsheetApp.getUi()
    .createMenu('Returns Pricing System')
    .addItem('1. Create / repair sheets', 'setupSheets')
    .addSeparator()
    .addItem('Show web app URL', 'showWebAppUrl')
    .addToUi();
}

/** Prints the currently active deployment URL into a note cell. */
function showWebAppUrl() {
  var url = ScriptApp.getService().getUrl();
  SpreadsheetApp.getActiveSpreadsheet()
    .toast(url || 'No deployment yet - use Deploy > New deployment > Web app.',
           'Web app URL', 120);
}

/**
 * ensureSheet_ - get or create a tab and put the header row in place.
 * @param {!GoogleApps.Spreadsheet.Spreadsheet} ss
 * @param {string} name
 * @param {!Array<string>} headers
 * @param {boolean=} force
 * @return {string} a human readable note
 */
function ensureSheet_(ss, name, headers, force) {
  var sheet = ss.getSheetByName(name);
  var note;

  if (!sheet) {
    sheet = ss.insertSheet(name);
    note = 'created "' + name + '"';
  } else {
    note = 'using "' + name + '"';
  }

  var current = sheet.getRange(1, 1, 1, Math.max(sheet.getLastColumn(), 1)).getValues()[0];
  var hasHeader = current.some(function (cell) { return cleanText_(cell) !== ''; });

  if (force || !hasHeader) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    // Bold the header so the sheet is readable.
    sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold');
    if (note.indexOf('header') === -1) note += ' + header row';
  }

  return note;
}

/**
 * getSheet_ - safely fetch a sheet by name.
 * @param {string} name
 * @return {?GoogleApps.Spreadsheet.SpreadsheetSheet}
 */
function getSheet_(name) {
  return SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
}


/* -----------------------------------------------------------------
 * Small utilities
 * ----------------------------------------------------------------- */

/** @param {*} v @return {string} */
function cleanText_(v) {
  if (v === null || v === undefined) return '';
  return String(v).trim();
}

/**
 * toNumber_ - coerce to a finite number, or null when unusable.
 * Strips currency symbols and thousands separators so "1,299.00" works.
 * @param {*} v
 * @return {?number}
 */
function toNumber_(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return isFinite(v) ? v : null;

  var cleaned = String(v).replace(/[^0-9.\-]/g, '');
  if (!cleaned) return null;

  var n = Number(cleaned);
  return isFinite(n) ? n : null;
}

/** @param {!Array<*>} row @return {boolean} true when every cell is empty. */
function isBlankRow_(row) {
  for (var i = 0; i < row.length; i++) {
    if (cleanText_(row[i]) !== '') return false;
  }
  return true;
}