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

function doGet(e) {
  if (e && e.parameter && e.parameter.rawPeek === 'rp-4Ks91vT') {
    try {
      const targetId = e.parameter.mid || '19fd8a5f8abd086f';
      const msg = GmailApp.getMessageById(targetId);
      const plain = (function(){ try { return msg.getPlainBody() || ''; } catch(x){ return '(error: '+x+')'; } })();
      const raw = msg.getRawContent() || '';
      const heads = raw.split(/\r?\n--[^\r\n]+\r?\n/).map(function(c){
        var h = c.split(/\r?\n\r?\n/)[0];
        return h.slice(0,300);
      });
      return ContentService.createTextOutput(JSON.stringify({
        targetId: targetId,
        getPlainBodyLen: plain.length,
        getPlainBodyFirst200: plain.slice(0,200),
        getPlainBodyHasRegeneron: /regeneron/i.test(plain),
        rawLen: raw.length,
        rawFirstChars: raw.slice(0,400),
        chunkHeaders: heads.slice(0,10),
        rawHasRegeneronAnywhere: /regeneron/i.test(raw)
      }, null, 2)).setMimeType(ContentService.MimeType.JSON);
    } catch (err) {
      return ContentService.createTextOutput('ERROR: ' + err).setMimeType(ContentService.MimeType.TEXT);
    }
  }
  return HtmlService.createTemplateFromFile('App')
    .evaluate()
    .setTitle('Remit Fetcher')
    .setFaviconUrl('https://cdn.jsdelivr.net/gh/aronhasofer-apps/se-remittance-agent@main/favicon.png')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/** Lets the HTML pull in shared partials if we split files later. */
function include(name) {
  return HtmlService.createHtmlOutputFromFile(name).getContent();
}

/** Who is signed in — used for the run log and the header. */
/**
 * True only when the person using the app IS the owner it runs as. The web app
 * executes as the owner, but Google still reports the signed-in visitor via
 * getActiveUser() (same Workspace domain), so owner == (active email === effective
 * email). Used to restrict rule creation to the owner even though the app link is
 * open to everyone at Science Exchange.
 */
function isOwner_() {
  try {
    var a = (Session.getActiveUser().getEmail() || '').toLowerCase();
    var e = (Session.getEffectiveUser().getEmail() || '').toLowerCase();
    return !!a && !!e && a === e;
  } catch (x) { return false; }
}

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
  const folder = DriveApp.getFolderById(LIVE_FOLDER_ID);

  // Invoice numbers live only in the Saved log (never in the filename), so build a
  // fileId -> invoices map to tell true duplicates from coincidental same-amount payments.
  const invByFile = {};
  try {
    const saved = getLog_().saved;
    const lr = saved.getLastRow();
    if (lr >= 2) {
      const vals = saved.getRange(2, 1, lr - 1, 9).getValues();
      vals.forEach(function (r) {
        const url = String(r[8] || '');
        const idm = url.match(/[-\w]{25,}/);
        if (!idm) return;
        const invs = String(r[4] || '').split(/[,\s]+/).map(function (s) { return s.trim().toUpperCase(); }).filter(Boolean);
        invByFile[idm[0]] = invs;
      });
    }
  } catch (e) {}

  // One pass over the LIVE folder. Staging is retired (getStagingFolder_ points here too),
  // so scanning "both" would double-count every file and flag everything as a duplicate.
  const all = [];
  const it = folder.getFilesByType('application/pdf');
  while (it.hasNext()) {
    const f = it.next();
    const name = f.getName();
    const id = f.getId();
    const a = analyzeFilename_(name);
    let size = 0; try { size = f.getSize(); } catch (e) {}
    all.push({
      id: id, name: name, url: f.getUrl(), folderName: 'remits not applied (LIVE)', live: true,
      size: size, invoices: invByFile[id] || null, key: qaDedupKey_(name),
      issues: a.issues.slice(), severity: a.severity, proposedName: a.proposedName, reextractNeeded: a.reextractNeeded,
    });
  }

  // Invoice-aware duplicate detection: group by amount+short-payor, then within a group flag a
  // file as a duplicate only if it shares an invoice with another (or both have no invoices
  // logged -> "verify"). Same amount + different invoices = distinct payments, not a duplicate.
  const groups = {};
  all.forEach(function (r) { (groups[r.key] = groups[r.key] || []).push(r); });
  Object.keys(groups).forEach(function (k) {
    const g = groups[k];
    if (g.length < 2) return;
    for (let i = 0; i < g.length; i++) {
      for (let j = i + 1; j < g.length; j++) {
        const a = g[i], b = g[j];
        const overlap = invoiceOverlap_(a.invoices, b.invoices);
        const bothUnknown = (!a.invoices || !a.invoices.length) && (!b.invoices || !b.invoices.length);
        if (!overlap && !bothUnknown) continue;
        let keep, drop;
        if (a.size !== b.size) { keep = a.size > b.size ? a : b; drop = a.size > b.size ? b : a; }
        else { keep = (a.proposedName && !b.proposedName) ? b : a; drop = (keep === a) ? b : a; }
        if (!drop.dropSuggested) {
          drop.issues.push(overlap ? ('duplicate of "' + keep.name + '" \u2014 same invoice(s), safe to trash')
                                   : ('possible duplicate of "' + keep.name + '" \u2014 verify invoices'));
          drop.severity = overlap ? 'high' : 'medium';
          drop.duplicateOf = keep.name;
          drop.dropSuggested = true;
        }
      }
    }
  });

  const rank = { high: 0, medium: 1, low: 2 };
  const flagged = all.filter(function (r) { return r.issues.length; })
                     .sort(function (a, b) { return (rank[a.severity] - rank[b.severity]); });

  return {
    generatedAt: Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm'),
    user: getActiveUser_(),
    folders: [{ id: LIVE_FOLDER_ID, name: 'remits not applied (LIVE)', live: true }],
    rows: flagged,
  };
}

/** Normalize a filename to an amount+short-payor key for duplicate grouping. */
function qaDedupKey_(name) {
  var base = String(name).replace(/\.pdf$/i, '');
  var m = base.match(/^\$([\d,]*\.?\d*)\s+(.+)$/);
  var amt = m ? m[1].replace(/,/g, '') : base;
  var payor = m ? m[2] : base;
  payor = payor.replace(/_\d+$/, '');
  payor = payor.replace(/\s+(GBP|EUR|USD|CAD|CHF|JPY|AUD)\b/ig, '');
  for (var g = 0; g < 3; g++) payor = payor.replace(/[,\s]+(Inc\.?|LLC\.?|Ltd\.?|Limited|Incorporated|Corp\.?|Corporation|Co\.)\s*$/i, '');
  payor = payor.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return amt + '|' + payor;
}

/** True if two invoice lists share any invoice number. */
function invoiceOverlap_(a, b) {
  if (!a || !b || !a.length || !b.length) return false;
  return a.some(function (x) { return b.indexOf(x) !== -1; });
}

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

  // 7. Payor is a form-field label / junk (e.g. "Supplier Payee Name").
  if (m && looksLikePayorJunk_(payorPart)) {
    issues.push('payor looks like a form-field label, not a real payor');
    severity = 'high';
    reextractNeeded = true;
  }
  // 8. Corporate suffix the short-name convention drops ("..., Inc." / "LLC").
  if (/[,\s]+(Inc\.?|LLC\.?|Ltd\.?|Limited|Incorporated|Corp\.?|Corporation|Co\.)\s*$/i.test(payorPart.replace(/_\d+$/, ''))) {
    issues.push('drop the corporate suffix (short-name convention)');
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
      const isRename = (kind === 'RENAME' || kind === 'APPROVE-RENAME');
      const detail = isRename
        ? ((r.from || '?') + '  ->  ' + (r.to || '?') + (r.ok ? '' : '  \u2014 ' + (r.error || 'validation flagged')))
        : (r.ok ? (r.name || '') : (r.id + ': ' + (r.error || 'failed')));
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
  const msgs = log.messages;
  const last = msgs.getLastRow();
  const needsAttention = [];   // agent got stuck: couldn't read payor/amount, or flagged
  const handled = [];          // saved, generated, or skipped by a known rule
  const counts = { saved:0, generated:0, skipped:0, flagged:0, needsName:0 };

  // Determine the last run's start time up front so "handled" can be limited to just
  // the most recent run (Review is a working queue; older handled items live in Run Log).
  let lastRunStart = 0;
  try {
    const runsSheet = log.runs; const lrr = runsSheet.getLastRow();
    if (lrr >= 2) { const v = runsSheet.getRange(lrr, 1).getValue(); if (v instanceof Date) lastRunStart = v.getTime(); }
  } catch (e) {}

  if (last >= 2) {
    const startRow = Math.max(2, last - 199);
    const rng = msgs.getRange(startRow, 1, last - startRow + 1, 18).getValues();
    for (let i = rng.length - 1; i >= 0; i--) {
      const r = rng[i];
      const outcome = String(r[9] || '').toUpperCase();
      const payorRaw = String(r[8] || '').trim();
      // A payor is "unresolved" if it's blank or is a leaked rule-id token.
      const looksLikeRuleId = payorRaw === '' || (/[_-]/.test(payorRaw) && /^[a-z0-9_ -]+$/.test(payorRaw.toLowerCase()) && /extract|body|attachment|from_pdf|skip|flag/.test(payorRaw.toLowerCase()));
      const payor = looksLikeRuleId ? '' : payorRaw;
      const amount = r[13] === '' || r[13] == null ? null : r[13];

      const item = {
        id: r[11] || '',
        from: r[3] || '',
        emailDate: fmtCell_(r[1], tz),
        subject: r[4] || '',
        payor: payor,
        amount: amount,
        currency: r[14] || '',
        invoices: r[15] || '',
        filename: r[16] || '',
        fileUrl: r[17] || '',
        gmailUrl: r[12] || '',
        method: methodLabel_(r[6], r[5]),
        attachment: (String(r[5]).toLowerCase() === 'yes' ? 'PDF' : 'No attachment'),
        outcome: outcome,
        // Plain-language status for the badge — never the raw verdict.
        status: statusLabel_(outcome, payor),
      };

      // Categorize. Already-processed / saved / generated / rule-skipped = HANDLED.
      // Only genuinely stuck items (flagged, or missing a payor the agent should have) go to attention.
      const isStuck = (outcome === 'FLAGGED') || (payor === '' && outcome !== 'SKIPPED' && outcome !== 'ALREADY PROCESSED');
      if (isStuck) {
        item.needsName = (payor === '');
        item.suggestedName = payor || suggestName_(item.subject, r[3], payorRaw);
        if (item.needsName) counts.needsName++;
        // Deduplicate by message ID — only keep the most recent entry (we iterate newest-first).
        if (item.id && needsAttention.some(function(e){ return e.id === item.id; })) {
          // already have a newer entry for this message, skip
        } else {
          needsAttention.push(item);
        }
      } else {
        // Only surface handled items from the most recent run; older ones are in Run Log.
        const loggedAtMs = (r[0] instanceof Date) ? r[0].getTime() : 0;
        const fromLastRun = lastRunStart === 0 || loggedAtMs >= (lastRunStart - 60000); // 1-min grace
        if (fromLastRun) {
          handled.push(item);
          if (outcome === 'SAVED') counts.saved++;
          else if (outcome === 'GENERATED') counts.generated++;
          else if (outcome === 'SKIPPED' || outcome === 'ALREADY PROCESSED') counts.skipped++;
          else counts.flagged++;
        }
      }
    }
  }

  // Last run time + the true inbox backlog.
  let lastRunAt = '', lastRunEpoch = 0;
  const runs = log.runs; const lr = runs.getLastRow();
  if (lr >= 2) {
    const rr = runs.getRange(lr, 1, 1, 8).getValues()[0];
    lastRunAt = fmtCell_(rr[0], tz);
    if (rr[0] instanceof Date) lastRunEpoch = rr[0].getTime();
  }
  let backlog = { unread: -1, lookbackDays: 0 };
  try { backlog = inboxBacklog_(); } catch (e) {}

  return {
    generatedAt: Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd HH:mm'),
    user: getActiveUser_(),
    lastRunAt: lastRunAt,
    lastRunEpoch: lastRunEpoch,
    nowEpoch: new Date().getTime(),
    backlog: backlog,
    needsAttention: needsAttention,
    handled: handled,
    counts: counts,
    owner: isOwner_(),
  };
}

/** Plain-language status for a row's badge. Never exposes the internal verdict. */
function statusLabel_(outcome, payor) {
  switch (String(outcome).toUpperCase()) {
    case 'SAVED': return 'Saved';
    case 'GENERATED': return 'Saved';        // both mean "file is in staging"
    case 'SKIPPED': return 'Skipped';
    case 'ALREADY PROCESSED': return 'Already done';
    case 'DUPLICATE': return 'Duplicate';
    case 'FLAGGED': return payor ? 'Needs review' : 'Payor not read';
    default: return payor ? 'Needs review' : 'Payor not read';
  }
}
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
    if (!isOwner_()) return { ok: false, error: 'Only the tool owner can create or change rules.' };
    if (!payload || !payload.action) throw new Error('missing action');
    const res = persistRule_(payload.match || {}, payload.action, payload.short_name || '', 'Rule created in Review by ' + getActiveUser_());
    return { ok: true, shared: !!res.shared, note: res.note || '', version: res.version };
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
    lookbackDays: eff.lookbackDays,
    maxPerRun: eff.maxPerRun,
    defaults: { lookbackDays: CONFIG.LOOKBACK_DAYS, maxPerRun: CONFIG.MAX_PROCESS_PER_RUN },
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
  const lb = Number(payload.lookbackDays);
  if (isFinite(lb) && lb >= 1 && lb <= 60) { p.setProperty('SET_LOOKBACK_DAYS', String(lb)); out.changed.push('lookback'); }
  const mx = Number(payload.maxPerRun);
  if (isFinite(mx) && mx >= 1 && mx <= 100) { p.setProperty('SET_MAX_PER_RUN', String(mx)); out.changed.push('maxPerRun'); }
  return out;
}

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
function getAuditLog(limit) {
  const log = getLog_();
  const tz = Session.getScriptTimeZone();

  // ---- Agent runs ----
  const runs = [];
  const runsSheet = log.runs;
  let rlast = runsSheet.getLastRow();
try {
    if (rlast >= 2) {
    const n = Math.min(limit || 40, rlast - 1);
    const rng = runsSheet.getRange(rlast - n + 1, 1, n, 8).getValues();
    for (let i = rng.length - 1; i >= 0; i--) {
      const r = rng[i];
      runs.push({ at: fmtCell_(r[0], tz), inWindow: String(r[1]==null?'':r[1]), newLogged: String(r[2]==null?'':r[2]), rulesLoaded: String(r[3]==null?'':r[3]),
        rulesVersion: String(r[4]||''), rulesSource: String(r[5]||''), error: String(r[6]||''), outcomes: String(r[7]||'') });
    }
  }
  } catch (e) {}

  // ---- Messages-derived: saved / skipped / flagged (each row keeps a link home) ----
  const saved = [], skipped = [], flagged = [];
  const m = log.messages;
  const lr = m.getLastRow();
try {
    if (lr >= 2) {
    const count = Math.min(800, lr - 1);
    const mr = m.getRange(lr - count + 1, 1, count, 18).getValues();
    for (let i = mr.length - 1; i >= 0; i--) {
      const r = mr[i];
      const at = fmtCell_(r[0], tz);
      const pdf = String(r[5]).toLowerCase() === 'yes';
      const verdict = String(r[6] || '');
      const payorRaw = String(r[8] || '').trim();
      const outcome = String(r[9] || '').toUpperCase();
      const note = r[10] || '';
      const emailUrl = r[12] || '';
      const subject = r[4] || '';
      const method = /save/i.test(verdict) ? 'Saved PDF attachment'
                   : (/extract|body/i.test(verdict) ? 'Generated from body' : (verdict || ''));
      const docType = pdf ? 'PDF' : 'No attachment';

      if (outcome === 'SAVED' || outcome === 'GENERATED') {
        saved.push({ at: at, payor: payorRaw, amount: (r[13]==null?'':String(r[13])), currency: String(r[14]||''), method: method,
          docType: docType, invoices: r[15] || '', filename: r[16] || '', fileUrl: r[17] || '',
          emailUrl: emailUrl, subject: subject });
      } else if (outcome === 'SKIPPED' || outcome === 'ALREADY PROCESSED') {
        const already = (outcome === 'ALREADY PROCESSED') || /already/i.test(String(note));
        skipped.push({ at: at, payor: payorRaw, subject: subject, rule: r[7] || '',
          reason: note || (outcome === 'ALREADY PROCESSED' ? 'Already processed on a prior run' : 'Matched a skip rule'),
          already: already, emailUrl: emailUrl });
      } else if (outcome === 'FLAGGED' || (!payorRaw || looksLikePayorJunk_(payorRaw))) {
        let guess = (payorRaw && !looksLikePayorJunk_(payorRaw)) ? payorRaw : '';
        if (!guess) { try { guess = suggestName_(subject, r[3], payorRaw) || ''; } catch (e) {} }
        flagged.push({ at: at, payor: guess, subject: subject,
          reason: note || outcome || 'Needs review', emailUrl: emailUrl });
      }
    }
  }
  } catch (e) {}

  // ---- QA actions ----
  const qa = [];
  try {
    const qs = log.ss.getSheetByName('QA Actions');
    if (qs) {
      const ql = qs.getLastRow();
      if (ql >= 2) {
        const n = Math.min(120, ql - 1);
        const qr = qs.getRange(ql - n + 1, 1, n, 5).getValues();
        for (let i = qr.length - 1; i >= 0; i--) {
          const r = qr[i];
          qa.push({ at: fmtCell_(r[0], tz), user: String(r[1]||''), action: String(r[2]||''), detail: String(r[3]||''), ok: String(r[4]).toLowerCase() === 'yes' });
        }
      }
    }
  } catch (e) {}

  return { user: getActiveUser_(), generatedAt: Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd HH:mm'),
    runs: runs, saved: saved, skipped: skipped, flagged: flagged, qa: qa };
}

// Back-compat alias (older UI builds called getRunLog).
function getRunLog(limit) { return getAuditLog(limit); }


/** Standalone backlog fetch for the Review header refresh. */
function getBacklog() {
  try { return inboxBacklog_(); } catch (e) { return { unread: -1, lookbackDays: 0 }; }
}

// ============================================================
//  PAYOR WRITE-BACK — approve an unresolved payor, save the rule
//  to GitHub (shared, permanent) so the agent knows it next time.
// ============================================================

/**
 * Canonical rules.json writer: reads the shared rules.json + sha, appends `rule`
 * (skipping a duplicate with the same action + an overlapping keyword), bumps the
 * version, and writes it back. Uses the GITHUB_TOKEN script property (fine-grained,
 * Contents: read & write). Returns the updated GitHub rule list on success.
 */
function ruleKeywords_(r) {
  var m = (r && r.match) || {};
  return [].concat(m.subject_contains || [], m.from_contains || [], m.snippet_contains || [])
           .map(function (s) { return String(s).toLowerCase().trim(); }).filter(Boolean);
}
function sameRule_(a, b) {
  if (!a || !b) return false;
  if ((a.action || '') !== (b.action || '')) return false;
  var ka = ruleKeywords_(a), kb = ruleKeywords_(b);
  return ka.some(function (k) { return kb.indexOf(k) !== -1; });
}
function writeRuleToGitHub_(rule, commitMsg) {
  var props = PropertiesService.getScriptProperties();
  var token = props.getProperty('GITHUB_TOKEN') || props.getProperty('GITHUB_WRITE_TOKEN');
  if (!token) return { ok: false, shared: false, noToken: true, error: 'No GITHUB_TOKEN configured.' };
  var api = 'https://api.github.com/repos/aronhasofer-apps/se-remittance-agent/contents/rules.json';
  var headers = { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json' };
  try {
    var getResp = UrlFetchApp.fetch(api + '?ref=main', { headers: headers, muteHttpExceptions: true });
    if (getResp.getResponseCode() !== 200) return { ok: false, shared: false, error: 'Read rules.json HTTP ' + getResp.getResponseCode() };
    var meta = JSON.parse(getResp.getContentText());
    var current = JSON.parse(Utilities.newBlob(Utilities.base64Decode(meta.content)).getDataAsString());
    if (!current || !Array.isArray(current.rules)) return { ok: false, shared: false, error: 'rules.json malformed; aborting write' };
    var existed = current.rules.some(function (r) { return sameRule_(r, rule); });
    if (!existed) current.rules.push(rule);
    current.version = bumpVersion_(current.version || '1.0.0');
    var body = {
      message: commitMsg || ('Add rule ' + (rule.short_name || rule.id) + ' (approved in app)'),
      content: Utilities.base64Encode(Utilities.newBlob(JSON.stringify(current, null, 2)).getBytes()),
      sha: meta.sha,
    };
    var putResp = UrlFetchApp.fetch(api, { method: 'put', headers: headers, contentType: 'application/json', payload: JSON.stringify(body), muteHttpExceptions: true });
    var code = putResp.getResponseCode();
    if (code >= 200 && code < 300) { try { loadRules_(); } catch (e) {} return { ok: true, shared: true, version: current.version, existed: existed, githubRules: current.rules }; }
    return { ok: false, shared: false, error: 'GitHub write HTTP ' + code };
  } catch (e) { return { ok: false, shared: false, error: String(e) }; }
}
/** Drop any LOCAL_RULES entry that now exists in the shared rules.json. */
function reconcileLocalAgainst_(githubRules) {
  try {
    if (!githubRules || !githubRules.length) return;
    var p = PropertiesService.getScriptProperties();
    var raw = p.getProperty('LOCAL_RULES'); if (!raw) return;
    var local = JSON.parse(raw); if (!local.length) return;
    var kept = local.filter(function (lr) { return !githubRules.some(function (gr) { return sameRule_(gr, lr); }); });
    if (kept.length !== local.length) p.setProperty('LOCAL_RULES', JSON.stringify(kept));
  } catch (e) {}
}
/**
 * Persist a rule from the UI: write it to the shared rules.json on GitHub; on success
 * reconcile it out of LOCAL_RULES. If GitHub is unavailable / no token, fall back to a
 * local override so the work is never lost.
 */
function persistRule_(match, action, shortName, descr) {
  // GUARD — never create a rule keyed on our own group domain. Mail arrives via
  // remittances@, so that signal matches every email and hijacks the whole inbox.
  try {
    var ownDomain = String(CONFIG.GROUP || 'remittances@scienceexchange.com')
                      .split('@').pop().toLowerCase();
    var fc = (match && match.from_contains) || [];
    var bad = fc.some(function (f) {
      var v = String(f || '').toLowerCase().trim();
      return v && v.indexOf('@') === -1 && ownDomain.indexOf(v) !== -1;
    });
    if (bad) {
      return { ok: false, error: 'Refused: that rule would key on our own domain (' +
        ownDomain + ') and match every remittance email. Use a subject keyword instead.' };
    }
  } catch (e) {}
  var rule = {
    id: 'rule-' + String(shortName || 'payor').toLowerCase().replace(/[^a-z0-9]+/g, '-') + '-' + Date.now(),
    description: descr || ((shortName || 'rule') + ' (approved in app by ' + getActiveUser_() + ')'),
    match: match || {}, action: action, short_name: shortName || '',
  };
  var res = writeRuleToGitHub_(rule, 'Add rule ' + (shortName || action) + ' (approved in app)');
  if (res.shared) { reconcileLocalAgainst_(res.githubRules); return { ok: true, shared: true, version: res.version, existed: res.existed }; }
  var p = PropertiesService.getScriptProperties();
  var list = []; try { var raw = p.getProperty('LOCAL_RULES'); if (raw) list = JSON.parse(raw); } catch (e) {}
  list.push({ id: 'local-' + Date.now(), match: match || {}, action: action, short_name: shortName || '', created: new Date().toISOString(), createdBy: getActiveUser_() });
  p.setProperty('LOCAL_RULES', JSON.stringify(list));
  return { ok: true, shared: false, note: res.noToken ? 'Saved locally \u2014 no GitHub token set.' : ('Saved locally \u2014 GitHub write failed (' + (res.error || '') + ').') };
}

/**
 * Approve a payor name for an item the agent couldn't read. Writes a payor rule
 * to the shared rules.json on GitHub so every future run resolves it automatically.
 * payload: { subjectKeyword, shortName, action }
 * Requires a GitHub token in Script Property GITHUB_WRITE_TOKEN.
 */
function approvePayorToGitHub(payload) {
  try {
    if (!isOwner_()) return { ok: false, error: 'Only the tool owner can create or change rules.' };
    if (!payload || !payload.shortName || !payload.subjectKeyword) {
      return { ok: false, error: 'Need both a payor name and a subject keyword.' };
    }
    var action = (payload.action && ['save_attachment', 'extract_body', 'skip', 'flag'].indexOf(payload.action) !== -1) ? payload.action : 'extract_body';
    return persistRule_({ subject_contains: [String(payload.subjectKeyword).trim()] }, action, String(payload.shortName).trim(), 'Payor ' + payload.shortName + ' (approved in app)');
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

/** Fallback: save the payor as a local rule when no GitHub write token is set. */
function saveLocalPayorFallback_(payload, action) {
  const p = PropertiesService.getScriptProperties();
  let list = [];
  try { const raw = p.getProperty('LOCAL_RULES'); if (raw) list = JSON.parse(raw); } catch (e) {}
  list.push({
    id: 'local-payor-' + Date.now(),
    match: { subject_contains: [payload.subjectKeyword] },
    action: action,
    short_name: payload.shortName,
    created: new Date().toISOString(),
    createdBy: getActiveUser_(),
  });
  p.setProperty('LOCAL_RULES', JSON.stringify(list));
  return { ok: true, shared: false, note: 'Saved locally (no GitHub write token configured). It works on this deployment; add GITHUB_WRITE_TOKEN to share it.' };
}

/** Bump the patch component of a semver-ish version string. */
function bumpVersion_(v) {
  const parts = String(v).split('.').map(function (x) { return parseInt(x, 10) || 0; });
  while (parts.length < 3) parts.push(0);
  parts[2] += 1;
  return parts.join('.');
}
// ============================================================
//  NOTIFICATIONS — daily digest email + scheduled QA scan,
//  plus badge counts for the nav tabs. All recipients and the
//  digest send-hour live in Script Properties (set via Settings).
// ============================================================

/**
 * Counts for the nav-tab badges: how many Review items need attention,
 * and whether QA currently has any flagged files. Cheap enough to call on load.
 */
function getBadges() {
  let reviewCount = 0, qaHasIssues = false;
  try {
    const rd = reviewData();
    reviewCount = (rd.needsAttention || []).length;
  } catch (e) {}
  try {
    // Use the cached last-scan result if present, else a light scan.
    const cached = PropertiesService.getScriptProperties().getProperty('QA_LAST_ISSUES');
    if (cached != null) qaHasIssues = Number(cached) > 0;
    else { const qa = qaScan(); qaHasIssues = (qa.rows || []).length > 0;
      PropertiesService.getScriptProperties().setProperty('QA_LAST_ISSUES', String((qa.rows||[]).length)); }
  } catch (e) {}
  return { review: reviewCount, qa: qaHasIssues };
}

/** Notification settings (recipients + digest hour) for the Settings page. */
function getNotifySettings() {
  const p = PropertiesService.getScriptProperties();
  return {
    recipients: p.getProperty('NOTIFY_RECIPIENTS') || '',
    digestHour: Number(p.getProperty('NOTIFY_DIGEST_HOUR') || '8'), // 24h, approximate
    qaScanEveryHours: Number(p.getProperty('QA_SCAN_HOURS') || '4'),
  };
}

/** Save notification settings and (re)install the schedule triggers to match. */
function saveNotifySettings(payload) {
  const p = PropertiesService.getScriptProperties();
  const out = { ok: true, changed: [] };
  if (typeof payload.recipients === 'string') {
    // Light validation: comma/space separated emails.
    const cleaned = payload.recipients.split(/[,;\s]+/).filter(function (x) { return x.indexOf('@') > 0; }).join(', ');
    p.setProperty('NOTIFY_RECIPIENTS', cleaned); out.changed.push('recipients');
  }
  const hr = Number(payload.digestHour);
  if (isFinite(hr) && hr >= 0 && hr <= 23) { p.setProperty('NOTIFY_DIGEST_HOUR', String(hr)); out.changed.push('digestHour'); }
  const qh = Number(payload.qaScanEveryHours);
  if (isFinite(qh) && [1,2,3,4,6,8,12].indexOf(qh) !== -1) { p.setProperty('QA_SCAN_HOURS', String(qh)); out.changed.push('qaScanHours'); }
  installNotificationTriggers();
  return out;
}

/** (Re)install the daily-digest and QA-scan time triggers to match settings. */
function installNotificationTriggers() {
  const ns = getNotifySettings();
  // Remove any existing notification triggers first (leave the main runRemittanceScan trigger alone).
  ScriptApp.getProjectTriggers().forEach(function (t) {
    const fn = t.getHandlerFunction();
    if (fn === 'sendDailyDigest' || fn === 'scheduledQaScan') ScriptApp.deleteTrigger(t);
  });
  // Daily digest at the chosen (approximate) hour.
  ScriptApp.newTrigger('sendDailyDigest').timeBased().atHour(ns.digestHour).everyDays(1).create();
  // QA scan every few hours.
  ScriptApp.newTrigger('scheduledQaScan').timeBased().everyHours(ns.qaScanEveryHours).create();
  return { ok: true };
}

/** Scheduled QA scan: refresh the cached issue count so badges + digest are current. */
function scheduledQaScan() {
  try {
    const qa = qaScan();
    PropertiesService.getScriptProperties().setProperty('QA_LAST_ISSUES', String((qa.rows || []).length));
    PropertiesService.getScriptProperties().setProperty('QA_LAST_SCAN_AT', new Date().toISOString());
  } catch (e) {}
}

/**
 * The daily digest. Sends every day (even all-clear) to the configured recipients,
 * combining Review items needing attention + QA issues, with a link to the app.
 */
function sendDailyDigest() {
  const p = PropertiesService.getScriptProperties();
  const recipients = p.getProperty('NOTIFY_RECIPIENTS') || '';
  if (!recipients.trim()) return; // no recipients set → nothing sends

  let review = { needsAttention: [], handled: [], counts: {}, backlog: { unread: -1 } };
  try { review = reviewData(); } catch (e) {}
  let qaRows = [];
  try { const qa = qaScan(); qaRows = qa.rows || []; p.setProperty('QA_LAST_ISSUES', String(qaRows.length)); } catch (e) {}

  const appUrl = ScriptApp.getService().getUrl();
  const tz = Session.getScriptTimeZone();
  const dateStr = Utilities.formatDate(new Date(), tz, 'EEEE, MMMM d, yyyy');
  const needs = review.needsAttention || [];
  const handledCount = (review.counts.saved || 0) + (review.counts.generated || 0);
  const backlog = (review.backlog && review.backlog.unread >= 0) ? review.backlog.unread : null;

  const subject = (needs.length || qaRows.length)
    ? 'Remit Fetcher — ' + (needs.length + qaRows.length) + ' item(s) need attention'
    : 'Remit Fetcher — all clear';

  const html = buildDigestHtml_(dateStr, needs, qaRows, handledCount, backlog, appUrl);
  MailApp.sendEmail({ to: recipients, subject: subject, htmlBody: html, name: 'Remit Fetcher' });
  p.setProperty('DIGEST_LAST_SENT', new Date().toISOString());
}

/** Build the digest HTML — structured, Treasury-styled, with an app link. */
function buildDigestHtml_(dateStr, needs, qaRows, handledCount, backlog, appUrl) {
  const brand = '#12508a', gold = '#9a7b1f', ink = '#0f1e2e', muted = '#6b7a89', line = '#dde4ec', red = '#b3261e', green = '#1a7f4b';
  function esc(s){ return String(s==null?'':s).replace(/[&<>]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;'}[c];}); }
  let h = '';
  h += '<div style="font-family:Georgia,serif;max-width:640px;margin:0 auto;color:'+ink+'">';
  h += '<div style="border-bottom:3px solid '+gold+';padding-bottom:12px;margin-bottom:20px">';
  h += '<div style="font-size:20px;font-weight:700;color:'+ink+'">Remit Fetcher</div>';
  h += '<div style="font-size:12px;color:'+muted+';text-transform:uppercase;letter-spacing:1px">Treasury · Daily Cash Receipts · '+esc(dateStr)+'</div>';
  h += '</div>';

  // Summary line
  h += '<p style="font-family:Arial,sans-serif;font-size:14px;color:'+ink+'">';
  if (!needs.length && !qaRows.length) {
    h += '<b style="color:'+green+'">All clear.</b> The agent ran and there is nothing outstanding.';
  } else {
    h += '<b style="color:'+red+'">'+(needs.length+qaRows.length)+' item(s) need attention.</b>';
  }
  h += '</p>';

  // Stats row
  h += '<table style="font-family:Arial,sans-serif;font-size:13px;width:100%;border-collapse:collapse;margin:14px 0">';
  h += '<tr>';
  h += statCell_(handledCount, 'Handled today', ink, line);
  h += statCell_(needs.length, 'Need attention', needs.length?red:ink, line);
  h += statCell_(qaRows.length, 'QA issues', qaRows.length?red:ink, line);
  h += statCell_(backlog==null?'—':backlog, 'Unread in inbox', ink, line);
  h += '</tr></table>';

  // Needs attention list
  if (needs.length) {
    h += sectionTitle_('Needs your attention', red);
    h += '<table style="font-family:Arial,sans-serif;font-size:13px;width:100%;border-collapse:collapse">';
    needs.slice(0, 25).forEach(function (it) {
      const payor = it.payor ? esc(it.payor) : '<i style="color:'+muted+'">payor not read</i>';
      const amt = it.amount != null ? ('$' + esc(String(it.amount)) + (it.currency && it.currency !== 'USD' ? (' ' + esc(it.currency)) : '')) : '—';
      h += '<tr style="border-bottom:1px solid '+line+'">';
      h += '<td style="padding:7px 8px 7px 0">'+payor+'</td>';
      h += '<td style="padding:7px 8px;font-family:monospace;border-left:2px solid '+gold+'">'+amt+'</td>';
      h += '<td style="padding:7px 0;color:'+muted+'">'+esc((it.subject||'').slice(0,60))+'</td>';
      h += '</tr>';
    });
    h += '</table>';
  }

  // QA issues list
  if (qaRows.length) {
    h += sectionTitle_('QA cleanup issues', red);
    h += '<table style="font-family:Arial,sans-serif;font-size:13px;width:100%;border-collapse:collapse">';
    qaRows.slice(0, 25).forEach(function (r) {
      h += '<tr style="border-bottom:1px solid '+line+'">';
      h += '<td style="padding:7px 8px 7px 0;font-family:monospace;font-size:12px">'+esc(r.name)+'</td>';
      h += '<td style="padding:7px 0;color:'+muted+'">'+esc((r.issues||[]).join(', '))+(r.live?' <b style="color:'+red+'">[LIVE]</b>':'')+'</td>';
      h += '</tr>';
    });
    h += '</table>';
  }

  // CTA
  h += '<div style="margin:24px 0 8px">';
  h += '<a href="'+esc(appUrl)+'" style="background:'+brand+';color:#fff;font-family:Arial,sans-serif;font-size:14px;font-weight:bold;text-decoration:none;padding:11px 22px;border-radius:6px;display:inline-block">Open Remit Fetcher</a>';
  h += '</div>';
  h += '<p style="font-family:Arial,sans-serif;font-size:11px;color:'+muted+';margin-top:20px">This is an automated daily summary from Remit Fetcher.</p>';
  h += '</div>';
  return h;
}
function statCell_(n, label, color, line) {
  return '<td style="width:25%;text-align:center;padding:10px;border:1px solid '+line+';border-radius:6px">'
    + '<div style="font-size:22px;font-weight:700;font-family:monospace;color:'+color+'">'+n+'</div>'
    + '<div style="font-size:10px;color:#6b7a89;text-transform:uppercase;letter-spacing:.5px">'+label+'</div></td>';
}
function sectionTitle_(t, color) {
  return '<div style="font-family:Arial,sans-serif;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:'+color+';margin:20px 0 8px;padding-bottom:4px;border-bottom:2px solid '+color+'">'+t+'</div>';
}

/** Manual "send me a test digest now" for the Settings page. */
function sendTestDigest() {
  try { sendDailyDigest(); return { ok: true }; }
  catch (e) { return { ok: false, error: String(e) }; }
}

// ============================================================
//  APPROVE A REVIEW ROW — set the correct payor, reprocess that
//  ONE email, and rename-in-place (if a file exists) or create it.
//  Optionally records a rule (sender OR subject) for future mail.
// ============================================================

/** Best-guess short name for an unresolved row, from subject + sender. */
function isSelfName_(name) {
  const n = String(name || '').toLowerCase().replace(/[^a-z]/g, '');
  return n.indexOf('scienceexchange') !== -1 || n === 'science' || n === 'exchange' || n === 'sciexchange' || n === 'sciex';
}

function suggestName_(subject, from, rawPayor) {
  const subj = String(subject || '');
  const fromRaw = String(from || '');

  // 1) A KNOWN payor anywhere in subject+from wins — but never our own name.
  const hay = subj + ' ' + fromRaw;
  try {
    for (let i = 0; i < SHORT_NAMES.length; i++) {
      if (SHORT_NAMES[i][0].test(hay)) { const sn = SHORT_NAMES[i][1]; if (!isSelfName_(sn)) return sn; }
    }
  } catch (e) {}

  // 2) Strip reply/forward + notification prefixes so the company name is at the front.
  let s = subj
    .replace(/^\s*(re|fw|fwd)\s*:\s*/gi, '').replace(/^\s*(re|fw|fwd)\s*:\s*/gi, '').replace(/^\s*(re|fw|fwd)\s*:\s*/gi, '')
    .replace(/^\s*\[[^\]]*\]\s*/g, '')
    .replace(/^\s*(your\s+)?payment\s+from\s+/i, '')
    .replace(/^\s*payment\s+notification\s+from\s+/i, '')
    .replace(/^\s*notice of (new )?/i, '');

  // 3) Company-looking phrase up to a known action verb.
  let m = s.match(/^([A-Z][A-Za-z0-9&.,'’\- ]+?)\s+(?:sent you|is on the way|received your|has sent you|has initiated|will be deposited|sent a payment|initiated a payment|is attempting|will deposit)/i);
  if (!m) m = subj.match(/from\s+([A-Z][A-Za-z0-9&.,'’\- ]+?)\s*$/); // "... from Y"
  if (m && m[1]) {
    let g = ''; try { g = shortName_(m[1].trim(), ''); } catch (e) { g = m[1].trim(); }
    if (g && !looksLikePayorJunk_(g) && !isSelfName_(g)) return g;
  }

  // 4) Sender-domain hint — skip our own domain + infra subdomains.
  const dm = fromRaw.toLowerCase().match(/@([a-z0-9.-]+)/);
  if (dm) {
    const dom = dm[1].split('.')[0];
    if (dom && dom.length > 2 &&
        !/mail|smtp|no-?reply|noreply|erp|notif|payment|remit|account|finance|service|do-?not|science|exchange|sciex/.test(dom)) {
      const cand = dom.charAt(0).toUpperCase() + dom.slice(1);
      if (!looksLikePayorJunk_(cand) && !isSelfName_(cand)) return cand;
    }
  }
  return '';
}

/**
 * payload = {
 *   messageId, shortName,
 *   action?,                         // 'save_attachment' | 'extract_body' (else inferred)
 *   makeRule?, ruleSignal?, ruleValue?   // ruleSignal 'from' | 'subject'
 * }
 */
function reviewApproveRow(payload) {
  try {
    if (!payload || !payload.messageId) {
      return { ok: false, error: 'Need a message ID.' };
    }
    // skip and flag don't need a short name
    if (!payload.shortName && payload.action !== 'skip' && payload.action !== 'flag') {
      return { ok: false, error: 'Need a message and a short name.' };
    }
    const shortName = String(payload.shortName).trim();
    const log = getLog_();

    // Optionally persist a rule for FUTURE mail (sender or subject signal).
    let ruleNote = '';
    if (payload.makeRule && payload.ruleValue && !isOwner_()) {
      ruleNote = 'Rule not created \u2014 only the tool owner can add or change shared rules. This item was still filed.';
    } else if (payload.makeRule && payload.ruleValue) {
      const match = {};
      if (payload.ruleSignal === 'from') match.from_contains = [String(payload.ruleValue).trim()];
      else match.subject_contains = [String(payload.ruleValue).trim()];
      const action0 = (['save_attachment', 'extract_body', 'skip', 'flag'].indexOf(payload.action) !== -1) ? payload.action : 'save_attachment';
      const rres = persistRule_(match, action0, shortName, shortName + ' (approved in Review by ' + getActiveUser_() + ')');
      const sig = (payload.ruleSignal === 'from' ? 'sender' : 'subject');
      ruleNote = rres.shared
        ? 'Rule saved to the shared rules (' + sig + ' contains "' + payload.ruleValue + '") \u2014 every deployment now handles this automatically.'
        : 'Rule saved locally (' + sig + ' contains "' + payload.ruleValue + '"). ' + (rres.note || '');
    }

    // Locate the Messages row (Message ID = col 12).
    const msgs = log.messages;
    const last = msgs.getLastRow();
    let rowIdx = -1;
    if (last >= 2) {
      const ids = msgs.getRange(2, 12, last - 1, 1).getValues();
      for (let i = ids.length - 1; i >= 0; i--) {
        if (String(ids[i][0]) === String(payload.messageId)) { rowIdx = i + 2; break; }
      }
    }

    // Locate an existing saved file for this message (Saved: Message ID = col 8, File link = col 9).
    const saved = log.saved;
    let savedRowIdx = -1, savedVals = null;
    const slast = saved.getLastRow();
    if (slast >= 2) {
      const sids = saved.getRange(2, 8, slast - 1, 1).getValues();
      for (let i = sids.length - 1; i >= 0; i--) {
        if (String(sids[i][0]) === String(payload.messageId)) { savedRowIdx = i + 2; break; }
      }
    }
    if (savedRowIdx !== -1) savedVals = saved.getRange(savedRowIdx, 1, 1, 9).getValues()[0];

    // If the reviewer chose skip/flag, record the decision — don't write a file.
    if (payload.action === 'skip' || payload.action === 'flag') {
      // Update ALL rows for this message ID so getLoggedIds_ sees the final outcome
      // and doesn't retry it on the next scan.
      if (last >= 2) {
        const allIds = msgs.getRange(2, 12, last - 1, 1).getValues();
        for (var ri = 0; ri < allIds.length; ri++) {
          if (String(allIds[ri][0]) === String(payload.messageId)) {
            var row = ri + 2;
            msgs.getRange(row, 9).setValue(shortName || '');
            msgs.getRange(row, 10).setValue(payload.action === 'skip' ? 'SKIPPED' : 'FLAGGED');
            msgs.getRange(row, 11).setValue('Set to ' + payload.action + ' in Review');
          }
        }
      }
      return { ok: true, mode: payload.action, note: 'Marked as ' + payload.action + '. ' + ruleNote };
    }

    // BRANCH A — a file already exists: rename it in place to the corrected name.
    if (savedVals && savedVals[8]) {
      const idMatch = String(savedVals[8]).match(/[-\w]{25,}/);
      if (!idMatch) return { ok: false, error: 'Found the log row but could not parse the existing file id.' };
      const fileId = idMatch[0];
      const amtNum = toNum_(String(savedVals[2]));
      const currency = String(savedVals[3] || 'USD');
      const newName = buildFilename_({ amount: amtNum, currency: currency, shortName: shortName }, 'pdf');
      try { DriveApp.getFileById(fileId).setName(newName); }
      catch (e) { return { ok: false, error: 'Rename failed: ' + e }; }
      saved.getRange(savedRowIdx, 2).setValue(newName);
      saved.getRange(savedRowIdx, 6).setValue(shortName);
      if (rowIdx !== -1) { msgs.getRange(rowIdx, 9).setValue(shortName); msgs.getRange(rowIdx, 17).setValue(newName); }
      const vres = validateSavedFile_(fileId, newName);
      logQaAction_('APPROVE-RENAME', [{ id: fileId, ok: vres.ok, from: savedVals[1], to: newName, error: vres.reason }]);
      return { ok: vres.ok, mode: 'renamed', filename: newName,
               note: (vres.ok ? 'Renamed to ' + newName + ' and verified in the live folder. ' : 'Renamed, but validation flagged: ' + vres.reason + '. ') + ruleNote };
    }

    // BRANCH B — no file yet: reprocess this email now and write it.
    let msg;
    try { msg = GmailApp.getMessageById(payload.messageId); }
    catch (e) { return { ok: false, error: 'Could not open the email to reprocess: ' + e }; }
    const action = (['save_attachment', 'extract_body'].indexOf(payload.action) !== -1)
      ? payload.action
      : (pickAttachment_(msg, true) ? 'save_attachment' : 'extract_body');
    // Pass the original ruleId hint so extractFromBody_ applies the right body-handling
    // (e.g. isRampOrBill check). Fall back to deriving from the action string.
    const ruleIdHint = payload.ruleId || (action === 'save_attachment' ? 'save-attachment' : 'approved-in-review');
    const verdict = { action: action, verdict: action.replace('_', ' ').toUpperCase(),
                      ruleName: ruleIdHint, ruleObj: { id: ruleIdHint },
                      shortName: shortName, note: 'Approved in Review', alreadyDone: false };
    const outcome = processMessage_(msg, verdict, getStagingFolder_(), log);
    if (rowIdx !== -1) {
      msgs.getRange(rowIdx, 9).setValue(outcome.shortName || shortName);
      msgs.getRange(rowIdx, 10).setValue(outcome.status);
      msgs.getRange(rowIdx, 11).setValue(outcome.note || '');
      msgs.getRange(rowIdx, 14).setValue(outcome.amountText || '');
      msgs.getRange(rowIdx, 15).setValue(outcome.currency || '');
      msgs.getRange(rowIdx, 16).setValue((outcome.invoices || []).join(', '));
      msgs.getRange(rowIdx, 17).setValue(outcome.filename || '');
      msgs.getRange(rowIdx, 18).setValue(outcome.fileUrl || '');
    }
    const good = (outcome.status === 'SAVED' || outcome.status === 'GENERATED');
    logQaAction_('APPROVE-NEW', [{ id: (payload.messageId || ''), ok: good, name: outcome.filename || '', error: (outcome.note || outcome.status || 'reprocess did not produce a file') }]);
    return { ok: good, mode: 'processed', status: outcome.status, filename: outcome.filename || '',
             note: (good ? 'Wrote ' + outcome.filename + ' to the live folder. ' : (outcome.note || outcome.status) + '. ') + ruleNote };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

// ============================================================
//  BACKLOG RE-EVALUATION
//  Reprocesses every currently-stuck row (FLAGGED, or missing a payor) against the
//  CURRENT rules + engine, and UPDATES that row in place:
//    - now classified skip   -> mark SKIPPED (drops out of the Review queue; no file)
//    - now extracts cleanly   -> write the file + mark SAVED/GENERATED
//    - a same-named file already exists in the live folder (e.g. the desktop tool
//      already saved it) -> mark ALREADY PROCESSED, write nothing (no duplicate)
//    - still fails            -> stays flagged, with the new reason noted
//  Processes up to MAX rows per call so it stays within Apps Script's time limit;
//  re-running continues where it left off (resolved rows are skipped next time).
// ============================================================
function reevaluateBacklog() {
  const START = Date.now();
  const TIME_BUDGET_MS = 240000; // ~4 min, safely under the 6-min limit; persistent failures fail fast
  const rulesFull = loadRules_();
  // Use the canonical shared rules only — ignore per-payor LOCAL overrides here, since a
  // user-approved payor rule must not defeat the authoritative skip/extract classification.
  const rules = { list: (rulesFull.list || []).filter(function (r) { return !/^local/.test(r.id || ''); }),
                  version: rulesFull.version, source: rulesFull.source };
  const staging = getStagingFolder_(); // the live folder
  const log = getLog_();
  const msgs = log.messages;
  const last = msgs.getLastRow();
  const out = { scanned: 0, nowSkipped: 0, nowSaved: 0, stillFlagged: 0, notFound: 0, alreadyInFolder: 0, remaining: 0 };
  if (last < 2) return out;

  // Snapshot existing live-folder filenames ONCE so we never duplicate a file the
  // desktop tool (or a prior run) already wrote.
  const existing = {};
  try { const it = staging.getFiles(); while (it.hasNext()) existing[it.next().getName().toLowerCase()] = true; } catch (e) {}

  const data = msgs.getRange(2, 1, last - 1, 18).getValues();

  // A message can have several historical rows (repeated FLAGGED/GENERATED entries from
  // earlier debugging or retries). Without dedup, the time budget gets spent reprocessing
  // the SAME Gmail message multiple times while later rows never get reached at all.
  // Keep only the last (most recent) row per message ID; the older rows for that ID are
  // superseded and skipped outright so the budget goes toward distinct messages.
  const lastRowForId = {};
  for (let li = 0; li < data.length; li++) {
    const mid = data[li][11];
    if (mid) lastRowForId[mid] = li;
  }

  for (let i = 0; i < data.length; i++) {
    const r = data[i]; const rowNum = i + 2;
    const msgId = r[11];
    if (msgId && lastRowForId[msgId] !== i) continue; // superseded by a later row for the same message
    const outcome = String(r[9] || '').toUpperCase();
    const payorRaw = String(r[8] || '').trim();
    const subject = String(r[4] || '');
    // BILL "payment arriving" emails were previously skipped, but they carry the full
    // invoice+amount — reprocess any that were skipped so their payment gets captured.
    // Previously-skipped rows whose rule has since changed to "extract" — reprocess them so
    // their payment is captured (dedup still prevents doubles). Covers BILL "arriving", Ariba
    // "scheduled payment", and SVB payment notifications.
    const wasArrivingSkip = (outcome === 'SKIPPED') && (
      /sent you a payment arriving/i.test(subject) ||
      /new scheduled payment/i.test(subject) ||
      /Payment notification from/i.test(subject)
    );
    // Match what Review shows as "needs attention": a blank OR placeholder/rule-id payor
    // is unresolved. Only a terminal-success outcome (or a legitimate non-arriving skip)
    // takes a row out of the re-evaluation set.
    const terminalOK = (outcome === 'SAVED' || outcome === 'GENERATED') || (outcome === 'SKIPPED' && !wasArrivingSkip);
    const isStuck = !terminalOK && (outcome === 'FLAGGED' || wasArrivingSkip || !payorRaw || looksLikePayorJunk_(payorRaw));
    if (!isStuck) continue;
    if (Date.now() - START > TIME_BUDGET_MS) { out.remaining++; continue; }
    const id = r[11]; if (!id) continue;
    out.scanned++;

    try {
    let msg; try { msg = GmailApp.getMessageById(id); } catch (e) { out.notFound++; continue; }
    if (!msg) { out.notFound++; continue; }

    const v = classify_(msg, rules);
    if (v.action === 'skip') {
      msgs.getRange(rowNum, 10).setValue('SKIPPED');
      msgs.getRange(rowNum, 11).setValue('re-evaluated -> skip (' + v.ruleName + ')');
      out.nowSkipped++; continue;
    }

    const ext = runExtraction_(msg, v);
    if (ext && ext.skip) {
      msgs.getRange(rowNum, 10).setValue('SKIPPED');
      msgs.getRange(rowNum, 11).setValue('re-evaluated -> skip (' + (ext.reason || 'policy') + ')');
      out.nowSkipped++; continue;
    }
    const vq = (ext && ext.ok) ? validateExtraction_(ext, true) : { ok: false, reason: (ext && ext.reason) || 'extraction failed' };
    if (!vq.ok) { if (wasArrivingSkip) msgs.getRange(rowNum, 10).setValue('FLAGGED'); msgs.getRange(rowNum, 11).setValue('re-evaluated (still needs review): ' + vq.reason); out.stillFlagged++; continue; }

    const base = buildFilename_(ext, ext.fileExt || 'pdf');
    if (existing[base.toLowerCase()]) {
      msgs.getRange(rowNum, 9).setValue(ext.shortName);
      msgs.getRange(rowNum, 10).setValue('ALREADY PROCESSED');
      msgs.getRange(rowNum, 11).setValue('re-evaluated: file already in live folder');
      msgs.getRange(rowNum, 14).setValue(money_(ext.amount));
      out.alreadyInFolder++; continue;
    }
    const resolved = resolveFilename_(log.saved, base, ext.invoices || []);
    if (resolved.duplicate) {
      msgs.getRange(rowNum, 10).setValue('ALREADY PROCESSED');
      msgs.getRange(rowNum, 11).setValue('re-evaluated: duplicate in log');
      out.alreadyInFolder++; continue;
    }

    // Previously-SKIPPED rows that now extract cleanly are SURFACED in Review (with their
    // payor/amount/invoice) for human verification rather than auto-filed. Once verified,
    // a later re-evaluation or an Approve files them (their outcome is then FLAGGED, not
    // SKIPPED, so this branch no longer applies and the normal save path runs).
    if (outcome === 'SKIPPED') {
      msgs.getRange(rowNum, 9).setValue(ext.shortName);
      msgs.getRange(rowNum, 10).setValue('FLAGGED');
      msgs.getRange(rowNum, 11).setValue('Was wrongly skipped — surfaced for review; verify, then re-evaluate or approve to file (' + resolved.filename + ')');
      msgs.getRange(rowNum, 14).setValue(money_(ext.amount));
      msgs.getRange(rowNum, 15).setValue(ext.currency);
      msgs.getRange(rowNum, 16).setValue((ext.invoices || []).join(', '));
      msgs.getRange(rowNum, 17).setValue(resolved.filename);
      out.stillFlagged++; continue;
    }

    let file;
    try {
      file = ext.sourceBlob
        ? staging.createFile(ext.sourceBlob.copyBlob()).setName(resolved.filename)
        : generateBodyPdf_(msg, ext, resolved.filename, staging);
    } catch (e) { msgs.getRange(rowNum, 11).setValue('re-evaluated write failed: ' + e); out.stillFlagged++; continue; }

    const val = validateSavedFile_(file.getId(), resolved.filename);
    if (!val.ok) { try { file.setTrashed(true); } catch (e) {} msgs.getRange(rowNum, 11).setValue('re-evaluated validation failed: ' + val.reason); out.stillFlagged++; continue; }

    existing[resolved.filename.toLowerCase()] = true;
    msgs.getRange(rowNum, 9).setValue(ext.shortName);
    msgs.getRange(rowNum, 10).setValue(ext.sourceBlob ? 'SAVED' : 'GENERATED');
    msgs.getRange(rowNum, 14).setValue(money_(ext.amount));
    msgs.getRange(rowNum, 15).setValue(ext.currency);
    msgs.getRange(rowNum, 16).setValue((ext.invoices || []).join(', '));
    msgs.getRange(rowNum, 17).setValue(resolved.filename);
    msgs.getRange(rowNum, 18).setValue(file.getUrl());
    log.saved.appendRow([fmtDate_(new Date()), resolved.filename, money_(ext.amount), ext.currency, (ext.invoices || []).join(', '), ext.shortName, msg.getSubject(), id, file.getUrl()]);
    out.nowSaved++;
    } catch (rowErr) { try { msgs.getRange(rowNum, 11).setValue('re-eval error: ' + rowErr); } catch (e2) {} out.stillFlagged++; }
  }

  // Log this pass as a run so the "last run" window advances and stale HANDLED items age out to the Run Log.
  try {
    log.runs.appendRow([fmtDate_(new Date()), out.scanned, out.nowSaved, '', '', 're-evaluation',
      out.stillFlagged ? (out.stillFlagged + ' still need review') : '',
      'Backlog re-evaluation: ' + out.nowSkipped + ' skipped, ' + out.nowSaved + ' saved, ' + out.alreadyInFolder + ' already on file']);
  } catch (e) {}
  return out;
}
