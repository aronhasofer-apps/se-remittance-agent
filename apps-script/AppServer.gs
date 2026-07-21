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

// ============================================================
//  REVIEW PAGE — what the engine pulled, the method it used,
//  and per-item controls. Reads the log's Messages + Saved tabs.
// ============================================================

/**
 * Assembles the Review view from the most recent run's logged rows.
 * Groups into toProcess (saved / generated / flagged / duplicate) and
 * skipped. READ ONLY — changing an action or creating a rule is a
 * separate explicit call.
 *
 * Returns { generatedAt, user, mode, lastRunAt, toProcess:[...], skipped:[...], counts:{...} }
 */
function reviewData() {
  const log = getLog_();
  const tz = Session.getScriptTimeZone();

  // Column layout of the Messages tab (see MESSAGE_HEADERS in the engine):
  // 0 Logged at | 1 Email date | 2 Found in | 3 From | 4 Subject | 5 PDF attached
  // 6 Verdict | 7 Rule matched | 8 Payor short name | 9 Outcome | 10 Note
  // 11 Message ID | 12 Open in Gmail | 13 Amount | 14 Currency | 15 Invoices | 16 Filename | 17 File link
  const msgs = log.messages;
  const last = msgs.getLastRow();
  const toProcess = [];
  const skipped = [];
  const counts = { saved:0, generated:0, flagged:0, duplicate:0, skipped:0, already:0 };

  if (last >= 2) {
    // Most recent first; cap at the last 200 logged rows so the page stays fast.
    const startRow = Math.max(2, last - 199);
    const rng = msgs.getRange(startRow, 1, last - startRow + 1, 18).getValues();
    for (let i = rng.length - 1; i >= 0; i--) {
      const r = rng[i];
      const outcome = String(r[9] || '').toUpperCase();
      const item = {
        loggedAt: fmtCell_(r[0], tz),
        emailDate: fmtCell_(r[1], tz),
        foundIn: r[2] || '',
        from: r[3] || '',
        subject: r[4] || '',
        hasPdf: String(r[5] || '').toLowerCase() === 'yes',
        verdict: r[6] || '',
        rule: r[7] || '',
        payor: r[8] || '',
        outcome: outcome,
        note: r[10] || '',
        messageId: r[11] || '',
        gmailUrl: r[12] || '',
        amount: r[13] || '',
        currency: r[14] || '',
        invoices: r[15] || '',
        filename: r[16] || '',
        fileUrl: r[17] || '',
        // Method, in the finance-user vocabulary from the old app.
        method: methodLabel_(r[6], r[5]),
        // The action currently in effect, and what it can be changed to.
        action: outcomeToAction_(outcome),
      };

      if (outcome === 'SKIPPED' || outcome === 'ALREADY PROCESSED') {
        skipped.push(item);
        if (outcome === 'SKIPPED') counts.skipped++; else counts.already++;
      } else {
        toProcess.push(item);
        if (outcome === 'SAVED') counts.saved++;
        else if (outcome === 'GENERATED') counts.generated++;
        else if (outcome === 'DUPLICATE') counts.duplicate++;
        else counts.flagged++;
      }
    }
  }

  // Last run summary from the Runs tab.
  let lastRunAt = '', lastRunSummary = '';
  const runs = log.runs;
  const lr = runs.getLastRow();
  if (lr >= 2) {
    const rr = runs.getRange(lr, 1, 1, 8).getValues()[0];
    lastRunAt = fmtCell_(rr[0], tz);
    lastRunSummary = rr[7] || '';
  }

  return {
    generatedAt: Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd HH:mm'),
    user: getActiveUser_(),
    mode: (typeof CONFIG !== 'undefined' && CONFIG.MODE) ? CONFIG.MODE : 'shadow',
    lastRunAt: lastRunAt,
    lastRunSummary: lastRunSummary,
    toProcess: toProcess,
    skipped: skipped,
    counts: counts,
  };
}

/** Human method label in the old app's vocabulary. */
function methodLabel_(verdict, hasPdf) {
  const v = String(verdict || '').toLowerCase();
  if (v.indexOf('save_attachment') !== -1 || v.indexOf('save attachment') !== -1) return 'Save attachment';
  if (v.indexOf('extract_body') !== -1 || v.indexOf('extract body') !== -1) return 'Extract from body';
  if (v.indexOf('skip') !== -1) return 'Skip';
  if (v.indexOf('flag') !== -1) return 'Flag for review';
  return String(hasPdf).toLowerCase() === 'yes' ? 'Save attachment' : 'Extract from body';
}

/** Map a logged outcome to the currently-effective action key. */
function outcomeToAction_(outcome) {
  switch (String(outcome).toUpperCase()) {
    case 'SAVED': return 'save_attachment';
    case 'GENERATED': return 'extract_body';
    case 'SKIPPED': return 'skip';
    case 'ALREADY PROCESSED': return 'skip';
    case 'DUPLICATE': return 'skip';
    default: return 'flag';
  }
}

/**
 * Trigger the engine on demand (the "Re-run" control). Runs the same
 * scan the 10-minute trigger runs. Returns the fresh summary.
 */
function reviewRerun() {
  runRemittanceScan();          // the engine's entry point
  const log = getLog_();
  const lr = log.runs.getLastRow();
  let summary = '';
  if (lr >= 2) summary = log.runs.getRange(lr, 8).getValue() || '';
  return { ok: true, summary: summary, at: Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm') };
}

/**
 * Create a rule from the Review page (the old app's "Create Rule").
 * Adds/updates a local override in Script Properties that the engine
 * layers on top of the GitHub rules on the next run. This does NOT push
 * to GitHub — it's a per-deployment override the user controls.
 * payload: { match:{subject_contains?:[], from_contains?:[]}, action, short_name }
 */
function reviewCreateRule(payload) {
  try {
    if (!payload || !payload.action) throw new Error('missing action');
    const props = PropertiesService.getScriptProperties();
    const raw = props.getProperty('LOCAL_RULES');
    const list = raw ? JSON.parse(raw) : [];
    list.push({
      id: 'local-' + Date.now(),
      match: payload.match || {},
      action: payload.action,
      short_name: payload.short_name || '',
      created: new Date().toISOString(),
      createdBy: getActiveUser_(),
    });
    props.setProperty('LOCAL_RULES', JSON.stringify(list));
    return { ok: true, count: list.length };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

/** Format a sheet cell that may be a Date or a string. */
function fmtCell_(v, tz) {
  if (v instanceof Date) return Utilities.formatDate(v, tz, 'yyyy-MM-dd HH:mm');
  return v == null ? '' : String(v);
}

// ============================================================
//  SETTINGS PAGE — read/write the engine's tunable config,
//  manage UI-created local rules, force a rules refresh.
// ============================================================

/** Current effective settings + the CONFIG defaults, for the Settings page. */
function getSettings() {
  const p = PropertiesService.getScriptProperties();
  const eff = effectiveConfig_();
  // Local rules created via the UI.
  let local = [];
  try { const raw = p.getProperty('LOCAL_RULES'); if (raw) local = JSON.parse(raw); } catch (e) {}
  // Rules version currently cached from GitHub.
  let rulesVersion = '?', rulesCount = 0, rulesSource = '';
  try {
    const cached = p.getProperty('RULES_CACHE');
    if (cached) { const parsed = JSON.parse(cached); rulesVersion = parsed.version || '?'; rulesCount = (parsed.rules||[]).length; }
  } catch (e) {}
  return {
    user: getActiveUser_(),
    mode: eff.mode,
    lookbackDays: eff.lookbackDays,
    maxPerRun: eff.maxPerRun,
    defaults: { mode: CONFIG.MODE, lookbackDays: CONFIG.LOOKBACK_DAYS, maxPerRun: CONFIG.MAX_PROCESS_PER_RUN },
    triggerMinutes: CONFIG.TRIGGER_MINUTES,
    groupAddress: CONFIG.GROUP_ADDRESS,
    rulesUrl: CONFIG.RULES_URL,
    rulesVersion: rulesVersion,
    rulesCount: rulesCount,
    localRules: local,
    markerLabel: CONFIG.MARKER_LABEL,
  };
}

/**
 * Save settings from the UI. Mode change to 'live' is the one sensitive control:
 * the caller passes confirmLive:true, set by an explicit confirm in the UI.
 * payload: { mode, lookbackDays, maxPerRun, confirmLive }
 */
function saveSettings(payload) {
  const p = PropertiesService.getScriptProperties();
  const out = { ok: true, changed: [] };
  if (payload.mode === 'live' && !payload.confirmLive) {
    return { ok: false, error: 'Switching to LIVE mode requires explicit confirmation.' };
  }
  if (payload.mode === 'shadow' || payload.mode === 'live') {
    p.setProperty('SET_MODE', payload.mode); out.changed.push('mode');
  }
  const lb = Number(payload.lookbackDays);
  if (isFinite(lb) && lb >= 1 && lb <= 60) { p.setProperty('SET_LOOKBACK_DAYS', String(lb)); out.changed.push('lookback'); }
  const mx = Number(payload.maxPerRun);
  if (isFinite(mx) && mx >= 1 && mx <= 100) { p.setProperty('SET_MAX_PER_RUN', String(mx)); out.changed.push('maxPerRun'); }
  return out;
}

/** Delete a UI-created local rule by its id. */
function deleteLocalRule(ruleId) {
  const p = PropertiesService.getScriptProperties();
  let local = [];
  try { const raw = p.getProperty('LOCAL_RULES'); if (raw) local = JSON.parse(raw); } catch (e) {}
  const before = local.length;
  local = local.filter(function(r){ return r.id !== ruleId; });
  p.setProperty('LOCAL_RULES', JSON.stringify(local));
  return { ok: true, removed: before - local.length, remaining: local.length };
}

/** Force-refresh the GitHub rules cache now (Settings > Refresh rules). */
function refreshRulesNow() {
  try {
    const r = loadRules_();
    return { ok: true, version: r.version, count: (r.list||[]).length, source: r.source, localCount: r.localCount || 0 };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

// ============================================================
//  RUN LOG PAGE — the actual run history from the Runs tab.
// ============================================================

/** Returns the most recent runs (newest first) for the Run Log page. */
function getRunLog(limit) {
  const log = getLog_();
  const tz = Session.getScriptTimeZone();
  const runs = log.runs;
  const last = runs.getLastRow();
  const rows = [];
  if (last >= 2) {
    const n = Math.min(limit || 40, last - 1);
    const startRow = last - n + 1;
    // RUN_HEADERS: 0 Run at | 1 In window | 2 New logged | 3 Rules loaded | 4 Rules version | 5 Rules source | 6 Error | 7 Outcomes
    const rng = runs.getRange(startRow, 1, n, 8).getValues();
    for (let i = rng.length - 1; i >= 0; i--) {
      const r = rng[i];
      rows.push({
        at: fmtCell_(r[0], tz),
        inWindow: r[1],
        newLogged: r[2],
        rulesLoaded: r[3],
        rulesVersion: r[4],
        rulesSource: r[5],
        error: r[6] || '',
        outcomes: r[7] || '',
      });
    }
  }
  // Also surface recent saved files (Saved tab) as a secondary feed.
  let saved = [];
  try {
    const sv = log.ss.getSheetByName('Saved');
    if (sv) {
      const lr = sv.getLastRow();
      if (lr >= 2) {
        const m = Math.min(20, lr - 1);
        const srng = sv.getRange(lr - m + 1, 1, m, 9).getValues();
        for (let i = srng.length - 1; i >= 0; i--) {
          const s = srng[i];
          saved.push({ at: fmtCell_(s[0], tz), filename: s[1], amount: s[2], currency: s[3],
            invoices: s[4], payor: s[5], subject: s[6], fileUrl: s[8] });
        }
      }
    }
  } catch (e) {}
  return { user: getActiveUser_(), generatedAt: Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd HH:mm'), runs: rows, saved: saved };
}
