# نظام تسعير المرتجعات (Returns Pricing System)

A lightweight, zero-build web app for pricing returns against original sales.

**الواجهة بالعربية بالكامل مع اتجاه من اليمين إلى اليسار (RTL).**
The user interface is fully Arabic and right-to-left. The spreadsheet contract
stays in English on purpose — see [Localisation](#localisation-التعريب) below.

- **Front-end:** plain HTML5 + Tailwind (CDN) + vanilla ES6 modules
- **Reading:** the public Google Sheets `gviz` endpoint, reached as JSONP.
  **No API key, no Cloud project** — the sheet only has to be shared
  *anyone with the link*.
- **Exporting:** CSV matching the `Returns` tab exactly — 13 columns, same order
- **Writing to the sheet (optional):** a Google Apps Script Web App
- **Hosting:** GitHub Pages

Reading and pricing never write to the sheet, so the flow is deliberately staged
until you choose an output:

| الخطوة | الزر | ما يفعله |
| --- | --- | --- |
| ١ | **جلب البيانات** | Read the `Sales` and `Returns` tabs into browser memory from the share link |
| ٢ | **معالجة وتسعير المرتجعات** | Match `Item` + `Customer account` (+ `Size`/`Color`), compute `Quantity × Unit_Price`, set `Status` |
| — | **تصدير المرتجعات المسعَّرة (CSV)** | Download the whole `Returns` tab back as CSV — 13 columns, same order |

There is a fourth step, **تنفيذ المرتجعات**, but it is optional and needs an
Apps Script deployment. For almost every workflow the CSV button is the better
answer: it needs no deployment, no key column, and it reproduces the `Returns`
tab exactly, so it can be pasted straight back over A1 or imported with
*File → Import*. See [Export instead of write](#3-التصدير-بدل-الكتابة).

---

## Files

```
.
├── index.html         لوحة التحكم: جلب ← تسعير ← تصدير CSV (وتنفيذ اختياري)
├── settings.html      رابط الجدول + أسماء الورقتين (قراءة)، ورابط النشر (كتابة اختياري)
├── app.js             Shared logic: transport, matching, pricing, CSV, rendering, toasts, modals
├── google-script.gs   Apps Script backend — optional, write path only
└── .nojekyll          Tells GitHub Pages to skip Jekyll processing
```

> `README.md` is in English for reference. Everything the end user sees in the
> app itself is Arabic.

---

## 1. Prepare the spreadsheet

Create (or open) your Google Sheet and add two tabs. Tab names must match the
range you configure in the Settings page (default `Sales` and `Returns`).

### The thirteen `Returns` columns

This order is the contract. The dashboard table, the CSV export and
`RETURNS_LAYOUT` in `app.js` all follow it exactly, so the export can be pasted
back onto the sheet without reordering anything.

| # | Sheet header | Contract name | Role |
| --- | --- | --- | --- |
| 1 | `Sales order` | `Order_ID` | display only — **not** part of the match |
| 2 | `Customer account` | `Customer_Account` | **match key** (with `Item`) |
| 3 | `CSName` | `Customer_Name` | display |
| 4 | `Item` | `Product_SKU` | **match key** (with `Customer account`; `Size`/`Color` narrow it) |
| 5 | `Name` | `Product_Name` | display |
| 6 | `Size` | `Size` | **match narrowing** + display |
| 7 | `Color` | `Color` | **match narrowing** + display |
| 8 | `Item group` | `Item_Group` | display |
| 9 | `Unit` | `Unit` | display |
| 10 | `Quantity` | `Returned_Qty` | **input** — may be negative |
| 11 | `Unit_Price` | `Unit_Price` | **written** from `Sales` |
| 12 | `Calculated_Value` | `Calculated_Value` | **written** — `Quantity × Unit_Price` |
| 13 | `Status` | `Status` | **written** — `تم التسعير` / `صنف / طلب غير موجود` |

Columns 11–13 are *outputs*. They need to exist for the app to write into them,
but their absence on a first run is the normal state of a fresh sheet, not an
error — and it never blocks reading or pricing.

Only **three** columns are genuinely required: `Item`, `Customer account` and
`Quantity`. `Sales order` is not among them — it is shown, never searched on.
Everything else either decorates the table or is written by the app.

### The `Sales` tab

`Sales` carries thirteen columns, but the engine only needs four of them:

| Sheet header | Contract name | Role |
| --- | --- | --- |
| `Item` | `Product_SKU` | **match key** |
| `Customer account` | `Customer_Account` | **match key** |
| `Unit_Price` | `Unit_Price` | the price copied onto the return |
| `Date` | `Date` | **orders the candidates**, newest first |

`Sales order`, `CSName`, `Name`, `Size`, `Color`, `Item group`, `Unit`,
`Quantity` and `Amount` are carried too. `Size` and `Color` narrow the match;
the rest are used to fill a blank descriptive cell on a `Returns` row — and are
never required.

> **`Date` is only useful if it is filled in.** A sales line with no date sorts
> last and is only reached when no dated sale exists for that item and customer.
> On the sample sheet `Date` is populated on every row.

`Size` and `Color` do more than display: they are the second matching tier, which
is what picks the right price when one SKU appears in several colours. See
[How a sale is found](#how-a-sale-is-found).

### Column-name tolerance

Order does not matter for *reading*: the app maps columns by header text and
treats case and spacing loosely (`order id`, `Returned Qty` and `returned-qty`
all match). Only the header names need to be right. (Order does matter for the
*export*, which reproduces the table above verbatim.)

Common real-world spellings are recognised too, so an existing sheet usually needs
no editing at all:

| Column | Also accepted |
| --- | --- |
| `Order_ID` | `Sales order`, `Order ID`, `Order No` |
| `Customer_Account` | `Customer No`, `Account` |
| `Customer_Name` | `CSName`, `Customer Name`, `Client Name` |
| `Product_SKU` | `Item`, `SKU`, `Product Code`, `Item Code` |
| `Product_Name` | `Name`, `Item Name`, `Product Name` |
| `Item_Group` | `Group` |
| `Unit` | `UOM` |
| `Returned_Qty` | `Quantity` *(on the `Returns` tab only)*, `Returned Quantity` |
| `Quantity` | `Qty` *(on the `Sales` tab only)* |
| `Unit_Price` | `Price` |

> `Quantity` is resolved per tab on purpose: on `Sales` it means how many were
> sold, on `Returns` how many came back.

Two sheet quirks are handled automatically, because both are invisible in a
screenshot but break naive matching:

- **Bidirectional marks.** A header or value typed in an RTL-aware editor often
  carries a leading `U+200E`, so `‎Sales order` is a *different string* from
  `Sales order`. These are stripped before anything is compared.
- **A leading apostrophe.** Pasted order numbers frequently arrive as
  `'SO018842` in one tab and `SO018842` in another. The apostrophe is treated as a
  paste artefact and ignored *for matching only* — the table and the CSV still
  show exactly what the sheet contains.

> **No `Return_ID` is needed.** An earlier design keyed writes on a `Return_ID`
> column, which meant a sheet without one could be priced but never saved. The
> CSV export lines up positionally instead, so the key column is gone. `Return_ID`
> is now only relevant to the optional Apps Script path, which matches by key
> rather than by position.

---

## 2. Enable reading (required)

Reading needs **one** thing: the sheet shared with **anyone who has the link**.
There is no API key, no Cloud project and no credential to rotate.

### Share the spreadsheet

**مشاركة ← anyone with the link ← Viewer.**

> Viewer is enough. The app never needs write access through the link — writes go
> through Apps Script (section 4) or through you pasting (section 3).

---

## 3. Configure the app

1. افتح `settings.html`.
2. في قسم **جلب البيانات**: الصق **رابط جدول Google Sheets كاملاً** (انسخه من
   شريط عنوان المتصفح) — لا حاجة إلى مفتاح API. اترك اسمَي الورقتين `Sales` و
   `Returns` إن كان ذلك اسمي ورقتيك.
3. اضغط **حفظ إعدادات القراءة**، ثم **اختبار قراءة الجدول**.
4. في قسم **الكتابة إلى الجدول (اختياري)**: اضبط **عملة العرض** (رمز ISO من
   ثلاثة أحرف — للعرض فقط، بلا تحويل عملات) و**حجم الدفعة**، ثم **حفظ إعدادات
   الكتابة**. اترك حقل رابط النشر فارغاً إذا كنت ستستخدم النسخ واللصق فقط.

A green **متصل** badge plus non-zero row counts means you are done. The Settings
page shows the row counts per tab and the sheet's timestamp, which is handy when
debugging.

> **The tab names must match exactly.** Google silently serves the *first* tab
> when it does not recognise a name, so a typo would show you the wrong data
> with total confidence. The app compares both responses and warns you when they
> come back identical.

Everything is stored in `localStorage` under the key `rps.config.v1`, per
browser and per device. Clearing it in the Settings page resets everything.

### 3. التصدير بدل الكتابة

If you skip Apps Script entirely, the CSV export does the whole job:

1. اضغط **٢ · معالجة وتسعير المرتجعات**.
2. اضغط **تصدير المرتجعات المسعَّرة (CSV)** to download the file, or
   **نسخ CSV** to put the identical text on the clipboard.
3. Either way, paste at **A1** of the `Returns` tab, or use
   *File → Import → Upload* with separator set to comma.

The output is the sheet, not a report about it — the same thirteen columns in the
same order, with the same header names, one line per return in the order it was
read:

```
Sales order,Customer account,CSName,Item,Name,Size,Color,Item group,Unit,Quantity,Unit_Price,Calculated_Value,Status
SO018842,CUST019303,رنين كهرباء قطعي,1003649,غلايه مياه 1.7 لتر,,Night grey,,قطعة,2,1250.75,2501.5,تم التسعير
SO018840,CUST014356,رنين تروما خفيف,1003306,عجان استيل 5.5 لتر,,Green,,قطعة,1,0,0,صنف / طلب غير موجود
```

Four details matter, and each has a failure it prevents:

- **Raw numbers.** `1250.75`, never `‏1,250.75 US$`. A thousands separator would
  be read as a second column, and a currency symbol would make the cell text that
  every downstream formula in the sheet silently ignores.
- **A UTF-8 BOM.** Without it, Sheets on Windows opens the file as Latin-1 and
  every Arabic customer name becomes mojibake.
- **CRLF line endings**, RFC 4180 quoting, and a quoted guard on any text
  beginning `=`, `+`, `-` or `@` so an imported cell cannot be evaluated as a
  formula.
- **Every row, including failures.** An unmatched row is exported as
  `0`, `0`, `صنف / طلب غير موجود` rather than being dropped or left blank, so
  the row count always matches the sheet and a blank cell is never ambiguous.

> **Ticking is the export scope.** All rows are ticked by default. Unticking
> *some* rows exports exactly those; unticking *all* of them exports all of them
> again — a selection is never allowed to silently produce an empty file.

---

## 4. الكتابة عبر Apps Script (اختياري)

Only needed if you want the **٣ · تنفيذ المرتجعات** button to write to the sheet
itself instead of exporting.

1. With the Sheet open, go to **Extensions → Apps Script**.
2. Delete the placeholder `myFunction` code in the editor.
3. Paste the entire contents of **`google-script.gs`**.
4. Press <kbd>Ctrl</kbd>+<kbd>S</kbd> to save.
5. In the editor's function dropdown choose **`setupSheets`** and click **Run**.
   - Approve the authorisation prompt when Google asks.
   - This creates/validates the two tabs, writes the header rows, and seeds a
     few demo rows if the sheet was empty.
6. Back in the Apps Script editor, click **Deploy → New deployment**.
   - **Select type:** Web app
   - **Description:** anything, e.g. `returns-pricing`
   - **Execute as:** **Me**
   - **Who has access:** **Anyone** ← *must be `Anyone`*
7. Click **Deploy**, then copy the **Web app URL**. It looks like:

   ```
   https://script.google.com/macros/s/AKfycbXXXXXXXXXXXXXXXX/exec
   ```

8. Paste it into **رابط تطبيق الويب الخاص بـ Google Apps Script** on the
   Settings page and press **حفظ إعدادات الكتابة**.

> **Why "Anyone"?** The write is a cross-origin `POST` from a page served from
> GitHub Pages, so the deployment has to be public. Read access is not affected
> either way — that goes through the public share link.

> **Editing the script later?** Apps Script keeps serving the *deployed*
> version. After any code change: **Deploy → Manage deployments → ✏️ →
> Version: New version → Deploy.** Skipping this is the single most common
> reason "my change had no effect".

---

## 5. تشغيل التطبيق (Run the app)

1. افتح `index.html`.
2. **١ · جلب البيانات** ← يسحب أحدث محتويات الجدول عبر رابط المشاركة.
3. **٢ · معالجة وتسعير المرتجعات** ← يملأ الجدول بالأسعار المطابقة والتنبيهات.
4. اختر كيف تخرج النتائج:
   - **تصدير المرتجعات المسعَّرة (CSV)** ← ينزّل الأعمدة الثلاثة عشر نفسها
     وبالترتيب نفسه، فيُلصق فوق ورقة `Returns` عند A1 أو يُستورد مباشرةً. لا
     يحتاج Apps Script ولا عمود `Return_ID`، وهو المسار الموصى به.
   - **نسخ CSV** ← نفس النص في الحافظة، للّصق مباشرةً.
   - **٣ · تنفيذ المرتجعات** ← (اختياري، إن كان رابط النشر مضبوطاً) تظهر نافذة
     تأكيد داخلية تعرض العدد والإجمالي، ثم تُكتب `Unit_Price` و
     `Calculated_Value` و `Status` في الجدول. تُعاد القراءة بعد الكتابة فترى ما
     وصل فعلياً، وتبقى القيم المحسوبة ظاهرة، ويُلغى التحديد حتى لا تُكتب الصفوف
     نفسها مرتين بالخطأ. هذا المسار وحده يحتاج عمود `Return_ID`، لأنه يطابق
     الصفوف بالمفتاح لا بالترتيب.
   - كل الصفوف محددة افتراضياً، بما فيها التي لم تُسعَّر — لأن التصدير يجب أن
     يعيد ورقة `Returns` كاملة. إلغاء تحديد جزء منها يصدّر ذلك الجزء فقط.

Progress and problems appear as toasts in the corner rather than as browser
dialogs, so nothing blocks the page while you are working. Confirmations can
always be dismissed with `Escape`, the **إلغاء** button, or a click on the
dimmed area behind the dialog. **إلغاء** is the button that gets focus, so a
stray `Enter` press will never write to your sheet by accident.

### localisation — التعريب

The localisation is deliberately split so the spreadsheet stays a stable machine
contract:

| Layer | Language | Why |
| --- | --- | --- |
| Sheet **tab and column names** | English (`Sales order`, `Unit_Price`, `Status`, …) | A contract shared with `google-script.gs` and with any pivot table, import, or BI tool reading the same sheet. Renaming these would silently break every existing sheet. |
| Sheet **`Status` values** | Arabic (`تم التسعير`) | The sheet is read by people sorting and filtering on this column, so it carries a language they read. |
| Everything the **user reads** | Arabic | Translated once at the UI boundary. |

Two constants in `app.js` define the two states, and they must match
`STATUS_PRICED` in `google-script.gs` byte for byte — a mismatch would make every
re-run re-price every row:

| Constant | Value | Meaning |
| --- | --- | --- |
| `STATUS_PRICED` | `تم التسعير` | matched and priced |
| `STATUS_NOT_FOUND` | `صنف / طلب غير موجود` | no matching sales line, or an unusable quantity |

Two functions bridge the contract and the display:

- `statusLabel(value)` — passes a known status through, maps `Pending` →
  `قيد الانتظار`. Unrecognised values are shown verbatim rather than hidden.
- `isPriced(value)` — tolerant on read: it accepts `تم التسعير` **and** the
  English `Priced` that an earlier build wrote, so a sheet priced by the
  previous version is not silently re-priced and re-written.

Other RTL details worth knowing if you edit the UI:

- `<html lang="ar" dir="rtl">` on both pages.
- The Arabic font is **Cairo**, with Latin fallbacks so SKU/ID columns stay
  legible for the Latin-script values they contain.
- Layout uses **logical** utilities (`ms-auto`, `pe-9`, `end-3`, `text-start`)
  instead of `ml-auto` / `pr-9` / `left-3` / `text-left`, so margins and icon
  placement mirror automatically.
- Numeric table cells carry `dir="ltr"`. Without it a value like `1,250.75` can
  get its digits and decimal point reordered by the surrounding RTL context.
- Numbers are formatted with `Intl` using `ar-EG-u-nu-latn`: **Arabic month
  names but Latin digits**, because the ID, SKU and quantity columns are all
  Latin script and mixing Arabic-Indic digits into the price column next to them
  makes a row much harder to scan. Currency placement follows the locale, so
  `USD` renders as `‏49.00 US$`.

### Pricing rules

Every row comes out **complete**. Nothing is dropped and nothing is left
half-written — a row either gets a real price or it gets zeros plus a status
saying why. That is a deliberate change from an earlier build which left
unmatched rows blank, because a blank cell in a report is ambiguous: it cannot be
distinguished from "not processed yet".

| Outcome | `Unit_Price` | `Calculated_Value` | `Status` |
| --- | --- | --- | --- |
| matched | from `Sales` | `Quantity × Unit_Price` | `تم التسعير` |
| no matching sales line | `0` | `0` | `صنف / طلب غير موجود` |
| quantity empty, non-numeric, or zero | `0` | `0` | `صنف / طلب غير موجود` |
| matching line's price is not a number | `0` | `0` | `صنف / طلب غير موجود` |

Other rules:

- `Calculated_Value = Quantity × Unit_Price`, rounded to 2 decimals.
- A **negative** quantity is priced by absolute value, so `-2` counts as `2`.
  Reported once per read, not per row — on a sheet where all 500 rows are
  negative, per-row reporting is unreadable.
- Rows already marked `تم التسعير` are skipped unless you tick
  **"إعادة احتساب الصفوف المسعَّرة مسبقاً"**. A skipped row keeps whatever the
  sheet already holds, so re-exporting a partly-priced sheet does not wipe the
  rows that were left alone.
- A descriptive column left blank on a `Returns` row is filled from the matched
  sales line. Existing values are never overwritten, and nothing is invented.
- The dashboard guarantees `matched + unmatched + skipped == total`, so the three
  headline numbers can be checked without reading the table.

### How a sale is found

The match key is **`Item` + `Customer account`**. The sales order is **never**
searched on — a return can be raised against an order the `Sales` tab does not
hold, and keying on the order would find nothing even though the same customer
demonstrably bought the same item. The order number is still displayed in the
table and the CSV; it just plays no part in finding a price.

That key is deliberately loose: one customer buying one item repeatedly spans
many sales lines, sometimes at different prices. The applicable one is chosen in
this order:

1. **Narrow by variant** — `Size` and `Color`, when the `Returns` row supplies
   them.
2. **Newest first** — ordered by the `Sales` `Date` column, never by position in
   the sheet.
3. **Skip sales that came back** — an order's quantities are netted across all
   its lines, so a sale returned in full is stepped over and the price falls back
   to the date before it.
4. **Within one date** — the line that most looks like an actual sale wins. See
   [Sales and returns share one order](#sales-and-returns-share-one-order).

- Case, padding, duplicate spaces and a leading apostrophe are ignored in every
  key, so `White`, `white ` and `'WHITE` are the same colour, and `CUST014356`
  matches `'cust014356 `.
- **A blank value is a wildcard, not a mismatch.** `Size` is empty on every row
  of many sheets; requiring it to be equal would make step 1 impossible and
  quietly fall back to the loosest match. A field only participates when both
  sides actually hold a value, so a return giving only a size matches any colour
  in that size.
- **An undated line sorts last.** An unknown date is not evidence of recency, and
  letting it win would override a real dated sale.
- **Only a fully returned sale is skipped.** A partially returned sale still
  stands, because some of that quantity is still the customer's.
- Both variant outcomes produce `Status = تم التسعير`. The difference is
  reported, not hidden: a row that matched on `Item` + `Customer account` alone
  carries a **بكود الصنف فقط** marker under its status badge, and the header card
  splits priced rows into `مطابقة للمقاس واللون` vs `بكود الصنف فقط`.
- Warnings — the row is still priced, and the note appears under its value:
  - **more than one price survived.** The note lists every alternative, so the
    choice is visible and reversible. Checked on the pool the price was actually
    chosen from, not on all candidates: a return giving a size but no colour can
    still land among several prices, which is a judgement call even though the
    variant matched;
  - **the newest sales were returned**, so an earlier date supplied the price.
    The note names the date actually used;
  - **every sale was returned**, so there is no current price at all; the last
    known one is used and flagged;
  - the returned quantity exceeds the quantity that was sold.

> **The looseness is real.** Because the order is not part of the key, a customer
> who bought the same item across several months contributes all of those sales as
> candidates. Where `Size` is blank in `Returns` nothing narrows them, and the
> newest wins — correct per the rule above, but a judgement call. The warning is
> what keeps that visible rather than silent.

### Sales and returns share one order

An order in these sheets does not only hold sales. When an item comes back, the
return is written against the **same order in the same row format**, with the
quantity negated and the unit price restated:

| order / item | qty | price |
| --- | --- | --- |
| `SO014253` / `1002321` | `0` | `1,149.00` |
| `SO014253` / `1002321` | `-89` | `999.63` |

Neither line is a clean positive sale, so "take the first row" or even "prefer
`qty > 0`" picks the wrong price and cannot explain itself. Candidates are ranked
by how much they look like a sale:

| Rank | Quantity | Why |
| --- | --- | --- |
| 1 | `> 0` | the sale |
| 2 | `= 0` | a sale netted out against its return twin — still the **original** unit price |
| 3 | `< 0` | the return itself; only reached when nothing better exists |
| 4 | blank | quantity unknown, so it proves nothing |

Rank 2 above rank 3 is the load-bearing one: the zeroed line keeps the original
price while the negative line carries the restated one. Ties break on sheet
order, so re-running gives the same answer.

The sold quantity used for the "returned more than sold" check is the **absolute
value** of the chosen line. Otherwise a line legitimately reading `0` or `-89`
would raise a bogus warning on an ordinary row.

> **`matched = 0` on a sheet full of returns is a data problem, not a bug.**
> Every row reports `صنف / طلب غير موجود` because the `Sales` tab contains none
> of the referenced orders. Adding those sales lines is what makes the rows price;
> nothing in the app can substitute for a missing sales record.

---

## 6. Deploy to GitHub Pages

```bash
git init
git add .
git commit -m "Returns Pricing System"
git branch -M main
git remote add origin https://github.com/<you>/<repo>.git
git push -u origin main
```

Then in the GitHub repo:

1. **Settings → Pages**
2. **Source:** Deploy from a branch
3. **Branch:** `main` / `/ (root)`
4. **Save**, wait for the green build, then open the printed URL
   (e.g. `https://<you>.github.io/<repo>/`).

Your app will be at `https://<you>.github.io/<repo>/index.html` and
`https://<you>.github.io/<repo>/settings.html`. Open Settings once there and
paste the web app URL — `localStorage` is per origin, so the value you saved
in dev does not travel to `github.io`.

> **Path note:** this app uses *relative* links (`./settings.html`) so it works
> at `user.github.io/repo/` as well as a custom domain. No `<base>` tag needed.

### Local preview

ES modules are blocked on `file://`, so serve the folder over HTTP:

```bash
npx serve .
# or
python -m http.server 8000
```

Then open `http://localhost:8000/`.

---

## API contract

### `GET` — read (public gviz endpoint, JSONP)

Two loads, one per tab, run in parallel. Each is a `<script src="…">`, which is
not subject to CORS:

```
https://docs.google.com/spreadsheets/d/<SPREADSHEET_ID>/gviz/tq
      ?tqx=out:javascript&sheet=<TAB_NAME>&tq=select%20*
```

The response is not JSON — it is a callback invocation, which is the whole trick:

```js
/*O_o*/
google.visualization.Query.setResponse({
  "status": "ok",
  "table": {
    "cols": [{ "id": "A", "label": "‎Sales order", "type": "string" },
             { "id": "J", "label": "Quantity",   "type": "number" }],
    "rows": [{ "c": [{ "v": "‎'SO000789" }, …,
                     { "v": 150, "f": "(150٫00)" }] }]
  }
});
```

`gvizRequest()` installs a stub for `google.visualization.Query.setResponse`
immediately before inserting the tag and removes it — along with the tag and any
previous `window.google` — as soon as the response arrives, so nothing leaks.

`gvizPayloadToValues()` then stitches `table.cols` and `table.rows` back into an
array-of-arrays and `rowsToObjects()` maps the header row onto the contract names
through `canonicalHeader()`. Only each cell's `v` (the raw value) is used, never
`f` (the locale-formatted display string) — otherwise a price would arrive as
`"(1٫00)"` instead of `-1`.

### Why this transport and not the others

| Option | Verdict |
| --- | --- |
| Sheets API v4 | Works, but demands an API key, a Cloud project, and Sheets-API enablement — and the key is readable by anyone who opens the page. |
| `/export?format=csv` | Sends `Access-Control-Allow-Origin: *`, so `fetch()` works — but it only accepts a numeric `gid`, and a `gid` cannot be derived from a share link. The user would be copying opaque ids by hand. |
| `/gviz/tq` | **Chosen.** No key, honours tab *names*, and a `<script>` tag sidesteps the missing CORS header entirely. |

The trade-off is that gviz does not report an unknown tab name — it quietly serves
the first tab. That single failure mode is checked explicitly by comparing the two
responses.

### `POST` — write (Apps Script, optional)

Only used by **٣ · تنفيذ المرتجعات**. Body is sent as `text/plain`; JSON either
way:

```json
{
  "action": "update",
  "updates": [
    { "Return_ID": "R-1001", "Unit_Price": 24.5, "Calculated_Value": 49, "Status": "تم التسعير" }
  ]
}
```

Single-row shorthand `{ "action": "update", "Return_ID": "...", "Calculated_Value": 0, "Status": "تم التسعير" }`
and `{ "action": "setup" }` are both accepted.

`Unit_Price` is optional in the payload — an older caller may omit it, and a sheet
laid out without that column still gets `Calculated_Value` and `Status` written.
`Status` defaults to `تم التسعير` when absent.

> **This path is the only thing that still needs a `Return_ID` column**, because
> it matches rows by key instead of by position. The CSV export does not.

```json
{ "ok": true, "action": "update", "updated": 1, "updatedIds": ["R-1001"], "notFound": [], "requested": 1 }
```

### How cross-origin is handled

Apps Script's `ContentService` will not let a script set its own response
headers, so the usual "add CORS headers" fix is unavailable there. Reading was
therefore moved off Apps Script entirely:

| Verb | Mechanism | Why |
| --- | --- | --- |
| `GET` | `<script src>` pointing at the gviz endpoint | A `<script>` tag is not subject to CORS. gviz needs no key and honours tab *names*, unlike the `gid`-only CSV export. |
| `POST` | `fetch()` with `Content-Type: text/plain` | A "simple request" is never pre-flighted, so no `OPTIONS` handler is needed (Apps Script has none). The JSON body still arrives intact in `doPost()`. |

This replaces two earlier attempts. The first was JSONP against the Apps Script
deployment, which failed completely the moment the deployment was not public and
failed with no useful diagnostic (`script.onerror` cannot see the status). The
second was the Sheets REST API, which worked but required an API key and a Cloud
project — friction the user should not have to carry to read their own sheet.
Reading now depends on nothing but the share link.

Apps Script issues a `302` from `script.google.com` to `script.googleusercontent.com`;
`fetch` follows it automatically. Both hosts are accepted by
`describeUrlProblem()`, which only guards the write path now.

For local development the read base URL can be pointed at a stub by setting
`window.GVIZ_BASE` before the first read; unset in normal use.

---

## Troubleshooting

The app never uses blocking browser dialogs, so a frozen `alert`/`confirm` is no
longer a possible cause of a dead button. Messages you see in the table, toasts
and the confirm dialog appear in Arabic.

| Symptom | Cause / fix |
| --- | --- |
| «تعذّر الوصول إلى Google Sheets» | Almost always sharing: the spreadsheet is not **anyone with the link**. Open it → مشاركة → anyone with the link → **Viewer**. |
| «الورقتان أعادتا نفس البيانات» | One tab name is misspelled. Google serves the first tab silently instead of erroring, so the app compares both responses and warns. |
| Every row shows `صنف / طلب غير موجود` | The `Sales` tab has no row with that `Item` **and** `Customer account`. The order is *not* consulted, so this means the customer genuinely never bought the item. A common cause is a customer-account code that differs between the two tabs — check the two tabs spell it the same way. |
| The same SKU is not found for a customer who clearly bought it | Compare the `Customer account` values in both tabs. They must match after case/padding/apostrophe normalisation; a code stored as text in one tab and a number in the other will not join. |
| All columns of the table are `—` | The descriptive columns (`Size`, `Color`, `Item group`) are genuinely empty in the `Returns` tab. Pricing is unaffected; the cells are filled from the matched sales line only when a row matches. |
| «الكمية سالبة» | The `Returns` tab records returns as negative numbers. Prices use the absolute value; the app says so once per read. |
| `Network/CORS error` on **تنفيذ المرتجعات** | Apps Script deployment access is not **Anyone**. Edit the deployment → new version — or just use **تصدير CSV**, which needs no deployment. |
| `The server did not return JSON` / «لم يُرجع الخادم بيانات JSON» | Wrong write URL. Use the `/exec` deployment URL, not `/dev` or the editor link. |
| `Request timed out` / «انتهت مهلة الطلب» | Apps Script cold start plus a big sheet. Raise the timeout, or check the script's execution log. |
| `Return_ID … not found in the sheet` | The ID in your payload is not in column A of `Returns`. |
| `No sale found for SO-5001 / SKU-RED-01` / «لا يوجد سجل بيع مطابق لـ …» | No matching `Sales` row. Matching ignores case and padding, not typos. |
| **تصدير CSV** / **نسخ CSV** does nothing | Nothing has been processed yet — both stay disabled until step ٢ produces rows. |
| Arabic text is mojibake after *File → Import* | The import dialog overrode the separator or the encoding. The file already carries a UTF-8 BOM; choose **comma** as the separator and let the encoding be detected. |
| The pasted export shifted one column | It was pasted at A2, or into a sheet whose header row is not the thirteen columns above. The export includes its own header line, so it must land on **A1** of an empty tab — or use *File → Import*, which replaces the tab. |
| A pasted value shows as `1,250.75 US$` instead of a number | That came from copying the *table* rather than the CSV. The CSV always writes raw numbers; display formatting is never exported. |
| Clipboard is empty after copying | `navigator.clipboard` needs a secure origin; `http://` (other than `localhost`) falls back to `execCommand`, which some browsers block. Use **تصدير CSV** instead — it does not touch the clipboard. |
| Page is blank on double-click / «صفحة فارغة» | ES modules need HTTP. Run `npx serve .`. |
| Code edits have no effect in Apps Script | Redeploy a **new version** of the deployment. |
| Values shift or vanish in the sheet | A formula or a sheet "calculate on edit" setting is overwriting the writes. Use plain numbers, or protect the `Unit_Price`, `Calculated_Value` and `Status` columns. |

### Apps Script API quotas

Writes are grouped into contiguous row ranges, so a 200-row execute is a couple
of API calls rather than 400. Google Apps Script allows ~50,000 calls/day per
project, which leaves plenty of headroom. Concurrent writers are serialised with
a `LockService` script lock, so two people pressing *Execute* at the same moment
cannot corrupt each other's writes.

---

## Safety notes

The read path stores **nothing sensitive**: no API key, no credential, no token.
The only thing in `localStorage` is the spreadsheet id, the two tab names, and
your display preferences.

What that buys you, and what it does not:

- **Anyone who has the share link can already read the sheet** — that is the
  sharing setting you chose, not something the app adds. Removing the API key
  removed a *second* copy of that access; it did not create the first one. If
  the data is sensitive, the right control is Google sharing, not a key.
- **No quota to exhaust and nothing to rotate.** There is no credential to leak
  out of a browser or out of a Git repository.
- Keep **editors** limited to your team; readers do not need edit access.
- The Apps Script `/exec` URL *is* a secret: anyone holding it can trigger writes
  (though not edit the script itself unless they are a project editor). If you
  skip Apps Script, that whole exposure disappears.
- For real workloads, front it with Google OAuth or move the logic server-side.

All sheet-derived values are HTML-escaped before rendering, so a SKU containing
`<script>` renders as text rather than executing.