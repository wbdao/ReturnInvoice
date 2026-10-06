/* =====================================================================
 * app.js — Returns Pricing System | shared front-end logic
 * =====================================================================
 * A plain ES6 module. No build step, no bundler, no dependencies.
 *
 *   <script type="module" src="./app.js"></script>
 *
 * Both pages import from it:
 *
 *   import { loadConfig, apiFetchData, priceReturns } from './app.js';
 *
 * ---------------------------------------------------------------------
 * HOW THE CROSS-ORIGIN TRANSPORT WORKS  (read before you change anything)
 * ---------------------------------------------------------------------
 * The UI is served from github.io and the data lives in Google Sheets, so
 * every call is cross-origin. Apps Script's ContentService will not let you
 * set custom response headers, so the usual "add CORS headers" fix is not
 * available. We dodge the problem instead:
 *
 *   GET  -> JSONP. A <script> tag is not subject to CORS at all, which
 *           makes this the most reliable read path by a wide margin.
 *
 *   POST -> fetch with `Content-Type: text/plain`. That makes it a CORS
 *           "simple request", so the browser never fires the preflight
 *           OPTIONS request that Apps Script has no handler for. The JSON
 *           body still arrives intact in doPost().
 *
 * apiFetchData() is the single read entry point; there is no fallback, because
 * the gviz endpoint needs no credential at all — only a shared sheet.
 *
 * NOTE: `type="module"` is blocked on file:// URLs. Serve the folder over
 * HTTP when testing locally (`npx serve` or `python -m http.server`).
 * ===================================================================== */

/* ------------------------------------------------------------------ *
 * 1. Constants & configuration storage
 * ------------------------------------------------------------------ */

export const STORAGE_KEY = 'rps.config.v1';

/**
 * Default tab names.
 *
 * Declared before DEFAULTS because it is referenced from there, and `const`
 * sits in its temporal dead zone until these two lines execute.
 */
const SALES_TAB = 'Sales';
const RETURNS_TAB = 'Returns';

export const DEFAULTS = Object.freeze({
  // --- read path: the public gviz endpoint, reached as JSONP --------------
  // Only the share link is needed. No API key, no Cloud project, nothing to
  // rotate — the sheet just has to be shared "anyone with the link".
  spreadsheetId: '',        // from .../spreadsheets/d/<THIS>/edit
  salesRange: SALES_TAB,    // the *tab name*, exactly as shown in Sheets
  returnsRange: RETURNS_TAB,

  // --- write path: still the Apps Script web app -------------------------
  webAppUrl: '',            // the /exec URL of the Apps Script web app
  currency: 'USD',
  batchSize: 50,            // rows per doPost call
  timeoutMs: 20000,         // per-request timeout
});

/** Public, key-less read endpoint. Overridable only for local stubs. */
const GVIZ_ORIGIN = 'https://docs.google.com/spreadsheets/d';

/**
 * The spreadsheet column contract, keyed by a squashed form of the header.
 *
 * These names are shared with google-script.gs, with whatever else reads the
 * sheet, and with the JSON that write-back sends — so they stay English even
 * though the UI is Arabic.
 *
 * The keys are the header squashed to lowercase with separators removed, which
 * is what makes `Returned Qty`, `returned-qty` and `RETURNED_QTY` all resolve.
 * The aliases (`salesorder`, `item`, …) exist because real sheets do not use
 * the canonical names: an order column headed `Sales order` and a product code
 * headed `Item` are extremely common, and refusing to read them would leave the
 * user staring at a table of "no matching sale" errors with no cause given.
 */
const COLUMN_ALIASES = Object.freeze({
  // --- identity -----------------------------------------------------------
  salesorder: 'Order_ID',
  orderid: 'Order_ID',
  orderno: 'Order_ID',

  customeraccount: 'Customer_Account',
  customerno: 'Customer_Account',
  account: 'Customer_Account',
  csname: 'Customer_Name',
  customername: 'Customer_Name',
  clientname: 'Customer_Name',

  item: 'Product_SKU',
  sku: 'Product_SKU',
  productsku: 'Product_SKU',
  productcode: 'Product_SKU',
  itemcode: 'Product_SKU',

  // --- description (carried through to the table and the CSV) -------------
  name: 'Product_Name',
  itemname: 'Product_Name',
  productname: 'Product_Name',
  size: 'Size',
  color: 'Color',
  colour: 'Color',
  itemgroup: 'Item_Group',
  group: 'Item_Group',
  unit: 'Unit',
  uom: 'Unit',

  // --- numbers and outcome ------------------------------------------------
  returnedqty: 'Returned_Qty',
  returnedquantity: 'Returned_Qty',
  unitprice: 'Unit_Price',
  price: 'Unit_Price',
  calculatedvalue: 'Calculated_Value',
  status: 'Status',
});

/**
 * Per-tab overrides for headers that mean different things on each tab.
 *
 * `Quantity` is the trap: on `Sales` it is how many were sold, on `Returns` it
 * is how many came back. Without this the two would collide on one name.
 *
 * Note that the *display* columns keep their sheet spelling on both tabs, so a
 * header that is merely unreadable stays readable instead of being renamed.
 */
const COLUMN_ALIASES_BY_TAB = Object.freeze({
  Sales: Object.freeze({ quantity: 'Quantity', qty: 'Quantity' }),
  Returns: Object.freeze({ quantity: 'Returned_Qty', qty: 'Returned_Qty' }),
});

/**
 * RETURNS_LAYOUT - the Returns tab, column by column, in the user's order.
 *
 * This is the single source of truth for three things that must not drift
 * apart: the table rendered on the dashboard, the CSV handed back to Google
 * Sheets, and the row objects the pricing engine fills in. Each entry carries
 * both the sheet's own header (English, for the CSV) and the Arabic label for
 * the table, because the sheet is a machine contract while the screen is read
 * by a person.
 *
 * `key` is the contract name used inside the app after `canonicalHeader()` has
 * mapped the sheet header onto it.
 *
 * @type {!Array<{key: string, sheet: string, label: string, numeric: boolean}>}
 */
export const RETURNS_LAYOUT = Object.freeze([
  { key: 'Order_ID',         sheet: 'Sales order',       label: 'رقم الطلب',       numeric: false },
  { key: 'Customer_Account', sheet: 'Customer account',  label: 'كود العميل',      numeric: false },
  { key: 'Customer_Name',    sheet: 'CSName',            label: 'اسم العميل',      numeric: false },
  { key: 'Product_SKU',      sheet: 'Item',              label: 'كود الصنف',       numeric: true },
  { key: 'Product_Name',     sheet: 'Name',              label: 'اسم الصنف',       numeric: false },
  { key: 'Size',             sheet: 'Size',              label: 'المقاس',          numeric: false },
  { key: 'Color',            sheet: 'Color',             label: 'اللون',           numeric: false },
  { key: 'Item_Group',       sheet: 'Item group',        label: 'المجموعة',        numeric: false },
  { key: 'Unit',             sheet: 'Unit',              label: 'الوحدة',          numeric: false },
  { key: 'Returned_Qty',     sheet: 'Quantity',          label: 'الكمية المرتجعة', numeric: true },
  { key: 'Unit_Price',       sheet: 'Unit_Price',        label: 'سعر الوحدة',      numeric: true },
  { key: 'Calculated_Value', sheet: 'Calculated_Value', label: 'القيمة الإجمالية', numeric: true },
  { key: 'Status',           sheet: 'Status',            label: 'حالة التسعير',    numeric: false },
].map(Object.freeze));

/**
 * The columns the pricing engine cannot work without.
 *
 * `Product_SKU` + `Customer_Account` form the match key and `Returned_Qty` is the
 * multiplier, so all three are load-bearing. `Order_ID` is **not** here: it is
 * displayed but never searched on, so a Returns tab without it still prices.
 *
 * Everything else in RETURNS_LAYOUT is either decorative (Size, Color) or is
 * written *by* this app (Unit_Price, Calculated_Value, Status), so their
 * absence from the sheet is never a reason to refuse to read it.
 */
const RETURNS_INPUT_COLUMNS = Object.freeze([
  'Product_SKU', 'Customer_Account', 'Returned_Qty',
]);

/**
 * Contract names of the columns that are carried through to the table and the
 * CSV but are not needed for the arithmetic.
 *
 * Their absence is worth a warning — the user is looking at empty cells — but
 * it must never stop a row being priced, and the names here are the *contract*
 * names because that is what missingColumns() compares against.
 */
const DESCRIPTIVE_KEYS = Object.freeze([
  'Order_ID', 'Customer_Name', 'Product_Name',
  'Size', 'Color', 'Item_Group', 'Unit',
]);

/** @return {!Array<{key: string, sheet: string, label: string}>} */
export function returnsLayout() {
  return RETURNS_LAYOUT.slice();
}

/**
 * gvizBase - base for the read path.
 *
 * Read at call time rather than at module load so a local stub can be
 * substituted during development by setting `window.GVIZ_BASE` before
 * the first read. Unset in normal use.
 *
 * @return {string}
 */
function gvizBase() {
  const override = typeof window !== 'undefined' ? window.GVIZ_BASE : '';
  return (override || GVIZ_ORIGIN).replace(/\/+$/, '');
}

/* ------------------------------------------------------------------ *
 * 0. Localisation constants
 * ------------------------------------------------------------------ *
 * The UI is Arabic (RTL) and the sheet is an Arabic-business sheet, so the
 * split is:
 *
 *   - Sheet *headers* -> English. They are a machine contract shared with
 *                      google-script.gs and with anything else that reads
 *                      the spreadsheet (pivot tables, imports, BI tools).
 *   - Sheet *values*  -> Arabic for Status, because the sheet is read by
 *                      people, not only by machines.
 *   - Everything the user reads -> Arabic, translated here at the boundary.
 *
 * `statusLabel()` / `isPriced()` are the only places that bridge the two, and
 * `isPriced()` still accepts the old English "Priced" so a sheet populated by
 * an earlier build of this app is not silently re-priced.
 * ------------------------------------------------------------------ */

/** Formatting locale: Arabic month names, but Latin digits. */
export const LOCALE = 'ar-EG-u-nu-latn';

/** Written to the Returns sheet when the order/item was found and priced. */
export const STATUS_PRICED = 'تم التسعير';

/**
 * Written when there is no matching sale line, or the quantity is unusable.
 *
 * The sheet keeps these rows rather than dropping them: a returns report that
 * silently loses rows is worse than one that flags them, and the user can sort
 * or filter on this value to see exactly what still needs a source order.
 */
export const STATUS_NOT_FOUND = 'صنف / طلب غير موجود';

/** Display labels for the Status column. */
export const STATUS_LABELS = Object.freeze({
  [STATUS_PRICED]: STATUS_PRICED,
  [STATUS_NOT_FOUND]: STATUS_NOT_FOUND,
  Pending: 'قيد الانتظار',
});

/**
 * statusLabel - Arabic text for a Status value.
 *
 * The English "Priced" written by an earlier build reads as priced, matching
 * isPriced(). Anything else unrecognised is shown verbatim, because the user
 * typed it and a generic label would hide what it says.
 *
 * @param {*} value
 * @return {string}
 */
export function statusLabel(value) {
  const raw = String(value ?? '').trim();
  if (!raw || raw.toLowerCase() === 'pending') return STATUS_LABELS.Pending;
  if (isPriced(raw)) return STATUS_PRICED;
  return STATUS_LABELS[raw] || raw;
}

/**
 * isPriced - has this row already been priced?
 *
 * Tolerant on purpose: it accepts the canonical English "Priced" and the
 * Arabic label too, so a sheet that a person typed "تم التسعير" into by hand
 * is still recognised instead of being silently re-priced and re-written.
 *
 * @param {*} value
 * @return {boolean}
 */
export function isPriced(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw) return false;
  // "Priced" is what an earlier build of this app wrote. Sheets populated by
  // that build must keep working, so it stays recognised as priced.
  return raw === STATUS_PRICED.toLowerCase() || raw === 'priced';
}

/** localStorage is unavailable in some private/embedded contexts. */
function safeStorage() {
  try {
    const probe = '__rps_probe__';
    window.localStorage.setItem(probe, '1');
    window.localStorage.removeItem(probe);
    return window.localStorage;
  } catch {
    return null;
  }
}

/**
 * loadConfig - read saved settings, merged over the defaults.
 * @return {!Object}
 */
export function loadConfig() {
  const store = safeStorage();
  let saved = {};

  if (store) {
    try {
      saved = JSON.parse(store.getItem(STORAGE_KEY) || '{}') || {};
    } catch (err) {
      console.warn('[RPS] تعذّرت قراءة الإعدادات المحفوظة، سيتم استخدام القيم الافتراضية.', err);
      saved = {};
    }
  }

  const merged = { ...DEFAULTS, ...stripNullish(saved) };
  merged.hasUrl = Boolean(merged.webAppUrl);
  return merged;
}

/**
 * saveConfig - merge `patch` into the stored settings.
 * @param {!Object} patch
 * @return {{ok: boolean, config: !Object, error: (string|undefined)}}
 */
export function saveConfig(patch) {
  const store = safeStorage();
  const config = { ...loadConfig(), ...stripNullish(patch), hasUrl: undefined };
  delete config.hasUrl;

  if (!store) {
    return { ok: false, config, error: 'التخزين المحلي (localStorage) محجوب في هذا المتصفح.' };
  }

  try {
    store.setItem(STORAGE_KEY, JSON.stringify(config));
    config.hasUrl = Boolean(config.webAppUrl);
    return { ok: true, config };
  } catch (err) {
    return { ok: false, config, error: err.message };
  }
}

/** Wipe saved settings. @return {!Object} the reset config */
export function clearConfig() {
  const store = safeStorage();
  if (store) store.removeItem(STORAGE_KEY);
  return loadConfig();
}

/** Drop keys whose value is null/undefined so they cannot shadow defaults. */
function stripNullish(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) {
    if (v !== null && v !== undefined) out[k] = v;
  }
  return out;
}

/**
 * describeShareLinkProblem - validate the read settings.
 *
 * The whole read path now needs exactly one thing: the share link. There is no
 * API key, no Cloud project and no deployment to configure, so this is a much
 * shorter checklist than the Sheets API needed.
 *
 * Kept separate from describeUrlProblem because they guard different things:
 * the sheet link drives reads, the /exec URL drives writes. A user can
 * perfectly well price and copy rows with no Apps Script deployment at all.
 *
 * @param {!Object} config
 * @return {?string} an error message, or null when the settings look usable
 */
export function describeShareLinkProblem(config) {
  const id = cleanText(config?.spreadsheetId);

  if (!id) {
    return 'لم يتم لصق رابط جدول Google Sheets بعد. انسخ الرابط من شريط عنوان المتصفح (Ctrl+L) والصقه في صفحة الإعدادات.';
  }
  // Accept a whole URL pasted into the stored value too — extractSpreadsheetId
  // handles it, and this only rejects things that cannot become an ID at all.
  if (/[\s/]/.test(id)) {
    return 'رابط الجدول غير صحيح. تأكد أنه يحتوي على الجزء .../spreadsheets/d/<ID>/edit.';
  }
  if (!cleanText(config?.salesRange)) {
    return 'لم يتم تعيين اسم ورقة المبيعات.';
  }
  if (!cleanText(config?.returnsRange)) {
    return 'لم يتم تعيين اسم ورقة المرتجعات.';
  }
  return null;
}

/**
 * describeUrlProblem - validate the web app URL.
 * @param {string} url
 * @return {?string} an error message, or null when the URL looks usable
 */
export function describeUrlProblem(url) {
  const value = String(url || '').trim();
  if (!value) return 'لم يتم تعيين رابط تطبيق الويب بعد.';

  // http:// is only tolerated for loopback, so you can point the app at a
  // local stub while developing. Real Apps Script URLs are always https.
  const isLoopback = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])([:/]|$)/i.test(value);
  if (!/^https:\/\//i.test(value) && !isLoopback) return 'يجب أن يبدأ الرابط بـ https://';

  const looksLikeAppsScript =
    /script\.google\.com\/macros\/s\//i.test(value) ||
    /script\.googleusercontent\.com\//i.test(value) ||
    isLoopback; // a local stub will not look like Apps Script, and that is fine

  if (!looksLikeAppsScript) {
    return 'هذا الرابط لا يشبه رابط تطبيق ويب من Apps Script.';
  }
  if (!isLoopback && !/\/exec(\?|$)/i.test(value)) {
    return 'استخدم رابط النشر المنتهي بـ ‎/exec‎ وليس ‎/dev‎.';
  }
  return null;
}


/* ------------------------------------------------------------------ *
 * 2. Low-level transport
 * ------------------------------------------------------------------ */

/** Monotonic counter so concurrent JSONP calls never collide. */
let jsonpSeq = 0;

/**
 * buildUrl - join a base URL and query params.
 * @param {string} base
 * @param {!Object<string, *>} params
 * @return {string}
 */
export function buildUrl(base, params = {}) {
  const url = new URL(base, window.location.href);
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined || value === '') continue;
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

/**
 * jsonpRequest - GET via a <script> tag. Immune to CORS.
 *
 * @param {string} url
 * @param {!Object<string, *>} params
 * @param {{timeoutMs?: number}} [options]
 * @return {!Promise<*>}
 */
export function jsonpRequest(url, params = {}, { timeoutMs = DEFAULTS.timeoutMs } = {}) {
  return new Promise((resolve, reject) => {
    const callbackName = `__rpsJsonp_${Date.now().toString(36)}_${jsonpSeq++}`;
    const script = document.createElement('script');
    let timer = null;
    let settled = false;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      delete window[callbackName];
      script.remove();
    };

    window[callbackName] = (data) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(data);
    };

    script.onerror = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(
        'فشل طلب JSONP. تأكد من نشر النشر (Deployment) مع ضبط الصلاحية على "أي شخص".'
      ));
    };

    script.src = buildUrl(url, { ...params, callback: callbackName });

    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(`انتهت مهلة الطلب بعد ${timeoutMs} مللي ثانية.`));
    }, timeoutMs);

    document.head.appendChild(script);
  });
}

/**
 * fetchJson - GET via fetch(). Used as the JSONP fallback.
 * @param {string} url
 * @param {{timeoutMs?: number}} [options]
 * @return {!Promise<*>}
 */
export async function fetchJson(url, { timeoutMs = DEFAULTS.timeoutMs } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
    });

    const text = await response.text();
    if (!response.ok) {
      throw new Error(`استجاب الخادم بالحالة ${response.status}.`);
    }
    return JSON.parse(text);
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`انتهت مهلة الطلب بعد ${timeoutMs} مللي ثانية.`);
    }
    if (err instanceof SyntaxError) {
      throw new Error(
        'لم تكن الاستجابة بصيغة JSON. هل الرابط هو رابط النشر ‎/exec‎؟'
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * postJson - POST to Apps Script without triggering a CORS preflight.
 *
 * The body is deliberately sent as text/plain. That content type is on the
 * CORS safelist, so the browser sends the request directly instead of
 * asking for permission first - and Apps Script has no OPTIONS handler.
 *
 * @param {string} url
 * @param {!Object} payload
 * @param {{timeoutMs?: number}} [options]
 * @return {!Promise<*>}
 */
export async function postJson(url, payload, { timeoutMs = DEFAULTS.timeoutMs } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: 'POST',
      redirect: 'follow',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const text = await response.text();

    try {
      return JSON.parse(text);
    } catch {
      // Non-JSON usually means an HTML error/login page came back.
      throw new Error(
        'لم يُرجع الخادم بيانات JSON. تأكد من ضبط النشر على ' +
        '"التنفيذ كـ: أنا" و"من يملك صلاحية الوصول: أي شخص"، وأن الرابط ينتهي بـ ‎/exec‎.'
      );
    }
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`انتهت مهلة الطلب بعد ${timeoutMs} مللي ثانية.`);
    }
    if (err instanceof TypeError) {
      // fetch() reports every network/CORS failure as a bare TypeError.
      throw new Error(
        'خطأ في الشبكة أو CORS. تأكد من ضبط صلاحية الوصول في النشر على ' +
        '"أي شخص" ومن صحة رابط تطبيق الويب.'
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}


/* ------------------------------------------------------------------ *
 * 3. API layer
 * ------------------------------------------------------------------ */

/**
 * gvizRequest - read one tab through the public gviz endpoint, as JSONP.
 *
 * No API key, no Cloud project, no Apps Script deployment — just a sheet that
 * is shared "anyone with the link".
 *
 * Why a <script> tag and not fetch():
 *
 *   gviz answers with `Content-Type: application/javascript` and sends NO
 *   `Access-Control-Allow-Origin` header. fetch() is therefore blocked by the
 *   browser before the body is even readable, no matter how the sheet is
 *   shared. A <script> tag is not subject to CORS at all.
 *
 * Why not the CSV export endpoint, which *does* send `*`? It only accepts a
 * numeric `gid`, and a gid cannot be derived from a share link (the visible
 * `#gid=12345` is a different, per-browser number). So it would put the user
 * back to copying opaque ids by hand.
 *
 * gviz's `responseHandler` option names the function the response calls, so
 * every request gets its own uniquely named callback — exactly like
 * jsonpRequest(). That matters because Sales and Returns are read in parallel:
 * the default handler, `google.visualization.Query.setResponse`, is one global
 * shared by both requests, and whichever response arrived first could be
 * delivered to the other request's promise, silently swapping the two tabs.
 *
 * @param {!Object} config
 * @param {string} tab the tab (sheet) name, e.g. 'Returns'
 * @return {!Promise<!Object>} the gviz payload
 */
function gvizRequest(config, tab) {
  const callbackName = `__rpsGviz_${Date.now().toString(36)}_${jsonpSeq++}`;
  const url = buildUrl(`${gvizBase()}/${encodeURIComponent(cleanText(config.spreadsheetId))}/gviz/tq`, {
    tqx: `out:json;responseHandler:${callbackName}`,
    sheet: cleanText(tab),
    // `tq` is required by gviz even though the defaults are what we want.
    tq: 'select *',
  });

  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    let timer = null;
    let settled = false;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      delete window[callbackName];
      script.remove();
    };

    window[callbackName] = (payload) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(payload);
    };

    script.onerror = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(
        `تعذّر الوصول إلى Google Sheets لقراءة ورقة "${tab}". ` +
        'تأكد أن الرابط يشير إلى جدول حقيقي وأن مشاركة "أي شخص لديه الرابط" مفعّلة.',
      ));
    };

    script.src = url;
    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(`انتهت مهلة قراءة ورقة ${tab} بعد ${config.timeoutMs || DEFAULTS.timeoutMs} مللي ثانية.`));
    }, config.timeoutMs || DEFAULTS.timeoutMs);

    document.head.appendChild(script);
  });
}

/**
 * gvizPayloadToValues - gviz payload to a header row plus value rows.
 *
 * gviz splits the response into `table.cols` (the header row) and `table.rows`
 * (the data), which is the same shape rowsToObjects() expects once stitched
 * back together.
 *
 * Each cell is `{v: <raw value>, f: <display string>}`; only `v` is used,
 * because `f` is localised for the sheet's own locale and would hand back
 * strings like "(1٫00)" instead of numbers.
 *
 * @param {!Object} payload
 * @param {string} tab
 * @return {!Array<!Array<*>>}
 */
export function gvizPayloadToValues(payload, tab = '') {
  if (!payload || payload.status === 'error') throw new Error(gvizPayloadError_(payload, tab));

  const table = payload?.table;
  if (!table) return [];

  const header = (Array.isArray(table.cols) ? table.cols : []).map((c) => (c && c.label) || '');
  if (!header.length) return [];

  const values = [header];
  for (const row of Array.isArray(table.rows) ? table.rows : []) {
    const cells = (row && row.c) || [];
    values.push(header.map((_, i) => {
      const cell = cells[i];
      // A null cell is a genuinely empty spreadsheet cell, not "missing".
      return cell && cell.v !== undefined && cell.v !== null ? cell.v : '';
    }));
  }

  return values;
}

/**
 * gvizPayloadError_ - explain a gviz error response in Arabic.
 *
 * Note what is *not* handled here: a misspelled tab name does not produce an
 * error. gviz silently falls back to the first tab, which would otherwise show
 * the user the wrong data with total confidence. That case is caught in
 * apiFetchDataViaShareLink() by comparing the two responses.
 *
 * @param {?Object} payload
 * @param {string} tab
 * @return {string}
 */
function gvizPayloadError_(payload, tab) {
  const first = (payload && payload.errors && payload.errors[0]) || {};

  switch (first.reason) {
    case 'access_denied':
    case 'permissionDenied':
      return `رُفض الوصول إلى ورقة ${tab}. تأكد أن الجدول مشترك برابط "أي شخص لديه الرابط" (صلاحية محدّث على الأقل).`;
    case 'invalid_query':
    case 'parse_error':
      return `تعذّر قراءة ورقة ${tab}. تحقق من اسم الورقة ومن الرابط.`;
    default:
      return (first.detailed_message || first.message) ||
        `تعذّر قراءة ورقة ${tab} من Google Sheets.`;
  }
}

/**
 * tabSignature_ - a cheap fingerprint of what a tab returned.
 *
 * Used to notice the gviz silent-fallback case, where a mistyped tab name
 * yields the first tab instead of an error.
 *
 * @param {!Array<!Array<*>>} values
 * @return {string}
 */
function tabSignature_(values) {
  const header = (values[0] || []).map((h) => cleanText(h)).join('|');
  return `${values.length}#${header}`;
}

/**
 * rowsToObjects - turn a header row + value rows into objects.
 *
 * Both read paths deliver an array-of-arrays whose first row is the header, so
 * the header row is mapped onto the contract names before anything downstream
 * touches the data.
 *
 * @param {!Array<!Array<*>>} values
 * @param {string} [tab] 'Sales' or 'Returns', to apply that tab's overrides
 * @return {!Array<!Object>}
 */
export function rowsToObjects(values, tab = '') {
  if (!Array.isArray(values) || values.length === 0) return [];

  const header = values[0].map((h) => canonicalHeader(h, tab));
  const rows = [];

  for (let i = 1; i < values.length; i++) {
    const cells = values[i];
    if (!Array.isArray(cells) || cells.length === 0) continue;

    // Skip fully blank rows; the API pads trailing empties inconsistently.
    if (cells.every((c) => cleanText(c) === '')) continue;

    const row = {};
    header.forEach((key, col) => {
      if (key) row[key] = cells[col] ?? '';
    });
    rows.push(row);
  }

  return rows;
}

/**
 * canonicalHeader - map a sheet header cell to the name the code expects.
 *
 * Everything downstream (priceReturns, apiUpdateReturns) reads the exact
 * contract names `Order_ID`, `Returned_Qty` and so on. Unknown headers are
 * passed through untouched rather than dropped, so nothing is silently lost.
 *
 * @param {*} cell
 * @param {string} [tab] 'Sales' or 'Returns', to apply that tab's overrides
 * @return {string}
 */
function canonicalHeader(cell, tab = '') {
  const text = cleanText(cell);
  if (!text) return '';

  const squash = text.toLowerCase().replace(/[\s_\-]+/g, '');
  const overrides = COLUMN_ALIASES_BY_TAB[tab] || null;

  if (overrides && Object.prototype.hasOwnProperty.call(overrides, squash)) {
    return overrides[squash];
  }
  return COLUMN_ALIASES[squash] || text;
}

/** @return {!Set<string>} which contract columns a tab did not provide */
function missingColumns(rows, required) {
  // A tab can legitimately be empty, in which case nothing is missing and the
  // "no rows" message is the useful one instead.
  if (!rows.length) return new Set();

  const present = new Set(Object.keys(rows[0]));
  return new Set(required.filter((name) => !present.has(name)));
}

/**
 * apiFetchDataViaShareLink - read Sales + Returns through the public gviz
 * endpoint using nothing but the share link.
 *
 * @param {!Object} config
 * @return {!Promise<{sales: !Array, returns: !Array, transport: string,
 *                    serverTime: (string|undefined),
 *                    warnings: !Array<string>,
 *                    problems: !Array<string>, notes: !Array<string>}>}
 */
export async function apiFetchDataViaShareLink(config) {
  const salesTab = cleanText(config.salesRange) || SALES_TAB;
  const returnsTab = cleanText(config.returnsRange) || RETURNS_TAB;

  const [salesPayload, returnsPayload] = await Promise.all([
    gvizRequest(config, salesTab),
    gvizRequest(config, returnsTab),
  ]);

  const salesValues = gvizPayloadToValues(salesPayload, salesTab);
  const returnsValues = gvizPayloadToValues(returnsPayload, returnsTab);

  const salesRows = rowsToObjects(salesValues, 'Sales');
  const returnsRows = rowsToObjects(returnsValues, 'Returns');

  const { problems, notes } = describeSchema_(salesRows, returnsRows);

  // gviz does not fail on an unknown tab name — it quietly serves the first
  // tab. That is the one way this transport can hand the user confidently
  // wrong data, so it is checked explicitly rather than assumed impossible.
  if (salesTab !== returnsTab && tabSignature_(salesValues) === tabSignature_(returnsValues)) {
    problems.push(
      `الورقتان "${salesTab}" و "${returnsTab}" أعادتا نفس البيانات. ` +
      'غالباً خطأ في اسم إحدى الورقتين — تحقّق من الأسماء كما هي في شريط تبويبات Google Sheets.',
    );
  }

  return {
    sales: salesRows,
    returns: returnsRows,
    transport: 'share-link',
    serverTime: new Date().toISOString(),

    // Everything worth saying about the read, in one flat list, so existing
    // callers keep working. `problems` is broken out alongside it because it is
    // the only half that means "your sheet is wrong" — see describeSchema_.
    warnings: [...problems, ...notes],
    problems,
    notes,
  };
}

/**
 * describeSchema_ - report columns the app needs but the sheet does not have.
 *
 * Returned as warnings rather than thrown, because a sheet can be perfectly
 * readable and still not fully usable. Failing the whole read would hide data
 * the user can still act on, which is the opposite of helpful.
 *
 * Only the three input columns are treated as required. Unit_Price,
 * Calculated_Value and Status are *outputs* — their absence on first run is the
 * normal state of a fresh sheet, not a fault — and the descriptive columns only
 * affect how complete the table looks.
 *
 * Returned in two lists, because "a column is missing" and "this sheet records
 * negative quantities" are not the same message. Collapsing them into one array
 * made the UI announce missing columns on every run of a perfectly complete
 * sheet, purely because negative quantities were present. `problems` is the
 * actionable half: something is absent and the user may want to fix it.
 *
 * @param {!Array<!Object>} salesRows
 * @param {!Array<!Object>} returnsRows
 * @return {{problems: !Array<string>, notes: !Array<string>}}
 */
function describeSchema_(salesRows, returnsRows) {
  const problems = [];
  const notes = [];

  const missingSales = missingColumns(salesRows, ['Product_SKU', 'Customer_Account', 'Unit_Price']);
  if (missingSales.size) {
    problems.push(
      `ورقة Sales لا تحتوي على: ${[...missingSales].join('، ')}. ` +
      'التسعير يعتمد على Item + Customer account، فبدونهما لن يُعثر على أي سعر.',
    );
  }

  const missingReturns = missingColumns(returnsRows, RETURNS_INPUT_COLUMNS);
  if (missingReturns.size) {
    problems.push(
      `ورقة Returns لا تحتوي على: ${[...missingReturns].join('، ')}. ` +
      'هذه هي الأعمدة الثلاثة التي يحتاجها التسعير — بدونها ستُعتبر كل الصفوف "صنف / طلب غير موجود". ' +
      'عمود Sales order مطلوب للعرض فقط ولا يدخل في البحث عن السعر.',
    );
  }

  // Descriptive columns: the row still prices, it just looks emptier.
  //
  // The check runs on *contract* names (the keys canonicalHeader() produced)
  // while the message reports the *sheet* names (what the user actually has to
  // look for in their own spreadsheet). Passing the sheet names into
  // missingColumns() reports columns that are present as missing, because
  // "Customer account" is not the key "Customer_Account".
  const missingDescriptive = missingColumns(returnsRows, DESCRIPTIVE_KEYS);
  if (missingDescriptive.size) {
    const names = [...missingDescriptive].map(
      (key) => RETURNS_LAYOUT.find((c) => c.key === key)?.sheet || key,
    );
    problems.push(
      `ورقة Returns لا تحتوي على: ${names.join('، ')}. ` +
      'التسعير يعمل بدونها، لكن الجدول سيظهر فارغاً في تلك الأعمدة.',
    );
  }

  // Negative quantities are a convention, not a problem — but silently flipping
  // the sign would be worse than saying so, so report it once for the tab.
  const negativeCount = returnsRows.filter((r) => {
    const n = toNumber(r.Returned_Qty);
    return n !== null && n < 0;
  }).length;

  if (negativeCount > 0) {
    notes.push(
      `${negativeCount} صف في ورقة ${RETURNS_TAB} يسجّل الكمية سالبة. ` +
      'تم احتساب الأسعار بالقيمة المطلقة (‎-2 تساوي 2).',
    );
  }

  return { problems, notes };
}

/**
 * apiFetchData - read Sales + Returns from the spreadsheet.
 *
 * The read path is the public gviz endpoint, reached as JSONP, which needs
 * only the share link. The Apps Script web app is never used for reading, so a
 * deployment that refuses cross-origin requests cannot block pricing.
 *
 * @param {!Object} config
 * @return {!Promise<{sales: !Array, returns: !Array, transport: string,
 *                    serverTime: (string|undefined),
 *                    warnings: !Array<string>,
 *                    problems: !Array<string>, notes: !Array<string>}>}
 */
export async function apiFetchData(config) {
  const problem = describeShareLinkProblem(config);
  if (problem) throw new Error(problem);

  return apiFetchDataViaShareLink(config);
}

/**
 * apiUpdateReturns - push calculated values back to the Returns sheet.
 *
 * Updates are sent in batches so a long run of returns does not become one
 * enormous request (and so a partial failure still lands most of the work).
 *
 * @param {!Object} config
 * @param {!Array<{Return_ID: string, Calculated_Value: number, Status: string}>} updates
 * @param {{onProgress?: function(number, number, !Array)}} [options]
 * @return {!Promise<{ok: boolean, updated: number, notFound: !Array<string>, batches: number}>}
 */
export async function apiUpdateReturns(config, updates, { onProgress } = {}) {
  if (!Array.isArray(updates) || updates.length === 0) {
    return { ok: true, updated: 0, notFound: [], batches: 0 };
  }

  const size = Math.max(1, Number(config.batchSize) || DEFAULTS.batchSize);
  const notFound = [];
  let done = 0;
  let batches = 0;

  for (let i = 0; i < updates.length; i += size) {
    const chunk = updates.slice(i, i + size);
    batches += 1;

    const result = await postJson(
      config.webAppUrl,
      { action: 'update', updates: chunk },
      { timeoutMs: config.timeoutMs },
    );

    if (!result || result.ok !== true) {
      throw new Error((result && result.error) || `تم رفض الدفعة رقم ${batches}.`);
    }

    if (Array.isArray(result.notFound)) {
      notFound.push(...result.notFound);
    }

    done += Number(result.updated) || 0;
    onProgress?.(done, updates.length, result);
  }

  return { ok: true, updated: done, notFound, batches };
}

/**
 * apiPing - cheapest possible round trip, used by "Test Connection".
 *
 * Deliberately pings the *read* path, since that is what "Test Connection"
 * is really asking about. The Apps Script deployment is not contacted here:
 * it is optional, and probing it would produce a false failure for users who
 * only need read + copy.
 *
 * @param {!Object} config
 * @return {!Promise<{ok: boolean, message: string, transport: string}>}
 */
export async function apiPing(config) {
  await gvizRequest(config, cleanText(config.returnsRange) || RETURNS_TAB);
  return { ok: true, message: 'pong', transport: 'share-link' };
}

/**
 * buildReturnsCsv - the Returns tab back as CSV, column for column.
 *
 * The output is the sheet, not a report *about* the sheet: the same thirteen
 * columns in the same order, with the same header names, and one line per
 * return in the order it was read. That is what makes it safe to round-trip —
 * paste it into A1 and every value lands under its own header, no reordering
 * and no leftover half-filled columns.
 *
 * Values are written raw. A unit price is `959.04`, never `‏959.04 US$` and
 * never `959.04 US$` with an RTL mark in front of it: Sheets has to be able to
 * parse the cell as a number, or every downstream formula in the user's sheet
 * silently stops working.
 *
 * @param {!Array<!Object>} rows priced rows from priceReturns()
 * @param {{onlySelected?: boolean, selected?: !Set<number>, header?: boolean}} [options]
 *   onlySelected: export only the ticked rows. Defaults to false — with a
 *   full-width export the useful default is "everything", because an unticked
 *   row silently missing from the file is the worst possible outcome.
 *   header: include the header line. Defaults to true.
 * @return {string}
 */
export function buildReturnsCsv(rows, { onlySelected = false, selected, header = true } = {}) {
  const list = exportRows_(rows, { onlySelected, selected });

  const lines = [];

  if (header) lines.push(RETURNS_LAYOUT.map((c) => csvCell(c.sheet)).join(','));

  for (const row of list) {
    // Skipped rows keep whatever the sheet already held, so re-exporting a
    // partially priced sheet does not wipe the rows it declined to touch.
    lines.push(RETURNS_LAYOUT.map((c) => csvCell(csvValueFor_(row, c.key))).join(','));
  }

  return lines.join('\r\n');
}

/**
 * exportRows_ - the rows an export should contain, shared by every export format.
 *
 * Centralised so CSV, TSV and the HTML table can never drift: if each format
 * filtered its own subset, a row could silently appear in the file and not in
 * the pasted table, which is precisely the comparison the user makes to check
 * the paste worked.
 *
 * @param {!Array<!Object>} rows
 * @param {{onlySelected?: boolean, selected?: !Set<number>}} options
 * @return {!Array<!Object>}
 */
function exportRows_(rows, { onlySelected = false, selected } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  return onlySelected && selected ? list.filter((r) => selected.has(r.index)) : list;
}

/**
 * buildReturnsTsv - the same thirteen columns, tab-separated.
 *
 * This is the plain-text half of "copy as an Excel table". Tab and newline are
 * what a spreadsheet reads as "next column" and "next row", so a value carrying
 * either would shift every column to its right and every row below it. That is
 * the whole reason a CSV cell can hold a newline and a TSV cell cannot, so they
 * are folded to a space here rather than escaped — there is no escape character
 * in this format.
 *
 * Numbers go out as plain digits, never via toLocaleString: a thousands
 * separator would split one number into two columns.
 *
 * Note there is no formula guard here, unlike csvCell(). That is deliberate
 * rather than an oversight: quoting a CSV field is what defuses a leading `=`,
 * and TSV has no quoting. But this flavour is only ever read by a plain-text
 * target — a spreadsheet is handed buildReturnsHtmlTable(), where the value is
 * inside a `<td>` and cannot be parsed as a formula at all. Falsifying a
 * customer's name to defend against a consumer that is never reading it would
 * be a pure loss.
 *
 * @param {!Array<!Object>} rows priced rows from priceReturns()
 * @param {{onlySelected?: boolean, selected?: !Set<number>, header?: boolean}} [options]
 * @return {string}
 */
export function buildReturnsTsv(rows, { onlySelected = false, selected, header = true } = {}) {
  const list = exportRows_(rows, { onlySelected, selected });

  const lines = [];

  if (header) lines.push(RETURNS_LAYOUT.map((c) => tsvCell(c.sheet)).join('\t'));

  for (const row of list) {
    lines.push(RETURNS_LAYOUT.map((c) => tsvCell(csvValueFor_(row, c.key))).join('\t'));
  }

  return lines.join('\r\n');
}

/**
 * tsvCell - one tab-separated field.
 *
 * @param {*} value
 * @return {string}
 */
function tsvCell(value) {
  if (value === null || value === undefined) return '';

  const text = typeof value === 'number' ? String(value) : cleanText(value);

  // Silent, and visible in the output: a product name typed across two lines in
  // the sheet would otherwise push the whole rest of the table out of alignment.
  return text.replace(/[\t\r\n]+/g, ' ');
}

/**
 * buildReturnsHtmlTable - the same thirteen columns as a real HTML `<table>`.
 *
 * This is the flavour a spreadsheet actually reads. Excel, Google Sheets and
 * LibreOffice all prefer `text/html` on the clipboard, so pasting it lands the
 * data in thirteen properly-aligned columns *with* the header row styled —
 * rather than one giant column, which is what pasting CSV text into a sheet
 * produces when the locale separator disagrees with the file.
 *
 * Two properties make it safe to paste, and both matter:
 *   - numbers stay numbers. The cell text is `959.04`, so the sheet parses a
 *     number and the user's formulas keep working. No thousands separator, no
 *     currency symbol, no RTL mark in front of the digits;
 *   - text can never become a formula. A product named `=SUM(A1)` sits inside
 *     a `<td>` as literal characters; the spreadsheet's text importer never sees
 *     the leading `=` as cell input. That is the injection hole the CSV path
 *     closes with quoting, closed here structurally instead.
 *
 * `dir="rtl"` on the table matches the app, and `dir="ltr"` on the numeric cells
 * keeps digits from being reordered when the fragment is rendered in a browser
 * (it has no effect on the spreadsheet import).
 *
 * @param {!Array<!Object>} rows priced rows from priceReturns()
 * @param {{onlySelected?: boolean, selected?: !Set<number>, header?: boolean}} [options]
 * @return {string}
 */
export function buildReturnsHtmlTable(rows, { onlySelected = false, selected, header = true } = {}) {
  const list = exportRows_(rows, { onlySelected, selected });

  // Inline styles only: Excel honours the attributes on a `<td>`, not a
  // stylesheet, and a class would be dropped on paste.
  const TH_BORDER = 'border:1px solid #c7d2fe;background:#eef2ff;font-weight:700;padding:4px 8px;';
  const TD_BORDER = 'border:1px solid #e2e8f0;padding:4px 8px;';
  const FONT = 'font-family:Calibri,Arial,sans-serif;font-size:11pt;';

  const parts = [
    '<table dir="rtl" style="border-collapse:collapse;' + FONT + '">',
  ];

  if (header) {
    parts.push(
      '<thead><tr>' +
      RETURNS_LAYOUT.map((c) =>
        `<th style="${TH_BORDER}">${escapeHtml(c.sheet)}</th>`).join('') +
      '</tr></thead>',
    );
  }

  if (list.length) {
    parts.push('<tbody>');
    for (const row of list) {
      const cells = RETURNS_LAYOUT.map((c) => {
        const value = csvValueFor_(row, c.key);
        // Numeric *and* actually a number: a SKU is numeric in the layout but a
        // product named "007" is not, and must not be read as 7.
        const isNumber = c.numeric && typeof value === 'number' && Number.isFinite(value);
        const text = value === null || value === undefined ? '' : String(value);
        const dir = isNumber ? ' dir="ltr"' : '';
        const style = isNumber ? 'text-align:left;' : '';
        return `<td${dir} style="${TD_BORDER}${style}">${escapeHtml(text)}</td>`;
      }).join('');
      parts.push(`<tr>${cells}</tr>`);
    }
    parts.push('</tbody>');
  }

  parts.push('</table>');
  return parts.join('');
}

/**
 * csvValueFor_ - the raw cell value for one Returns column.
 *
 * Kept separate from csvCell() so the formatting rule (raw, never localised) is
 * stated once and the quoting rule (always, when needed) is stated once.
 *
 * @param {!Object} row
 * @param {string} key
 * @return {*}
 */
function csvValueFor_(row, key) {
  switch (key) {
    // A skipped row was priced by an earlier run; priceReturns() copied the
    // sheet's existing values onto it, so this reports what it already has.
    case 'Unit_Price':
      return row.unitPrice ?? 0;
    case 'Calculated_Value':
      return row.calculatedValue ?? 0;
    case 'Status':
      return row.status || STATUS_NOT_FOUND;

    case 'Order_ID': return row.orderId;
    case 'Customer_Account': return row.customerAccount;
    case 'Customer_Name': return row.customerName;
    case 'Product_SKU': return row.sku;
    case 'Product_Name': return row.productName;
    case 'Size': return row.size;
    case 'Color': return row.color;
    case 'Item_Group': return row.itemGroup;
    case 'Unit': return row.unit;
    case 'Returned_Qty': return row.returnedQty;

    default: return '';
  }
}

/**
 * csvCell - one CSV field, quoted only when it has to be.
 *
 * RFC 4180 quoting, with the two places it actually bites handled explicitly:
 *   - a field containing a comma, a quote or a newline must be quoted;
 *   - the Arabic status and any product name may contain `"`, which has to be
 *     doubled inside the quotes.
 *
 * The BOM is NOT added here. `csvText_()` prepends it at the file boundary,
 * because it belongs to the file, not to every individual field.
 *
 * @param {*} value
 * @return {string}
 */
function csvCell(value) {
  if (value === null || value === undefined) return '';

  // Numbers go out as plain JS numbers, never via toLocaleString: a thousands
  // separator would turn 1250 into "1,250" and Sheets would read that as two
  // columns.
  const text = typeof value === 'number' ? String(value) : cleanText(value);

  if (text === '') return '';

  // A leading =, +, - or @ makes Sheets treat the cell as a formula when the
  // CSV is imported. Numbers are exempt: they are written by us, not typed by
  // a user, so they cannot be an injection, and quoting them would only add
  // noise. Text is the case that matters.
  const needsGuard = typeof value !== 'number' && /^[=+\-@\t\r]/.test(text);
  const needsQuotes = /[",\r\n]/.test(text) || needsGuard;

  if (!needsQuotes) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

/**
 * csvText_ - the complete CSV document, ready to save to a file.
 *
 * The UTF-8 BOM is deliberate. Without it, Sheets on Windows opens an imported
 * Arabic CSV as Latin-1 and every customer name turns into mojibake — which is
 * exactly the kind of damage that is invisible until someone reads the file.
 *
 * @param {string} csv
 * @return {string}
 */
export function csvText_(csv) {
  return `﻿${csv}`;
}


/* ------------------------------------------------------------------ *
 * 4. Normalising raw sheet data
 * ------------------------------------------------------------------ */

/**
 * Characters that are invisible but real: bidirectional marks, zero-width
 * spaces and byte-order marks.
 *
 * These matter more than they look. A sheet typed in an RTL-aware editor
 * routinely ends up with U+200E glued onto the front of a header ("‎Sales
 * order"), which is a *different string* from "Sales order" even though the
 * two look identical in every screenshot. Comparing them naively makes
 * matching fail with no visible reason.
 *
 * Deliberately excluded: U+200C (ZWNJ) and U+200D (ZWJ), which carry meaning
 * inside Arabic words, so they are left alone.
 */
const INVISIBLE_RE = /[\u00A0\u00AD\u200B\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;

/**
 * cleanText - normalise a raw cell value to comparable, displayable text.
 *
 * Strips invisible bidi/zero-width marks, turns non-breaking spaces into real
 * ones, and trims. Does not collapse internal whitespace: that would change
 * how product names render, so it happens in matchKey() instead.
 *
 * @param {*} v
 * @return {string}
 */
export function cleanText(v) {
  if (v === null || v === undefined) return '';
  return String(v).replace(INVISIBLE_RE, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * toNumber - coerce to a finite number, or null.
 * Tolerates "1,299.00", "$24.50", " 12 " and similar.
 * @param {*} v
 * @return {?number}
 */
export function toNumber(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;

  const cleaned = String(v).replace(INVISIBLE_RE, '').replace(/[^0-9.\-]/g, '');
  if (!cleaned) return null;

  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/**
 * toDate - parse a Sales `Date` into a comparable number, or null.
 *
 * Accepts gviz's `Date(y,m,d)` strings, Date objects and ISO-8601 text. Anything unparseable returns null and the line is then
 * treated as undated rather than as the newest one — guessing a date would
 * silently reorder prices.
 *
 * @param {*} v
 * @return {?number} milliseconds, or null
 */
export function toDate(v) {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date) return Number.isFinite(v.getTime()) ? v.getTime() : null;

  const text = cleanText(v);
  if (!text) return null;

  // gviz's JSON output encodes a date cell as "Date(2023,5,12)" or
  // "Date(2023,5,12,14,30,0)", with a 0-based month. Read as UTC, for the same
  // reason as the bare ISO date below.
  const gviz = /^Date\((\d+),(\d+),(\d+)(?:,(\d+),(\d+),(\d+))?\)$/.exec(text.replace(/\s+/g, ''));
  if (gviz) {
    const [, y, m, d, hh = 0, mm = 0, ss = 0] = gviz;
    return Date.UTC(+y, +m, +d, +hh, +mm, +ss);
  }

  // A bare "2023-06-12" is read as UTC midnight. Without the suffix Date parses
  // it as *local* midnight, which shifts the day for anyone east or west of UTC
  // and can reorder two sales on consecutive days.
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  const t = iso ? Date.parse(`${text}T00:00:00Z`) : Date.parse(text);
  return Number.isFinite(t) ? t : null;
}

/**
 * matchKey - the composite lookup key for a sale line.
 *
 * Keyed on **Item + Customer account**. The sales order is deliberately not part
 * of it: a return can be raised against an order the `Sales` tab does not hold,
 * and keying on the order would then find nothing at all even though the same
 * customer demonstrably bought the same item.
 *
 * The cost of that looseness is that one key spans many sales of the same item to
 * the same customer over time — sometimes dozens, at different prices. Which one
 * applies is decided by pickSaleLine() using date and size/colour, not by the key.
 *
 * Case-insensitive, and tolerant of the way identifiers get typed into sheets:
 *
 *   - leading/trailing padding and doubled internal spaces collapse, so
 *     "so000789 " finds "SO000789";
 *   - a leading apostrophe is dropped. It is a spreadsheet artefact — left over
 *     from a paste or an old forced-text marker — not part of the identifier.
 *     Real sheets are inconsistent about it: one tab can hold `SO018842` while
 *     another holds `'SO018842` for the same order, and treating those as
 *     different is the difference between matching and matching nothing;
 *   - a *meaningful* space is kept, so "SO 000789" and "SO000789" stay distinct.
 *
 * @param {*} sku
 * @param {*} customerAccount
 * @return {string}
 */
export function matchKey(sku, customerAccount) {
  const norm = (v) => cleanText(v).toUpperCase()
    .replace(/^['‘’ʻ]+/, '')
    .replace(/\s+/g, ' ');
  return `${norm(sku)}|${norm(customerAccount)}`;
}

/**
 * extractSpreadsheetId - pull the spreadsheet ID out of whatever the user
 * pasted into the settings field.
 *
 * People paste whatever is on their screen, so all of these have to work:
 *
 *   https://docs.google.com/spreadsheets/d/1AbC.../edit?usp=sharing
 *   https://docs.google.com/spreadsheets/d/1AbC.../edit#gid=0
 *   https://docs.google.com/spreadsheets/d/1AbC.../view
 *   docs.google.com/spreadsheets/d/1AbC...
 *   1AbC...
 *
 * @param {*} input
 * @return {string} the ID, or '' when nothing recognisable was pasted
 */
export function extractSpreadsheetId(input) {
  const text = String(input ?? '').replace(INVISIBLE_RE, '').trim();
  if (!text) return '';

  // The canonical location. Anchored on the path segment so a stray ID in a
  // query string cannot be mistaken for the spreadsheet.
  const fromUrl = text.match(/\/spreadsheets\/d\/([A-Za-z0-9_-]+)/);
  if (fromUrl) return fromUrl[1];

  // A bare ID. Google IDs are long, so requiring 20+ characters keeps ordinary
  // words ("Sales", "العملاء") from being accepted as an ID.
  if (/^[A-Za-z0-9_-]{20,}$/.test(text)) return text;

  return '';
}

/**
 * variantKey - normalise the second matching tier: Size and Color.
 *
 * Returns the two fields *separately* rather than as one joined string. Joining
 * them looks tidier and is subtly wrong: a return with a size but no colour would
 * produce "M|", which then fails to equal a sale line's "M|BLACK" — turning a
 * blank into a demand that the other side be blank too. Keeping them apart lets
 * `matchesVariant` decide field by field, so a blank on either side is a
 * wildcard that never blocks a match.
 *
 * Comparison ignores case and punctuation padding. Sheets carry `White`,
 * `white ` and `'WHITE` for the same colour.
 *
 * @param {*} size
 * @param {*} color
 * @return {{size: string, color: string}} each "" when blank
 */
export function variantKey(size, color) {
  const norm = (v) => cleanText(v).toUpperCase()
    .replace(/^['‘’ʻ]+/, '')
    .replace(/[\s_\-]+/g, '');
  return { size: norm(size), color: norm(color) };
}

/**
 * matchesVariant - does a sales line satisfy the variant the return asked for?
 *
 * Field by field, and asymmetric on purpose: a field the *return* leaves blank
 * is ignored, while a field the return supplies must match exactly. So a return
 * carrying only a size matches any colour in that size, and a return carrying
 * only a colour matches any size in that colour.
 *
 * @param {{size: string, color: string}} line
 * @param {{size: string, color: string}} wanted
 * @return {boolean}
 */
export function matchesVariant(line, wanted) {
  if (!line || !wanted) return false;
  return (!wanted.size || line.size === wanted.size)
      && (!wanted.color || line.color === wanted.color);
}

/**
 * lineRank - which of several same-key sales lines is the actual sale?
 *
 * A sales order in these sheets does not only hold sales. When an item comes
 * back, the *return* is recorded against the same order in the same row format,
 * with the quantity negated and the price restated. So an order/SKU pair can hold
 * a sale and its own return side by side:
 *
 *     SO014253 / 1002321   qty    0   price 1,149.00
 *     SO014253 / 1002321   qty  -89   price   999.63
 *
 * Neither is a clean positive sale, so a rule like "prefer qty > 0, else take
 * the first row" picks the wrong price and cannot even explain itself. The
 * ranking is by how much a line actually looks like a sale:
 *
 *   0  qty > 0    the sale
 *   1  qty = 0    a line closed out against its return twin — a real sale whose
 *                 quantity netted to zero, so its price is still the sale price
 *   2  qty < 0    the return itself: only reachable when nothing better exists
 *   3  qty blank  quantity unknown; ranked last because it proves nothing
 *
 * Rank 1 above rank 2 is the load-bearing decision: a zeroed line keeps the
 * *original* unit price, whereas the negative line carries the *restated* one.
 * Between two zeroed or two negative lines the first in sheet order wins, so the
 * result stays stable across runs.
 *
 * @param {!Object} line an indexed sales line
 * @return {number} lower is better
 */
function lineRank(line) {
  const q = line && typeof line.quantity === 'number' ? line.quantity : null;
  if (q === null) return 3;
  if (q > 0) return 0;
  if (q === 0) return 1;
  return 2;
}

/**
 * pickSaleLine - choose the sale line to price from.
 *
 * Tier 1: same order + SKU **and** the same Size/Color, where the Returns row
 *         actually supplies those values. This is what distinguishes the black
 *         kettle from the cream one — they share a SKU but not a price.
 * Tier 2: same order + SKU only. Used when the Returns row has no Size/Color to
 *         compare, or when no line matches them.
 *
 * Within a tier, the line that most looks like an actual sale wins, per
 * lineRank(). That matters more than it sounds: an order in these sheets holds
 * the sale *and* the return recorded against it, in the same format with the
 * quantity negated and the price restated, so "first match" or even
 * "prefer qty > 0" both land on the wrong number.
 *
 * @param {!Array<!Object>} lines candidate sale lines, all same order + SKU
 * @param {{size: string, color: string}} wanted normalised variant of the
 *   Returns row; `{size:'',color:''}` when it specifies neither
 * `pool` is the set the winner was actually chosen from — not every candidate.
 * That distinction is the point: a size-only return can reach the exact tier and
 * still land among three colours priced three ways, and the caller has to be
 * able to see that to warn about it.
 *
 * @return {{line: !Object, tier: string, candidates: number, usedWildcard: boolean,
 *           pool: !Array<!Object>}}
 *   `tier` is 'exact' | 'sku-only' | 'empty'.
 */
export function pickSaleLine(lines, wanted) {
  const list = Array.isArray(lines) ? lines.filter(Boolean) : [];
  if (list.length === 0) {
    return { line: null, tier: 'empty', candidates: 0, usedWildcard: false, pool: [], steppedBack: false };
  }

  const asks = Boolean(wanted && (wanted.size || wanted.color));

  // The size/colour tier first, so "the latest price" is searched for *within* the
  // right variant rather than across every colour of the item.
  const variants = asks ? list.filter((l) => matchesVariant(l.variant, wanted)) : [];
  const pool = variants.length ? variants : list;
  const tier = variants.length ? 'exact' : 'sku-only';
  const usedWildcard = !asks;

  // Latest sale first. The order the lines arrived in says nothing about when
  // they happened, and the sheet is not date-sorted.
  //
  // Undated lines sort last rather than first: an unknown date is not evidence
  // of recency, and treating it as recent would override a real dated sale.
  const byNewest = [...pool].sort((a, b) => {
    if (a.soldAt === null && b.soldAt === null) return 0;
    if (a.soldAt === null) return 1;
    if (b.soldAt === null) return -1;
    return b.soldAt - a.soldAt;
  });

  // Then drop sales that were returned, and take the one before them — "if the
  // quantity on the most recent date came back, go back to the earlier date".
  // `netQty` is the order's net quantity across all its lines, so a partially
  // returned sale still counts as standing: only a fully returned one is skipped.
  const standing = byNewest.filter((l) => !l.returnedInFull);
  const chosen = standing.length ? standing : byNewest;
  const line = chosen.reduce((a, b) => (lineRank(b) < lineRank(a) ? b : a));

  // Only the fully returned sales *newer* than the line actually used count as
  // stepped over; older returned sales played no part in the choice.
  const steppedOver = standing.length
    ? byNewest.slice(0, byNewest.indexOf(line)).filter((l) => l.returnedInFull).length
    : 0;
  const steppedBack = steppedOver > 0;

  return {
    line,
    tier,
    candidates: list.length,
    usedWildcard,
    pool,
    steppedBack,
    steppedOver,

    // Every sale for this item came back, so there is no "latest standing sale"
    // to speak of. The price is then the newest known one and nothing more, which
    // is worth saying: there is no unsold quantity behind it at all.
    allReturned: standing.length === 0 && list.length > 0,
  };
}

/**
 * buildSalesIndex - index Sales rows by Product_SKU + Customer_Account.
 *
 * Every line is kept, grouped under its key. That is essential rather than
 * merely tidy: the key is item + customer, so one group is every sale of that
 * item to that customer across all time. Keeping only the first row would leave
 * pickSaleLine() nothing to choose between, and picking blindly would mean
 * pricing a return off whichever sale happened to be written first.
 *
 * @param {!Array<!Object>} sales
 * @return {{byKey: !Map<string, !Array<!Object>>, rows: number}}
 */
export function buildSalesIndex(sales) {
  const byKey = new Map();
  const rows = Array.isArray(sales) ? sales : [];

  for (const sale of rows) {
    if (!sale) continue;

    const key = matchKey(sale.Product_SKU, sale.Customer_Account);
    if (!key.replace('|', '')) continue; // both fields blank

    const line = {
      key,
      orderId: cleanText(sale.Order_ID),
      sku: cleanText(sale.Product_SKU),
      quantity: toNumber(sale.Quantity),
      unitPrice: toNumber(sale.Unit_Price),
      variant: variantKey(sale.Size, sale.Color),

      // When this sale happened, used to pick the most recent applicable price.
      // Kept separate from `orderId` because the order is no longer part of the
      // match, but two lines of one order can carry different dates.
      soldAt: toDate(sale.Date),

      // Carried over so a Returns row that left one of these blank can be
      // completed from the sale line it matched. Nothing is invented: these are
      // the seller's own values, used only to fill a visible gap.
      customerAccount: cleanText(sale.Customer_Account),
      customerName: cleanText(sale.Customer_Name),
      productName: cleanText(sale.Product_Name),
      size: cleanText(sale.Size),
      color: cleanText(sale.Color),
      itemGroup: cleanText(sale.Item_Group),
      unit: cleanText(sale.Unit),
    };

    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(line);
  }

  // Net each order's quantities so a sale that was returned can be stepped over.
  //
  // This only works because the key no longer contains the order: every line of
  // every order for this item+customer is present, so the sale and the return
  // recorded against it are both here. Returns are written as negative-quantity
  // lines in the same format, so a net of <= 0 means it all came back.
  //
  //   SO001434 / 1002389   +750 (2023-02-11)  -6 (2023-02-21)   -> 744, still stands
  //   SO013544 / 1002934   +1   (2023-06-12)  -3 (2023-06-12)   ->  -2, returned
  //
  // A line with no order number cannot be paired with anything, so it nets on
  // its own. Grouping every order-less line under one blank order would let an
  // unrelated return cancel out an unrelated sale.
  const netByOrder = new Map();
  const orderKey = (key, line, i) => (line.orderId ? `${key}|${line.orderId}` : `${key}|#${i}`);
  for (const [key, lines] of byKey) {
    lines.forEach((line, i) => {
      const q = line.quantity === null ? 0 : line.quantity;
      const ok = orderKey(key, line, i);
      netByOrder.set(ok, (netByOrder.get(ok) || 0) + q);
    });
  }
  for (const [key, lines] of byKey) {
    for (const [i, line] of lines.entries()) {
      const net = netByOrder.get(orderKey(key, line, i)) ?? 0;
      // netQty is what remains of this order, i.e. the sale still stands.
      line.netQty = net;
      line.returnedInFull = net <= 0;
    }
  }

  return { byKey, rows: rows.length };
}

/* ------------------------------------------------------------------ *
 * 5. The pricing engine
 * ------------------------------------------------------------------ */

/**
 * priceReturns - match Returns against Sales and fill in the price columns.
 *
 * The Returns tab is a report, so **every** row comes out complete. A row is
 * never dropped and never left half-written; it either gets a real price or it
 * gets zeros plus a status saying why:
 *
 *      found          -> Unit_Price from Sales, Calculated_Value = Qty × price,
 *                        Status = "تم التسعير"
 *      not found, or  -> Unit_Price = 0, Calculated_Value = 0,
 *      bad quantity       Status = "صنف / طلب غير موجود"
 *
 * That choice is deliberate. An earlier build left unmatched rows blank, which
 * meant a CSV pasted back into the sheet produced ragged columns and the user
 * could not tell "not processed yet" from "no price exists". Zeros plus a label
 * are unambiguous, sum correctly, and can be filtered on.
 *
 * Other rules:
 *   - Rows whose Status is already "تم التسعير" are skipped unless
 *     includeAlreadyPriced is set, so re-running after an import is safe.
 *   - A negative quantity is priced by absolute value.
 *   - Descriptive columns blank on the Returns row are filled from the matched
 *     sale line; existing values are never overwritten.
 *   - Duplicate sale lines and returns larger than what was sold are warnings.
 *
 * @param {{sales: !Array, returns: !Array}} data
 * @param {{includeAlreadyPriced?: boolean}} [options]
 * @return {{rows: !Array<!Object>, stats: !Object}}
 */
export function priceReturns(data, { includeAlreadyPriced = false } = {}) {
  const sales = Array.isArray(data.sales) ? data.sales : [];
  const returns = Array.isArray(data.returns) ? data.returns : [];

  const { byKey } = buildSalesIndex(sales);

  const rows = returns.map((ret, index) => {
    const status = cleanText(ret.Status);

    // Returns sheets commonly record a return as a negative quantity (it keeps
    // the Returns tab arithmetically consistent with Sales). Pricing needs a
    // positive count, so the sign is dropped here. It is reported once per run
    // by describeSchema_() rather than on every row, which would be unreadable
    // on a sheet where all 500 rows are negative.
    const rawQty = toNumber(ret.Returned_Qty);
    const negativeQty = rawQty !== null && rawQty < 0;
    const returnedQty = negativeQty ? Math.abs(rawQty) : rawQty;

    // The row always carries a complete, printable set of the Returns columns,
    // in the user's order. `firstNonBlank` means a blank is filled from the
    // matched sale line rather than left as a hole in the report.
    const row = {
      index,
      orderId: cleanText(ret.Order_ID),
      customerAccount: cleanText(ret.Customer_Account),
      customerName: cleanText(ret.Customer_Name),
      sku: cleanText(ret.Product_SKU),
      productName: cleanText(ret.Product_Name),
      size: cleanText(ret.Size),
      color: cleanText(ret.Color),
      itemGroup: cleanText(ret.Item_Group),
      unit: cleanText(ret.Unit),
      returnedQty: returnedQty === null ? '' : returnedQty,

      // The three columns this run writes. Both start at 0 rather than empty,
      // because the sheet is a report and a blank cell reads as an oversight
      // while a 0 with a status beside it reads as a decision.
      unitPrice: 0,
      calculatedValue: 0,
      status: STATUS_PRICED,

      // Not part of the Returns layout; used only to drive the dashboard and
      // the optional Apps Script write-back, which needs a key to match on.
      returnId: cleanText(ret.Return_ID),
      sheetStatus: status,
      saleQty: null,
      matched: false,
      skipped: false,
      saleDate: null,

      // Which matching tier priced this row, and how many lines it chose among.
      // 'exact'   = order + SKU + Size + Color all matched
      // 'sku-only'= order + SKU matched, Size/Color did not narrow it
      // Surfaced so the table can show the user which rows are a firm match
      // and which are the looser kind.
      matchTier: '',
      matchCandidates: 0,

      issues: [],

      // Every row is ticked by default, including the ones that could not be
      // priced. An export is supposed to be the whole Returns tab; leaving the
      // unmatched rows unticked would make a partially-ticked table export
      // fewer rows than the sheet holds, which is the one outcome that can
      // quietly lose money. Unticking is then always a deliberate act.
      selected: true,
    };

    const fail = (reason) => {
      row.status = STATUS_NOT_FOUND;
      row.issues.push({ level: 'warn', message: reason });
      return row;
    };

    // -- already priced? --------------------------------------------------
    if (!includeAlreadyPriced && isPriced(status)) {
      row.skipped = true;
      // Carry the sheet's own figures through. Leaving the zero defaults here
      // would make an export pasted over the sheet wipe out every earlier price.
      row.unitPrice = toNumber(ret.Unit_Price) ?? 0;
      row.calculatedValue = toNumber(ret.Calculated_Value) ?? 0;
      row.issues.push({
        level: 'info',
        message: `مسجَّل مسبقاً بحالة "${STATUS_PRICED}". فعّل خيار "إعادة احتساب الصفوف المسعَّرة مسبقاً" لإعادة التسعير.`,
      });
      return row;
    }

    // -- the quantity -----------------------------------------------------
    if (returnedQty === null) {
      return fail('الكمية المرتجعة ليست رقماً — تم ترك السعر والقيمة بصفر.');
    }
    if (returnedQty === 0) {
      return fail('الكمية المرتجعة صفر — لا يوجد ما يُسعَّر.');
    }

    // -- find the sale line ----------------------------------------------
    // Keyed on item + customer account, never on the order. Within that key the
    // applicable sale is the most recent one whose quantity still stands: if the
    // newest date came back in full, the price falls back to the date before it.
    const key = matchKey(ret.Product_SKU, ret.Customer_Account);
    const lines = byKey.get(key);
    const pick = pickSaleLine(lines, variantKey(ret.Size, ret.Color));

    if (!pick.line) {
      return fail(
        `لا يوجد سجل بيع للصنف ${row.sku || '(فارغ)'} للعميل ${row.customerAccount || '(فارغ)'}.`,
      );
    }

    const sale = pick.line;
    row.matched = true;

    // How much was sold, as a positive count. The chosen line can legitimately
    // carry a zero or negative quantity (see lineRank) when the order records the
    // return against the sale, and comparing the returned count against that
    // raw figure would raise a bogus "returned more than sold" warning on a
    // perfectly ordinary row.
    row.saleQty = sale.quantity === null ? null : Math.abs(sale.quantity);
    row.matchTier = pick.tier;
    row.matchCandidates = pick.candidates;

    // Not a Returns column — kept so the row can say *when* the price it took
    // was struck, which is the whole point of pricing from the latest sale.
    row.saleDate = sale.soldAt;

    // Fill only what the Returns row left blank; never overwrite its own values.
    row.customerAccount = firstNonBlank(row.customerAccount, sale.customerAccount);
    row.customerName = firstNonBlank(row.customerName, sale.customerName);
    row.productName = firstNonBlank(row.productName, sale.productName);
    row.size = firstNonBlank(row.size, sale.size);
    row.color = firstNonBlank(row.color, sale.color);
    row.itemGroup = firstNonBlank(row.itemGroup, sale.itemGroup);
    row.unit = firstNonBlank(row.unit, sale.unit);

    // -- the price --------------------------------------------------------
    if (sale.unitPrice === null) {
      return fail('سعر الوحدة في سجل البيع المطابق ليس رقماً.');
    }

    row.unitPrice = sale.unitPrice;

    // -- warnings ---------------------------------------------------------
    // Look at the pool the price was actually chosen from, not every candidate.
    // They differ: a size-only return reaches the exact tier and can still land
    // among several colours priced several ways, and that is a judgement call
    // even though the tier says "exact".
    const poolPrices = [...new Set(
      pick.pool.filter((l) => l.unitPrice !== null).map((l) => formatNumber(l.unitPrice)),
    )];

    if (poolPrices.length > 1) {
      // Several candidate prices survived the tiers, so the number on screen is a
      // decision, not a fact. Name the alternatives rather than letting a price
      // that may be wrong look settled.
      row.issues.push({
        level: 'warn',
        message: pick.usedWildcard
          ? `للعميل ${poolPrices.length} سعراً مختلفاً لهذا الصنف (${poolPrices.join('، ')})، ` +
            'ولم يُحدَّد المقاس أو اللون في المرتجع للتمييز بينها. ' +
            `تم اعتماد أحدث سعر: ${formatNumber(sale.unitPrice)}.`
          : `تعذّر تمييز المقاس أو اللون (${row.size || '—'} / ${row.color || '—'})، ` +
            `واعتُمد أحدث سعر ${formatNumber(sale.unitPrice)} من بين ${poolPrices.length} أسعار مختلفة ` +
            `(${poolPrices.join('، ')}) لنفس الصنف.`,
      });
    } else if (pick.tier === 'sku-only' && !pick.usedWildcard && pick.pool.length === 1) {
      // Nothing to choose between, so this is a note, not a warning.
      row.issues.push({
        level: 'info',
        message: `لا يوجد سجل بيع بنفس المقاس واللون؛ اعتُمد السعر ${formatNumber(sale.unitPrice)} ` +
                 'من السجل الوحيد المطابق للصنف.',
      });
    }

    if (pick.allReturned) {
      row.issues.push({
        level: 'warn',
        message: 'كل سجلات بيع هذا الصنف للعميل مرتجِع بالكامل، ' +
                 `فلا يوجد سعر حديث ساري؛ اعتُمد آخر سعر معروف ${formatNumber(sale.unitPrice)}.`,
      });
    } else if (pick.steppedBack) {
      // The newest sale came back in full, so an earlier date supplied the price.
      // Worth stating plainly: the number is older than the most recent one and
      // the user may otherwise expect the newer figure. The date is the one the
      // price was taken from, so it belongs to the fallback, not the returns.
      const when = sale.soldAt === null
        ? ''
        : ` بتاريخ ${new Date(sale.soldAt).toISOString().slice(0, 10)}`;
      row.issues.push({
        level: 'warn',
        message: `أحدث ${formatQty(pick.steppedOver)} سجل بيع لهذا الصنف مرتجِع بالكامل، ` +
                 `فتم الرجوع إلى بيع أقدم${when} ` +
                 `واعتماد السعر ${formatNumber(sale.unitPrice)}.`,
      });
    }

    if (row.saleQty !== null && returnedQty > row.saleQty) {
      row.issues.push({
        level: 'warn',
        message: `الكمية المرتجعة ${returnedQty} أكبر من الكمية المباعة ${row.saleQty}.`,
      });
    }

    // -- the actual maths -------------------------------------------------
    row.calculatedValue = round2(returnedQty * sale.unitPrice);
    return row;
  });

  return { rows, stats: summarise(rows) };
}

/**
 * firstNonBlank - the first value that actually contains something.
 * @param {...*} values
 * @return {string}
 */
function firstNonBlank(...values) {
  for (const value of values) {
    const text = cleanText(value);
    if (text) return text;
  }
  return '';
}

/**
 * summarise - headline numbers for the dashboard cards.
 *
 * `matched` counts rows that got a real price; `unmatched` counts rows left at
 * zero with STATUS_NOT_FOUND. Those two plus `skipped` always add up to
 * `total`, which is what makes the numbers on screen trustworthy — a user can
 * check the arithmetic without reading the table.
 *
 * @param {!Array<!Object>} rows
 * @return {!Object}
 */
export function summarise(rows) {
  const stats = {
    total: rows.length,
    matched: 0,
    unmatched: 0,
    warnings: 0,
    skipped: 0,
    selected: 0,

    // Split of the matched rows by how confidently they were matched. Kept
    // apart because they mean different things to the reader: `exact` matched
    // order + SKU + Size + Color, `skuOnly` matched order + SKU only.
    exact: 0,
    skuOnly: 0,

    totalValue: 0,
    selectedValue: 0,
  };

  for (const row of rows) {
    if (row.skipped) stats.skipped += 1;
    else if (row.matched) {
      stats.matched += 1;
      if (row.matchTier === 'exact') stats.exact += 1;
      else stats.skuOnly += 1;
    }
    else stats.unmatched += 1;

    if (row.issues.some((i) => i.level === 'warn')) stats.warnings += 1;

    const value = Number(row.calculatedValue) || 0;
    stats.totalValue += value;
    if (row.selected) {
      stats.selected += 1;
      stats.selectedValue += value;
    }
  }

  stats.totalValue = round2(stats.totalValue);
  stats.selectedValue = round2(stats.selectedValue);
  return stats;
}

/** @param {number} n @return {number} */
export function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}


/* ------------------------------------------------------------------ *
 * 6. Formatting helpers
 * ------------------------------------------------------------------ */

/**
 * moneyFormatter - cached per currency code.
 *
 * LOCALE pins Latin digits (‎-u-nu-latn‎) because the ID, SKU and quantity
 * columns are all Latin-script: mixing Arabic-Indic digits into a price
 * column next to them makes scanning the row much harder.
 *
 * @param {string} currency
 * @return {!Intl.NumberFormat}
 */
export function moneyFormatter(currency) {
  const code = /^[A-Z]{3}$/.test(String(currency || '').toUpperCase())
    ? String(currency).toUpperCase()
    : 'USD';

  const cached = moneyFormatter._cache?.get(code);
  if (cached) return cached;

  let formatter;
  try {
    formatter = new Intl.NumberFormat(LOCALE, { style: 'currency', currency: code });
  } catch {
    formatter = new Intl.NumberFormat(LOCALE, { style: 'currency', currency: 'USD' });
  }

  if (!moneyFormatter._cache) moneyFormatter._cache = new Map();
  moneyFormatter._cache.set(code, formatter);
  return formatter;
}

/**
 * formatMoney - "$1,234.50"
 * @param {?number} value
 * @param {string} currency
 * @return {string}
 */
export function formatMoney(value, currency = 'USD') {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return moneyFormatter(currency).format(value);
}

/**
 * formatNumber - strips trailing zeros but keeps at least 2dp for prices.
 * @param {?number} value
 * @return {string}
 */
export function formatNumber(value) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return String(round2(value));
}

/**
 * formatQty - "2" or "—"
 * @param {?number} value
 * @return {string}
 */
export function formatQty(value) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return String(value);
}

/**
 * escapeHtml - mandatory before interpolating sheet values into innerHTML.
 * Sheet content is user-controlled input.
 * @param {*} value
 * @return {string}
 */
export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * formatTimestamp - "5 Oct 2026, 14:03"
 * @param {string|Date} value
 * @return {string}
 */
export function formatTimestamp(value) {
  if (!value) return '—';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString(LOCALE, {
    day: 'numeric', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}


/* ------------------------------------------------------------------ *
 * 7. DOM helpers (defensive - no-ops when the element is absent)
 * ------------------------------------------------------------------ */

/** @param {string} id @return {?HTMLElement} */
export function byId(id) {
  return document.getElementById(id);
}

/**
 * show - unhide an element.
 * @param {string} id
 * @param {boolean=} visible
 */
export function show(id, visible = true) {
  const el = byId(id);
  if (el) el.classList.toggle('hidden', !visible);
}

/**
 * setText - write text safely (textContent, never innerHTML).
 * @param {string} id
 * @param {*} value
 */
export function setText(id, value) {
  const el = byId(id);
  if (el) el.textContent = value ?? '';
}

/**
 * setBadge - paint one of the coloured status pills.
 * @param {string} id
 * @param {'idle'|'working'|'success'|'error'} state
 * @param {string} message
 */
export function setBadge(id, state, message) {
  const el = byId(id);
  if (!el) return;

  const styles = {
    idle: 'bg-slate-100 text-slate-600 ring-slate-200',
    working: 'bg-amber-50 text-amber-800 ring-amber-200 animate-pulse',
    success: 'bg-emerald-50 text-emerald-800 ring-emerald-200',
    error: 'bg-rose-50 text-rose-700 ring-rose-200',
  };

  el.className = `inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs font-semibold ring-1 ring-inset ${styles[state] || styles.idle}`;
  el.textContent = message;
  el.dataset.state = state;
}

/**
 * setBusy - disable buttons and show a spinner label while work is running.
 *
 * Note: clearing `busy` sets `disabled = false` unconditionally, which
 * overwrites any disabled state set by the caller (for example "Execute"
 * being disabled because no rows are ticked). Callers that own a more
 * meaningful disabled rule should re-apply it after calling this with
 * `busy = false`.
 *
 * @param {string} id
 * @param {boolean} busy
 * @param {string=} busyLabel
 * @param {string=} idleLabel
 */
export function setBusy(id, busy, busyLabel, idleLabel) {
  const el = byId(id);
  if (!el) return;
  el.disabled = busy;
  if (busy && busyLabel) el.innerHTML = spinner() + escapeHtml(busyLabel);
  if (!busy && idleLabel) el.textContent = idleLabel;
}

/** @return {string} inline loading spinner markup */
export function spinner() {
  return '<svg class="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
         '<circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"/>' +
         '<path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"/>' +
         '</svg>';
}


/* ------------------------------------------------------------------ *
 * 8. Non-blocking UI: toasts and modals
 * ------------------------------------------------------------------ *
 * Native alert()/confirm() are synchronous: they halt the whole event
 * loop, which in this app previously showed up as frozen execution and
 * apparently disconnected click handlers. Everything below is built from
 * ordinary DOM nodes so the UI never blocks the main thread.
 * ------------------------------------------------------------------ */

/** How long each toast variant lingers before auto-dismissing (ms). */
const TOAST_DURATION = {
  success: 4000,
  info: 4000,
  warning: 6000,
  error: 9000, // failures deserve longer than the rest
};

/**
 * toast - render a transient notification into #toast-notification.
 *
 * Fade in on insert, hold, then fade out and remove. The container needs
 * to exist in the page; this is a no-op (with a console warning) if not,
 * so a missing host never breaks the calling code.
 *
 * @param {string} message
 * @param {'success'|'error'|'warning'|'info'} [type]
 * @param {{duration?: number, title?: string}} [options]
 * @return {?HTMLElement} the toast node, so callers can dismiss it early
 */
export function toast(message, type = 'info', options = {}) {
  const host = byId('toast-notification');
  if (!host) {
    console.warn('[RPS] toast(): #toast-notification host not found.');
    return null;
  }

  const variant = TOAST_DURATION[type] ? type : 'info';
  const duration = options.duration ?? TOAST_DURATION[variant];

  const styles = {
    success: 'border-emerald-200 bg-emerald-50 text-emerald-900',
    error: 'border-rose-200 bg-rose-50 text-rose-900',
    warning: 'border-amber-200 bg-amber-50 text-amber-900',
    info: 'border-sky-200 bg-sky-50 text-sky-900',
  };
  const icons = { success: '✓', error: '✕', warning: '!', info: 'i' };
  const role = variant === 'error' ? 'alert' : 'status';

  const node = document.createElement('div');
  node.setAttribute('role', role);
  node.setAttribute('aria-live', variant === 'error' ? 'assertive' : 'polite');
  node.className =
    'pointer-events-auto flex w-full items-start gap-3 rounded-xl border px-4 py-3 ' +
    'shadow-lg ring-1 ring-black/5 ' + styles[variant];

  node.innerHTML =
    `<span class="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full ` +
    `bg-white/70 text-xs font-bold">${icons[variant]}</span>` +
    `<div class="min-w-0 flex-1 text-sm">` +
    (options.title
      ? `<p class="font-semibold">${escapeHtml(options.title)}</p>`
      : '') +
    `<p class="${options.title ? 'mt-0.5 opacity-90' : 'font-medium'} break-words">` +
    `${escapeHtml(message)}</p>` +
    `</div>` +
    `<button type="button" class="shrink-0 rounded-md px-1.5 py-0.5 text-lg leading-none ` +
    `opacity-60 transition hover:opacity-100 focus:outline-none focus:ring-2 ` +
    `focus:ring-slate-400" aria-label="Dismiss notification">×</button>`;

  // Keep the stack shallow so toasts cannot cover the whole page.
  while (host.children.length >= 4) host.firstElementChild.remove();
  host.appendChild(node);

  // Entrance animation with fill:'none' so the toast is statically visible
  // even if the animation never runs (e.g. tab not painting). See the note
  // in openModal() for why transitions are avoided here.
  const canAnimate = typeof node.animate === 'function';
  if (canAnimate) {
    node.animate(
      [
        { opacity: 0, transform: 'translateY(8px) scale(0.98)' },
        { opacity: 1, transform: 'translateY(0) scale(1)' },
      ],
      { duration: 220, easing: 'cubic-bezier(0.16, 1, 0.3, 1)', fill: 'none' },
    );
  }

  let timer = null;
  let dismissed = false;
  const dismiss = () => {
    // Guard against the manual button and the timer both firing.
    if (dismissed || !node.isConnected) return;
    dismissed = true;
    clearTimeout(timer);

    if (!canAnimate) {
      node.remove();
      return;
    }

    const anim = node.animate(
      [
        { opacity: 1, transform: 'translateY(0)' },
        { opacity: 0, transform: 'translateY(8px)' },
      ],
      { duration: 200, easing: 'ease-in', fill: 'forwards' },
    );
    // Remove on finish, with a timer fallback in case finish never fires
    // (animation frames are throttled in background tabs).
    let removed = false;
    const remove = () => {
      if (removed) return;
      removed = true;
      node.remove();
    };
    anim.addEventListener('finish', remove);
    setTimeout(remove, 400);
  };

  node.querySelector('button').addEventListener('click', dismiss);
  if (duration > 0) timer = setTimeout(dismiss, duration);

  return node;
}

/** Shorthand wrappers so call sites read cleanly. */
export const toastSuccess = (m, o) => toast(m, 'success', o);
export const toastError = (m, o) => toast(m, 'error', o);
export const toastWarning = (m, o) => toast(m, 'warning', o);
export const toastInfo = (m, o) => toast(m, 'info', o);


/* Elements focusable inside a dialog, used for the focus trap. */
const FOCUSABLE = 'a[href], button:not([disabled]), textarea, input:not([disabled]), select, [tabindex]:not([tabindex="-1"])';

/**
 * openModal - reveal a modal and manage focus.
 *
 * Stores the previously focused element so closeModal() can restore it,
 * moves focus into the dialog, and installs a Tab focus trap plus an
 * Escape handler. Listeners are keyed on the element, so calling
 * openModal twice cannot stack duplicate traps.
 *
 * @param {string} id
 * @return {boolean} false when the element does not exist
 */
export function openModal(id) {
  const el = byId(id);
  if (!el) return false;

  if (!el.dataset.returnFocusTo) {
    el.dataset.returnFocusTo = '';
  }
  if (!el.__returnFocus) {
    el.__returnFocus = document.activeElement;
  }

  // `hidden` sets display:none. The container carries `flex` in its markup so
// the flex centring utilities (items-center / justify-center) work once the
// element becomes visible again.
  el.classList.remove('hidden');
  el.removeAttribute('aria-hidden');

  // Entrance animation via the Web Animations API with fill:'none'.
  //
  // Deliberately NOT a class toggle plus CSS transition: transitions only
  // advance while the tab is painting, so a modal opened from a background
  // tab could stay stuck at opacity 0 while being fully "open" and
  // focus-trapped. With fill:'none' the animated value is dropped the
  // moment the animation ends, so the element's static style (visible)
  // is always the fallback.
  const panel = el.querySelector('[data-modal-panel]');
  if (panel && typeof panel.animate === 'function') {
    panel.animate(
      [
        { opacity: 0, transform: 'scale(0.96)' },
        { opacity: 1, transform: 'scale(1)' },
      ],
      { duration: 160, easing: 'ease-out', fill: 'none' },
    );
  }

  if (!el.__bound) {
    el.__bound = true;

    // Escape closes (unless data-modal-persistent).
    el.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !el.hasAttribute('data-modal-persistent')) {
        event.preventDefault();
        closeModal(id);
        return;
      }

      // Tab cycles within the dialog.
      if (event.key !== 'Tab') return;

      const items = [...el.querySelectorAll(FOCUSABLE)].filter((n) => n.offsetParent !== null);
      if (!items.length) return;

      const first = items[0];
      const last = items[items.length - 1];

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    });
  }

  const focusTarget = el.querySelector('[data-modal-autofocus]') ||
                      el.querySelector(FOCUSABLE);
  focusTarget?.focus();

  return true;
}

/**
 * closeModal - hide a modal and return focus to the trigger.
 * @param {string} id
 * @return {boolean} false when the element does not exist
 */
export function closeModal(id) {
  const el = byId(id);
  if (!el) return false;

  el.classList.add('hidden');
  el.setAttribute('aria-hidden', 'true');

  const restore = el.__returnFocus;
  el.__returnFocus = null;
  if (restore && restore.isConnected && typeof restore.focus === 'function') {
    restore.focus();
  }
  return true;
}

/**
 * confirmModal - the promise-based replacement for window.confirm().
 *
 * Resolves true on confirm, false on cancel/Escape. Non-blocking: the
 * caller awaits a promise while the event loop keeps running.
 *
 * @param {{id: string, title: string, message: string, detail?: string,
 *          confirmLabel?: string, cancelLabel?: string, tone?: 'default'|'danger'}} options
 * @return {!Promise<boolean>}
 */
export function confirmModal({
  id,
  title,
  message,
  detail = '',
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  tone = 'default',
} = {}) {
  return new Promise((resolve) => {
    const modal = byId(id);
    if (!modal) {
      // Fail safe: if the dialog markup is missing, do not write anything.
      console.warn(`[RPS] confirmModal(): #${id} not found; treating as cancel.`);
      resolve(false);
      return;
    }

    const titleEl = modal.querySelector('[data-confirm-title]');
    const messageEl = modal.querySelector('[data-confirm-message]');
    const detailEl = modal.querySelector('[data-confirm-detail]');
    const confirmBtn = modal.querySelector('[data-confirm-accept]');
    const cancelBtn = modal.querySelector('[data-confirm-cancel]');

    if (titleEl && title) titleEl.textContent = title;
    if (messageEl) messageEl.textContent = message;
    if (detailEl) {
      detailEl.textContent = detail;
      detailEl.classList.toggle('hidden', !detail);
    }
    if (confirmBtn) confirmBtn.textContent = confirmLabel;
    if (cancelBtn) cancelBtn.textContent = cancelLabel;

    if (confirmBtn) {
      confirmBtn.className = confirmBtn.className.replace(
        /bg-(indigo|rose)-\d+|hover:bg-(indigo|rose)-\d+/g,
        (m) => (tone === 'danger' ? m.replace(/indigo/, 'rose') : m.replace(/rose/, 'indigo')),
      );
    }

    // Detach any previous handlers so this modal is reusable.
    const previous = modal.__handlers || [];
    previous.forEach(({ node, type, handler }) => node.removeEventListener(type, handler));

    const handlers = [];
    const finish = (value) => {
      handlers.forEach(({ node, type, handler }) => node.removeEventListener(type, handler));
      modal.__handlers = [];
      closeModal(id);
      resolve(value);
    };

    if (confirmBtn) {
      const onAccept = (event) => { event.preventDefault(); finish(true); };
      confirmBtn.addEventListener('click', onAccept);
      handlers.push({ node: confirmBtn, type: 'click', handler: onAccept });
    }
    if (cancelBtn) {
      const onCancel = (event) => { event.preventDefault(); finish(false); };
      cancelBtn.addEventListener('click', onCancel);
      handlers.push({ node: cancelBtn, type: 'click', handler: onCancel });
    }

    // Backdrop click cancels; clicks inside the panel must not bubble out.
    const onBackdrop = (event) => {
      if (event.target === modal) finish(false);
    };
    modal.addEventListener('click', onBackdrop);
    handlers.push({ node: modal, type: 'click', handler: onBackdrop });

    // openModal owns the Escape handler, so mirror it into our promise.
    const onKey = (event) => {
      if (event.key === 'Escape' && !modal.hasAttribute('data-modal-persistent')) {
        finish(false);
      }
    };
    modal.addEventListener('keydown', onKey);
    handlers.push({ node: modal, type: 'keydown', handler: onKey });

    modal.__handlers = handlers;
    openModal(id);
  });
}

/**
 * renderRows - draw the priced-returns table.
 *
 * The columns here are RETURNS_LAYOUT, in order, so the screen and the exported
 * CSV are the same thirteen columns in the same sequence. The header row lives
 * in index.html as static markup; the two are kept in step by hand, and
 * `renderRowsHeader()` below regenerates that markup if the layout ever changes.
 *
 * @param {string} containerId
 * @param {!Array<!Object>} rows
 * @param {{currency: string, onToggle: function(!Object, boolean): void, filter: (function(!Object): boolean)}} [options]
 */
export function renderRows(containerId, rows, options = {}) {
  const container = byId(containerId);
  if (!container) return;

  const { currency = 'USD', onToggle, filter } = options;
  const visible = filter ? rows.filter(filter) : rows;

  if (visible.length === 0) {
    container.innerHTML =
      `<tr><td colspan="${RETURNS_LAYOUT.length + 1}" class="px-4 py-10 text-center text-sm text-slate-400">
         لا توجد مرتجعات لعرضها بعد. اضغط <strong>١ · جلب البيانات</strong> ثم
         <strong>٢ · معالجة وتسعير المرتجعات</strong>.
       </td></tr>`;
    return;
  }

  container.innerHTML = visible.map((row) => {
    const issueHtml = row.issues.length
      ? `<ul class="mt-1 space-y-0.5">${row.issues.map((issue) => {
          const tone = issue.level === 'error' ? 'text-rose-600'
            : issue.level === 'warn' ? 'text-amber-600' : 'text-slate-400';
          return `<li class="text-[11px] ${tone}">• ${escapeHtml(issue.message)}</li>`;
        }).join('')}</ul>`
      : '';

    // Status is the single source of truth for "did this work", so it is the
    // only cell that gets a colour. Green means priced; amber means the row is
    // in the report but still needs a source order.
    const priced = row.status === STATUS_PRICED;
    const statusTone = row.skipped
      ? 'bg-slate-100 text-slate-500'
      : priced
        ? 'bg-emerald-100 text-emerald-700'
        : 'bg-amber-100 text-amber-700';

    // A priced row is not automatically a confident one. `exact` matched order +
    // SKU + Size + Color; `sku-only` matched order + SKU and took the price from
    // whichever line the tier rules preferred. Both say "تم التسعير" because both
    // are correct answers to the question asked — the second line is what stops a
    // loosened match from being mistaken for a firm one.
    const matchNote = priced && row.matchTier === 'sku-only'
      ? `<span class="mt-1 block text-[10px] leading-tight text-slate-400">بكود الصنف فقط</span>`
      : '';

    return `
      <tr class="border-b border-slate-100 align-top hover:bg-slate-50/70 transition-colors
                 ${priced ? '' : 'bg-amber-50/40'}">
        <td class="px-3 py-3">
          <input type="checkbox" class="h-4 w-4 rounded border-slate-300 text-indigo-600
                 focus:ring-indigo-500"
                 data-row="${row.index}" ${row.selected ? 'checked' : ''}
                 aria-label="${escapeHtml('تحديد المرتجع رقم ' + (row.orderId || '—'))}" />
        </td>
        <td class="px-3 py-3 font-mono text-xs text-slate-700" dir="ltr" style="text-align:right">${escapeHtml(row.orderId || '—')}</td>
        <td class="px-3 py-3 font-mono text-xs text-slate-600" dir="ltr" style="text-align:right">${escapeHtml(row.customerAccount || '—')}</td>
        <td class="px-3 py-3 text-xs text-slate-800">${escapeHtml(row.customerName || '—')}</td>
        <td class="px-3 py-3 font-mono text-xs text-slate-600" dir="ltr" style="text-align:right">${escapeHtml(row.sku || '—')}</td>
        <td class="px-3 py-3 text-xs text-slate-700">${escapeHtml(row.productName || '—')}</td>
        <td class="px-3 py-3 text-xs text-slate-500" dir="ltr" style="text-align:right">${escapeHtml(row.size || '—')}</td>
        <td class="px-3 py-3 text-xs text-slate-500">${escapeHtml(row.color || '—')}</td>
        <td class="px-3 py-3 text-xs text-slate-500">${escapeHtml(row.itemGroup || '—')}</td>
        <td class="px-3 py-3 text-xs text-slate-500">${escapeHtml(row.unit || '—')}</td>
        <td class="px-3 py-3 tabular-nums text-slate-700" dir="ltr" style="text-align:right">${escapeHtml(formatQty(row.returnedQty))}</td>
        <td class="px-3 py-3 tabular-nums text-slate-500" dir="ltr" style="text-align:right">${
          // Money, not a bare number: a unit price of 4499.1 sitting next to a
          // formatted total reads as a different kind of quantity. An unmatched
          // row shows a muted 0 rather than an em dash, because 0 is what the
          // CSV will contain and the screen should not disagree with the file.
          escapeHtml(formatMoney(row.unitPrice || 0, currency))
        }</td>
        <td dir="ltr" style="text-align:right" class="px-3 py-3 tabular-nums font-semibold
                   ${priced ? 'text-slate-900' : 'text-slate-400'}">
          ${escapeHtml(formatMoney(row.calculatedValue || 0, currency))}
          ${issueHtml}
        </td>
        <td class="px-3 py-3">
          <span class="inline-block whitespace-nowrap rounded-md px-2 py-0.5 text-[11px] font-semibold ${statusTone}">
            ${escapeHtml(statusLabel(row.status))}
          </span>
          ${matchNote}
        </td>
      </tr>`;
  }).join('');

  // Delegate the checkbox events once, after the innerHTML swap.
  if (onToggle) {
    container.querySelectorAll('input[data-row]').forEach((input) => {
      input.addEventListener('change', (event) => {
        const idx = Number(event.target.dataset.row);
        onToggle(idx, event.target.checked);
      });
    });
  }
}

/**
 * renderRowsHeader - the `<thead>` markup for RETURNS_LAYOUT.
 *
 * Not used at runtime: index.html carries the same header as static markup,
 * because a table with a hard-coded header is far easier to review and restyle
 * than one assembled in JavaScript. This exists so the two cannot silently
 * drift — `headerCells()` is exported for tests, and anyone changing the layout
 * can paste `renderRowsHeader()`'s output straight into the HTML.
 *
 * @return {string}
 */
export function renderRowsHeader() {
  return RETURNS_LAYOUT.map((c) => {
    const align = c.numeric ? ' text-start' : '';
    return `<th scope="col" class="px-3 py-3${align}">${escapeHtml(c.label)}</th>`;
  }).join('\n              ');
}