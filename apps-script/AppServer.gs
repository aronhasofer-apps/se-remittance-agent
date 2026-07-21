/**
 * ================================================================
 *  SE REMITTANCE AGENT — WEB APP (shell + QA Cleanup page)
 * ================================================================
 *  Deployed as a web app (Deploy > New deployment > Web app,
 *  "Execute as: me", "Who has access: anyone in scienceexchange.com").
 *  Opens to the QA Cleanup page. Review / Settings / Run-log pages
 *  slot into the same shell next.
 *
 *  Safety model:
 *    • The scan only READS. It proposes; the user disposes.
 *    • Trash = Drive Trash (recoverable 30 days), never permanent.
 *    • Rename fixes filenames only. It NEVER edits invoices inside a
 *      file — corrupted-invoice files are flagged "re-extraction
 *      needed" instead of being silently half-fixed.
 *    • Files in the LIVE folder are marked live so the user always
 *      knows when acting on the real destination vs staging.
 */

// Live destination finance applies from.
const LIVE_FOLDER_ID = '1sx3PiXDdxu3jRKcvJR-f4sZi2Bn8q44P';

// ------------------------- Web app entry -------------------------

function doGet() {
  return HtmlService.createTemplateFromFile('App')
    .evaluate()
    .setTitle('SE Remittance Agent')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/** Lets the HTML pull in shared partials if we split files later. */
function include(name) {
  return HtmlService.createHtmlOutputFromFile(name).getContent();
}

/** Who is signed in — used for the run log and the header. */
function getActiveUser_() {
  try { return Session.getActiveUser().getEmail() || 'unknown'; }
  catch (e) { return 'unknown'; }
}

// --------------------------- QA SCAN ----------------------------

/**
 * Scans the staging folder + the live folder, returns a list of
 * flagged files with the issues found and (where possible) a
 * proposed corrected filename. READ ONLY.
 *
 * Returns { generatedAt, folders:[{id,name,live}], rows:[...] }
 */
function qaScan() {
  const staging = getStagingFolder_(); // reuse the engine's helper
  const targets = [
    { id: staging.getId(), name: staging.getName(), live: false },
    { id: LIVE_FOLDER_ID, name: 'remits not applied (LIVE)', live: true },
  ];

  const rows = [];
  targets.forEach(function (t) {
    let folder;
    try { folder = DriveApp.getFolderById(t.id); } catch (e) { return; }
    const it = folder.getFilesByType('application/pdf');
    while (it.hasNext()) {
      const f = it.next();
      const name = f.getName();
      const analysis = analyzeFilename_(name);
      if (analysis.issues.length) {
        rows.push({
          id: f.getId(),
          name: name,
          url: f.getUrl(),
          folderName: t.name,
          live: t.live,
          issues: analysis.issues,
          severity: analysis.severity,           // 'high' | 'medium' | 'low'
          proposedName: analysis.proposedName,    // '' if not auto-fixable
          reextractNeeded: analysis.reextractNeeded,
        });
      }
    }
  });

  // Duplicate detection across everything scanned (same proposed/target name).
  const byName = {};
  rows.forEach(function (r) {
    const key = (r.proposedName || r.name).toLowerCase();
    (byName[key] = byName[key] || []).push(r);
  });
  Object.keys(byName).forEach(function (k) {
    if (byName[k].length > 1) {
      byName[k].forEach(function (r) {
        if (r.issues.indexOf('possible duplicate') === -1) r.issues.push('possible duplicate');
      });
    }
  });

  // High severity first, live folder first within that.
  const rank = { high: 0, medium: 1, low: 2 };
  rows.sort(function (a, b) {
    if (rank[a.severity] !== rank[b.severity]) return rank[a.severity] - rank[b.severity];
    return (b.live ? 1 : 0) - (a.live ? 1 : 0);
  });

  return {
    generatedAt: Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm'),
    user: getActiveUser_(),
    folders: targets,
    rows: rows,
  };
}

/**
 * Inspect a filename against the SE convention and the failure
 * patterns seen in production. Returns issues + a proposed fix.
 *
 * Convention: "$Amount PayorName[ CUR].pdf"
 *   - leading $, amount with commas & 2 decimals
 *   - short payor name, spaces not underscores
 *   - currency suffix only if non-USD
 */
function analyzeFilename_(filename) {
  const issues = [];
  let severity = 'low';
  let reextractNeeded = false;

  const base = filename.replace(/\.pdf$/i, '');

  // 1. Subject-line-style payor (marketing tail from Ramp emails).
  const marketingTail = /(is on the way|get paid instantly|will be deposited|has sent you|sent you a payment|received your invoice|— get paid)/i;
  const hasMarketing = marketingTail.test(base);
  if (hasMarketing) { issues.push('payor looks like an email subject'); severity = 'high'; }

  // 2. Rule-id-as-name (the phase-2 naming bug).
  if (/\bextract_from_body\b|\bbill-arriving\b|\bmerck-body\b|_body\b/i.test(base)) {
    issues.push('filename contains a rule id, not a payor');
    severity = 'high';
  }

  // 3. Leading-$ + amount shape.
  const m = base.match(/^\$([\d,]*\.?\d*)\s+(.+)$/);
  if (!m) {
    issues.push('does not match "$Amount Payor" pattern');
    severity = 'high';
  }

  // 4. Amount formatting (commas + 2 decimals).
  let amountText = m ? m[1] : '';
  let payorPart = m ? m[2] : base;
  if (amountText && !/^\d{1,3}(,\d{3})*\.\d{2}$/.test(amountText)) {
    issues.push('amount not formatted with commas/2 decimals');
    if (severity === 'low') severity = 'medium';
  }

  // 5. Underscores where spaces belong (ignore the legit _2/_3 dup suffix).
  const payorNoDupSuffix = payorPart.replace(/_(\d+)$/, '');
  if (/_/.test(payorNoDupSuffix)) {
    issues.push('underscores in payor name');
    if (severity === 'low') severity = 'medium';
  }

  // 6. Currency suffix sanity: if a code is present it must be a known one.
  const curMatch = payorPart.match(/\b(USD|GBP|EUR|CAD|CHF|JPY|AUD)\b/);
  if (/\bUSD\b/.test(payorPart)) {
    issues.push('USD should have no currency suffix');
    if (severity === 'low') severity = 'medium';
  }

  // Build a proposed corrected name where we safely can (filename-only fixes).
  let proposedName = '';
  if (issues.length) {
    let payor = payorPart;

    // Strip a marketing tail: cut at the first marketing phrase.
    payor = payor.replace(/\s*(?:—|-)?\s*(is on the way.*|get paid instantly.*|will be deposited.*|has sent you.*|sent you a payment.*|received your invoice.*)$/i, '').trim();

    // If it's a rule id, we cannot invent a payor — needs re-extraction.
    if (/^(extract_from_body|bill-arriving|merck-body|.*_body)$/i.test(payor) || payor === '') {
      reextractNeeded = true;
    }

    // Preserve a real _2/_3 suffix.
    const dup = (payorPart.match(/_(\d+)$/) || [])[0] || '';
    payor = payor.replace(/_(\d+)$/, '').trim();

    // Drop USD suffix; keep non-USD.
    payor = payor.replace(/\s+USD\b/,'').trim();

    // Underscores -> spaces (outside dup suffix).
    payor = payor.replace(/_/g, ' ').replace(/\s+/g, ' ').trim();

    // Strip corporate suffixes for the short name.
    for (let g = 0; g < 3; g++) {
      payor = payor.replace(/[,\s]+(Inc\.?|LLC\.?|Ltd\.?|Limited|Incorporated|Corp\.?|Corporation|Co\.)\s*$/i, '');
    }
    payor = payor.trim();

    if (!reextractNeeded && amountText && /^\d{1,3}(,\d{3})*\.\d{2}$/.test(amountText) && payor) {
      const cur = (curMatch && curMatch[1] !== 'USD') ? ' ' + curMatch[1] : '';
      // remove the currency token from payor body to avoid duplication
      const payorClean = payor.replace(/\b(GBP|EUR|CAD|CHF|JPY|AUD)\b/,'').replace(/\s+/g,' ').trim();
      proposedName = '$' + amountText + ' ' + payorClean + cur + dup + '.pdf';
      if (proposedName === filename) proposedName = ''; // no change needed
    }
  }

  // Corrupted invoice inside the file can't be seen from the name alone,
  // but a rule-id / empty payor always implies the source needs re-extraction.
  return { issues: issues, severity: severity, proposedName: proposedName, reextractNeeded: reextractNeeded };
}

// --------------------------- ACTIONS ----------------------------

/**
 * Trash the given file IDs (Drive Trash — recoverable 30 days).
 * Only IDs the user explicitly selected are passed in.
 */
function qaTrash(ids) {
  const results = [];
  (ids || []).forEach(function (id) {
    try {
      const f = DriveApp.getFileById(id);
      const name = f.getName();
      f.setTrashed(true);
      results.push({ id: id, ok: true, name: name });
    } catch (e) {
      results.push({ id: id, ok: false, error: String(e) });
    }
  });
  logQaAction_('TRASH', results);
  return results;
}

/**
 * Rename files to their proposed corrected names.
 * Payload: [{id, newName}]. Filename-only change; file bytes untouched.
 */
function qaRename(items) {
  const results = [];
  (items || []).forEach(function (it) {
    try {
      if (!it.newName || !/\.pdf$/i.test(it.newName)) {
        throw new Error('invalid target name');
      }
      const f = DriveApp.getFileById(it.id);
      const oldName = f.getName();
      f.setName(it.newName);
      results.push({ id: it.id, ok: true, from: oldName, to: it.newName });
    } catch (e) {
      results.push({ id: it.id, ok: false, error: String(e) });
    }
  });
  logQaAction_('RENAME', results);
  return results;
}

/** Append QA actions to the log spreadsheet on a dedicated tab. */
function logQaAction_(kind, results) {
  try {
    const log = getLog_();
    let sheet = log.ss.getSheetByName('QA Actions');
    if (!sheet) {
      sheet = log.ss.insertSheet('QA Actions');
      sheet.appendRow(['When', 'User', 'Action', 'Detail', 'OK']);
      sheet.setFrozenRows(1);
    }
    const when = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm');
    const user = getActiveUser_();
    results.forEach(function (r) {
      const detail = kind === 'RENAME'
        ? (r.ok ? (r.from + '  ->  ' + r.to) : (r.id + ': ' + r.error))
        : (r.ok ? r.name : (r.id + ': ' + r.error));
      sheet.appendRow([when, user, kind, detail, r.ok ? 'yes' : 'NO']);
    });
  } catch (e) { /* logging must never break the action */ }
}

/** Public wrapper so the web app UI can show the signed-in user (google.script.run
 *  cannot call functions whose names end in an underscore). */
function getSignedInEmail() {
  return getActiveUser_();
}
