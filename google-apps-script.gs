/**
 * MONITORING SHEET → GOOGLE SHEETS SYNC
 * =====================================
 * Paste this whole file into the Apps Script editor attached to the
 * Google Sheet you want the Monitoring Sheet mirrored into.
 *
 * SETUP
 * 1. Open (or create) the target Google Sheet.
 * 2. Extensions → Apps Script.
 * 3. Delete any placeholder code, paste this file in, and replace
 *    SHARED_SECRET below with a long random string of your choosing —
 *    use the SAME string as the GOOGLE_SHEETS_SECRET env var in Vercel.
 * 4. Deploy → New deployment → type: Web app.
 *      Execute as: Me
 *      Who has access: Anyone
 *    (This has to be "Anyone" so the Vercel function can reach it — the
 *    shared secret below is what actually protects it from strangers.)
 * 5. Copy the Web App URL it gives you (ends in /exec) — that's your
 *    GOOGLE_SHEETS_WEBHOOK_URL env var in Vercel.
 * 6. In the Vercel dashboard: Settings → Environment Variables, add:
 *      GOOGLE_SHEETS_WEBHOOK_URL = (the URL from step 5)
 *      GOOGLE_SHEETS_SECRET      = (the same string from step 3)
 *    Redeploy the project.
 * That's it — every Monitoring Sheet change will now also write into a
 * "Monitoring Sheet" tab in this spreadsheet, created automatically the
 * first time a row comes in.
 *
 * If you ever edit and re-deploy this script, choose "New deployment"
 * again (not just save) — otherwise the live URL keeps running the old
 * code.
 */

var SHEET_NAME = 'Monitoring Sheet';
var SHARED_SECRET = 'REPLACE_WITH_A_LONG_RANDOM_STRING';
var HEADERS = ['ID', 'Date', 'J.O. No', 'Client Name', 'Description', 'Qty',
               'Grand Total', 'Material', 'Status', 'Artist', 'Machine',
               'ICC Profile', 'Due Date', 'Remarks', 'Last Synced'];

function doPost(e) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var payload = JSON.parse(e.postData.contents);

    if (SHARED_SECRET && payload.secret !== SHARED_SECRET) {
      return respond({ ok: false, error: 'Bad secret' });
    }

    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
    if (!sheet) {
      sheet = SpreadsheetApp.getActiveSpreadsheet().insertSheet(SHEET_NAME);
    }
    if (sheet.getLastRow() === 0) {
      sheet.appendRow(HEADERS);
      sheet.setFrozenRows(1);
    }

    if (payload.action === 'delete') {
      deleteRowById(sheet, payload.id);
      return respond({ ok: true, deleted: payload.id });
    }

    var row = payload.row;
    if (!row || !row.id) {
      return respond({ ok: false, error: 'Missing row data' });
    }

    var values = [
      row.id, row.date || '', row.joNumber || '', row.clientName || '',
      row.description || '', row.qty || '', row.grandTotal || '', row.material || '',
      row.status || '', row.artist || '', row.machine || '', row.icc || '',
      row.dueDate || '', row.remarks || '', new Date()
    ];

    var data = sheet.getDataRange().getValues();
    var rowIndex = -1;
    for (var i = 1; i < data.length; i++) {
      if (String(data[i][0]) === String(row.id)) {
        rowIndex = i + 1; // Sheet rows are 1-indexed, and row 1 is headers.
        break;
      }
    }

    if (rowIndex > 0) {
      sheet.getRange(rowIndex, 1, 1, values.length).setValues([values]);
    } else {
      sheet.appendRow(values);
    }

    return respond({ ok: true });
  } catch (err) {
    return respond({ ok: false, error: String(err) });
  } finally {
    lock.releaseLock();
  }
}

function deleteRowById(sheet, id) {
  var data = sheet.getDataRange().getValues();
  for (var i = data.length - 1; i >= 1; i--) {
    if (String(data[i][0]) === String(id)) {
      sheet.deleteRow(i + 1);
    }
  }
}

function respond(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
