/**
 * ================================================================
 *  SE REMITTANCE AGENT — PHASE 2: EXTRACTION + STAGING
 * ================================================================
 *
 *  What's new vs phase 1
 *  ---------------------
 *  The scanner now PROCESSES what it classifies:
 *    • extract_body emails  → payment data pulled from the body,
 *      a clean PDF generated, saved to staging  ("Track A")
 *    • save_attachment emails → the PDF/HTML attachment saved to
 *      staging, amount read out of the file itself ("Track B")
 *    • Naming convention applied: $63,256.97 GSK.pdf,
 *      " GBP" suffix for non-USD, _2/_3 for same-name-different-invoices,
 *      true duplicates (same name + same invoices) skipped
 *
 *  SHADOW MODE (current setting)
 *  -----------------------------
 *  Files are written to the staging folder, but NOTHING in Gmail is
 *  touched — no labels, no read/unread. Your desktop app is entirely
 *  unaffected; run both and compare. When the desktop app retires,
 *  change MODE to 'live' below and the marker label switches on.
 *
 *  Setup (after pasting)
 *  ---------------------
 *  1. Left sidebar → Services → + → choose "Drive API"
 *     (version v3, identifier "Drive") → Add.
 *     This is what lets the script read amounts out of PDF attachments.
 *     Without it, PDF emails are flagged for review instead — never lost.
 *  2. Run  runRemittanceScan  once → Google will re-ask permissions
 *     (the script gained Drive/Docs powers) → approve.
 *  3. Clock icon (Triggers) in the left rail: if your every-10-minutes
 *     trigger is listed, you're done — it uses the new code automatically.
 *     If the list is empty, run  installTrigger  once.
 *
 *  Outputs
 *  -------
 *  • Files:  My Drive → "Remittance Agent — Staging"
 *  • Log:    same spreadsheet as before, with new columns
 *            (Amount, Currency, Invoices, Filename, File link)
 *            plus a "Saved" tab acting as the staging index
 *  • Quick test without waiting for new mail:  run  testNewestExtraction
 *    — extracts from the most recent group message and prints what it
 *    found, without writing anything.
 */

// ============================ CONFIG ============================

const CONFIG = {
  GROUP_ADDRESS: 'remittances@scienceexchange.com',
  LOOKBACK_DAYS: 7,
  TRIGGER_MINUTES: 10,
  RULES_URL: 'https://raw.githubusercontent.com/aronhasofer-apps/se-remittance-agent/main/rules.json',
  MARKER_LABEL: 'Remittance Agent',
  LOG_FILE_NAME: 'SE Remittance Agent — Log',
  STAGING_FOLDER_NAME: 'Remittance Agent — Staging', // legacy; no longer used for writing
  LIVE_FOLDER_ID: '1sx3PiXDdxu3jRKcvJR-f4sZi2Bn8q44P', // remits not applied (Finance > AR > Daily Cash Receipts)

  // 'shadow' = write files, touch nothing in Gmail (desktop app unaffected)
  // 'live'   = also apply the marker label after processing
  MODE: 'shadow',

  // Sanity bounds — outside this range the item is flagged, never lost.
  AMOUNT_MIN: 0.01,
  AMOUNT_MAX: 1000000000000,

  MAX_PROCESS_PER_RUN: 25, // anything beyond rolls to the next 10-min cycle
}

/**
 * The engine's tunable settings, with live overrides from Script Properties
 * (written by the Settings page) layered over the CONFIG defaults. Everything
 * that the UI can change flows through here so a Settings change takes effect
 * on the very next run — no redeploy.
 */
function effectiveConfig_() {
  const p = PropertiesService.getScriptProperties();
  function num(key, dflt) { const v = p.getProperty(key); const n = v == null ? NaN : Number(v); return isFinite(n) ? n : dflt; }
  function str(key, dflt) { const v = p.getProperty(key); return (v == null || v === '') ? dflt : v; }
  return {
    lookbackDays: num('SET_LOOKBACK_DAYS', CONFIG.LOOKBACK_DAYS),
    maxPerRun: num('SET_MAX_PER_RUN', CONFIG.MAX_PROCESS_PER_RUN),
  };
}

/**
 * The true backlog: how many remittance emails are sitting UNREAD in the mailbox,
 * regardless of whether the agent has touched them. This is the honest "what's left
 * for a human" number — not the app's internal log count.
 */
function inboxBacklog_() {
  const cfg = effectiveConfig_();
  // Unread mail addressed to / relayed from the remittance group in the lookback window.
  const q = '{to:' + CONFIG.GROUP_ADDRESS + ' list:' + CONFIG.GROUP_ADDRESS + ' deliveredto:' + CONFIG.GROUP_ADDRESS + '} is:unread newer_than:' + cfg.lookbackDays + 'd';
  let unread = 0;
  try {
    const threads = GmailApp.search(q, 0, 100);
    // Count unread MESSAGES (not threads) for an accurate figure.
    threads.forEach(function (t) {
      t.getMessages().forEach(function (m) { if (m.isUnread()) unread++; });
    });
  } catch (e) { unread = -1; } // -1 = couldn't read the inbox
  return { unread: unread, lookbackDays: cfg.lookbackDays };
};

// ========================= ENTRY POINTS =========================

function runRemittanceScan() {
  const EFFCFG = effectiveConfig_();
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return; // previous run still finishing
  try {
    const log = getLog_();
    const seen = getLoggedIds_(log.messages);
    const rules = loadRules_();
    const rulesVer = rules.version || '0';
    try { PropertiesService.getScriptProperties().setProperty('LAST_RULES_VERSION', rulesVer); } catch(e) {}
    const staging = getStagingFolder_();

    const found = findMessages_().filter(function (it) {
      return !seen.has(it.message.getId());
    });
    // oldest first, so _2/_3 suffixes follow arrival order
    found.sort(function (a, b) { return a.message.getDate() - b.message.getDate(); });

    const rows = [];
    const counts = { saved: 0, generated: 0, skipped: 0, flagged: 0, duplicate: 0, already: 0 };
    let processedThisRun = 0;
    let deferred = 0;

    for (let i = 0; i < found.length; i++) {
      const msg = found[i].message;
      const v = classify_(msg, rules);
      let outcome;

      if (v.alreadyDone) {
        outcome = { status: 'ALREADY PROCESSED', note: 'Marker label already on this thread' };
        counts.already++;
      } else if (v.action === 'skip') {
        outcome = { status: 'SKIPPED', note: v.note || rulesLabel_(v) };
        counts.skipped++;
      } else if (v.action === 'flag') {
        outcome = { status: 'FLAGGED', note: v.note || 'Needs human review' };
        counts.flagged++;
      } else if (processedThisRun >= EFFCFG.maxPerRun) {
        deferred++;
        continue; // not logged → picked up next cycle
      } else {
        outcome = processMessage_(msg, v, staging, log);
        processedThisRun++;
        if (outcome.status === 'SAVED') counts.saved++;
        else if (outcome.status === 'GENERATED') counts.generated++;
        else if (outcome.status === 'DUPLICATE') counts.duplicate++;
        else counts.flagged++;
      }

      // Mark handled mail read so an unread inbox means "not yet processed."
      // Deferred (over per-run cap) hit `continue` above and never reach here,
      // so they correctly stay unread for the next cycle. Best-effort — a
      // read-state failure must never block logging or dedup.
      try { msg.markRead(); } catch (e) {}

      rows.push([
        fmtDate_(new Date()),
        fmtDate_(msg.getDate()),
        found[i].location,
        msg.getFrom(),
        msg.getSubject(),
        hasPdf_(msg) ? 'yes' : 'no',
        v.verdict,
        v.ruleName,
        outcome.shortName || v.shortName || '',
        outcome.status,
        ((outcome.note || '') + ' [rules:' + rulesVer + ']').trim(),
        msg.getId(),
        mailLink_(msg),
        outcome.amountText || '',
        outcome.currency || '',
        (outcome.invoices || []).join(', '),
        outcome.filename || '',
        outcome.fileUrl || '',
      ]);
    }

    if (rows.length) {
      log.messages
        .getRange(log.messages.getLastRow() + 1, 1, rows.length, rows[0].length)
        .setValues(rows);
    }
    const summary = counts.saved + ' saved, ' + counts.generated + ' generated, ' +
      counts.skipped + ' skipped, ' + counts.flagged + ' flagged, ' +
      counts.duplicate + ' duplicates, ' + counts.already + ' already processed' +
      (deferred ? ', ' + deferred + ' deferred to next run' : '');
    log.runs.appendRow([
      fmtDate_(new Date()), found.length, rows.length,
      rules.list.length, rules.version, rules.source, '', summary,
    ]);
    Logger.log('Scan done. ' + rows.length + ' new message(s). ' + summary +
      '. Log: ' + log.url);
  } catch (err) {
    try {
      getLog_().runs.appendRow([fmtDate_(new Date()), '', '', '', '', '', 'ERROR: ' + err, '']);
    } catch (ignore) {}
    throw err;
  } finally {
    lock.releaseLock();
  }
}

function installTrigger() {
  removeTrigger();
  ScriptApp.newTrigger('runRemittanceScan')
    .timeBased().everyMinutes(CONFIG.TRIGGER_MINUTES).create();
  Logger.log('Trigger installed — runRemittanceScan will run every ' + CONFIG.TRIGGER_MINUTES + ' minutes.');
}

function removeTrigger() {
  let n = 0;
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'runRemittanceScan') { ScriptApp.deleteTrigger(t); n++; }
  });
  Logger.log('Removed ' + n + ' trigger(s).');
}

function testRulesFetch() {
  const r = loadRules_();
  Logger.log('rules.json v' + r.version + ' loaded from ' + r.source + ' — ' + r.list.length + ' rules.');
}

/**
 * Extraction dry-run on the newest group message that isn't already
 * processed. Prints what it found and the filename it WOULD use.
 * Writes nothing anywhere.
 */
function testNewestExtraction() {
  const rules = loadRules_();
  const found = findMessages_();
  found.sort(function (a, b) { return b.message.getDate() - a.message.getDate(); });
  for (let i = 0; i < found.length; i++) {
    const msg = found[i].message;
    const v = classify_(msg, rules);
    if (v.alreadyDone || (v.action !== 'save_attachment' && v.action !== 'extract_body')) continue;
    Logger.log('Testing on: "' + msg.getSubject() + '" (' + fmtDate_(msg.getDate()) + ')');
    const ext = runExtraction_(msg, v);
    if (!ext.ok) {
      Logger.log('Would FLAG — ' + ext.reason);
    } else {
      Logger.log('Payor: ' + ext.payor + '  |  Short: ' + ext.shortName +
        '  |  Amount: ' + money_(ext.amount) + ' ' + ext.currency +
        '  |  Invoices: ' + (ext.invoices.join(', ') || '(none)'));
      Logger.log('Filename would be: ' + buildFilename_(ext, ext.fileExt || 'pdf'));
    }
    return;
  }
  Logger.log('No processable message found in the window.');
}

// ============================ GMAIL =============================

function findMessages_() {
  // list: matches the mailing-list stamp Google Groups presses onto every
  // relayed message — survives From-rewrites and the remittance@ alias.
  // to:/deliveredto: kept as harmless belt-and-braces.
  const base = '{list:' + CONFIG.GROUP_ADDRESS +
               ' to:' + CONFIG.GROUP_ADDRESS +
               ' deliveredto:' + CONFIG.GROUP_ADDRESS + '}' +
               ' newer_than:' + effectiveConfig_().lookbackDays + 'd';
  const buckets = [
    { q: base,               location: 'Mail'  },
    { q: base + ' in:spam',  location: 'SPAM'  },
    { q: base + ' in:trash', location: 'TRASH' },
  ];
  const cutoff = Date.now() - effectiveConfig_().lookbackDays * 24 * 60 * 60 * 1000;
  const out = new Map();

  buckets.forEach(function (b) {
    GmailApp.search(b.q, 0, 200).forEach(function (thread) {
      thread.getMessages().forEach(function (msg) {
        if (msg.getDate().getTime() < cutoff) return;
        const id = msg.getId();
        if (!out.has(id) || b.location !== 'Mail') {
          out.set(id, { message: msg, location: b.location });
        }
      });
    });
  });
  return Array.from(out.values());
}

function applyMarker_(msg) {
  try {
    const label = GmailApp.getUserLabelByName(CONFIG.MARKER_LABEL) ||
                  GmailApp.createLabel(CONFIG.MARKER_LABEL);
    label.addToThread(msg.getThread()); // message stays UNREAD by design
  } catch (e) { /* labeling must never break processing */ }
}

/**
 * Portable "open email" link. Uses the RFC-822 Message-ID header — which is
 * identical in every mailbox that received the email — via a lightweight Gmail
 * metadata read (headers only, no body/attachments), so the link works for any
 * finance colleague on the remittances@ group, not just the mailbox owner.
 * Falls back to the owner-only #all/<id> link if the header can't be read.
 * Called once per newly-logged message during a scan, so the extra metadata
 * fetch never touches page loads or the live Review UI.
 */
function mailLink_(msg) {
  var id = msg.getId();
  try {
    var resp = UrlFetchApp.fetch(
      'https://gmail.googleapis.com/gmail/v1/users/me/messages/' + id +
      '?format=metadata&metadataHeaders=Message-ID',
      { headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
        muteHttpExceptions: true });
    if (resp.getResponseCode() === 200) {
      var headers = ((JSON.parse(resp.getContentText()) || {}).payload || {}).headers || [];
      for (var i = 0; i < headers.length; i++) {
        if (/^message-id$/i.test(headers[i].name || '')) {
          var mid = String(headers[i].value || '').trim().replace(/^<|>$/g, '');
          if (mid) return 'https://mail.google.com/mail/u/0/#search/rfc822msgid:' + encodeURIComponent(mid);
        }
      }
    }
  } catch (e) { /* fall through to the owner-only link */ }
  return 'https://mail.google.com/mail/u/0/#all/' + id;
}

// ======================== CLASSIFICATION ========================

function classify_(msg, rules) {
  const subject = msg.getSubject() || '';
  const s = subject.toLowerCase();
  const f = (msg.getFrom() || '').toLowerCase();

  let bodyStart = null;
  const snippet = function () {
    if (bodyStart === null) {
      try { bodyStart = (msg.getPlainBody() || '').slice(0, 1500).toLowerCase(); }
      catch (e) { bodyStart = ''; }
    }
    return bodyStart;
  };

  let hit = null;
  // Pass 1 — SKIP rules are authoritative and always win (an invoice-receipt, Ariba
  // notice, etc. must skip regardless of any payor rule a user approved).
  for (let i = 0; i < rules.list.length; i++) {
    const r = rules.list[i];
    if (String(r.action || '').toLowerCase() === 'skip' && ruleMatches_(r, s, snippet, f)) { hit = r; break; }
  }
  // Pass 2 — otherwise the first matching rule (local overrides are checked first).
  if (!hit) {
    for (let i = 0; i < rules.list.length; i++) {
      if (ruleMatches_(rules.list[i], s, snippet, f)) { hit = rules.list[i]; break; }
    }
  }

  let action = hit ? String(hit.action || 'flag').toLowerCase() : 'flag';
  let note = hit ? '' : 'Unknown payor or in-thread reply';

  // Engine refinement: BILL partial batches "X of Y invoices" (X < Y) wait.
  const partial = subject.match(/(\d+)\s+of\s+(\d+)\s+invoices?/i);
  if (partial && (f.indexOf('bill') !== -1 || s.indexOf('bill') !== -1)) {
    const x = parseInt(partial[1], 10), y = parseInt(partial[2], 10);
    if (x < y) {
      action = 'skip';
      note = 'BILL partial batch (' + x + ' of ' + y + ') — wait for full batch';
    }
  }

  return {
    action: action,
    verdict: action.replace('_', ' ').toUpperCase(),
    ruleName: hit ? (hit.id || '(unnamed rule)') : '(no rule matched)',
    ruleObj: hit,
    shortName: hit ? (hit.short_name || '') : '',
    noLabel: hit ? hit.no_label === true : false,
    note: note,
    alreadyDone: false, // was threadHasMarker_(msg). Disabled: payors reuse identical subjects, so Gmail groups DISTINCT payments into one thread; skipping on the thread marker dropped real payments. Message-ID dedup (getLoggedIds_) already prevents true re-processing.
  };
}

function ruleMatches_(rule, subjectLower, snippetFn, fromLower) {
  const m = rule.match || {};
  // Sender is a primary signal, independent of the subject line. Many payors
  // (e.g. Gilead's ERPPAYABLES@gilead.com) have a generic subject but an
  // unmistakable From address — match on that first.
  const from = m.from_contains || [];
  if (from.length && fromLower) {
    for (let k = 0; k < from.length; k++) {
      if (fromLower.indexOf(String(from[k]).toLowerCase()) !== -1) return true;
    }
  }
  const subj = m.subject_contains || [];
  for (let i = 0; i < subj.length; i++) {
    if (subjectLower.indexOf(String(subj[i]).toLowerCase()) !== -1) return true;
  }
  const snip = m.snippet_contains || [];
  if (snip.length) {
    const body = snippetFn();
    for (let j = 0; j < snip.length; j++) {
      if (body.indexOf(String(snip[j]).toLowerCase()) !== -1) return true;
    }
  }
  return false;
}

function rulesLabel_(v) {
  return v.ruleName ? 'Rule: ' + v.ruleName : '';
}

function hasPdf_(msg) {
  return !!pickAttachment_(msg, true);
}

/** Prefer a PDF; fall back to an HTML attachment (Vertex). */
function pickAttachment_(msg, pdfOnly) {
  try {
    const atts = msg.getAttachments({ includeInlineImages: false, includeAttachments: true });
    for (let i = 0; i < atts.length; i++) {
      const a = atts[i];
      if (/pdf/i.test(a.getContentType() || '') || /\.pdf$/i.test(a.getName() || '')) return a;
    }
    if (!pdfOnly) {
      for (let j = 0; j < atts.length; j++) {
        const a = atts[j];
        if (/html/i.test(a.getContentType() || '') || /\.html?$/i.test(a.getName() || '')) return a;
      }
    }
  } catch (e) {}
  // getAttachments() has been observed to return empty for a message that DOES have a
  // real attachment when the trigger-context Gmail API hasn't fully hydrated it (the same
  // class of quirk documented for getPlainBody() elsewhere in this file). Fall back to
  // parsing the raw MIME directly and rebuild a real Blob — copyBlob()/getName()/
  // getContentType()/getDataAsString() all work identically to a normal attachment object,
  // so this is a transparent drop-in for every caller.
  try {
    const raw = msg.getRawContent();
    if (!raw) return null;
    const chunks = raw.split(/\r?\n--[^\r\n]+\r?\n/);
    const wantType = pdfOnly ? /application\/pdf/i : /application\/pdf|text\/html/i;
    for (let ci = 0; ci < chunks.length; ci++) {
      const chunk = chunks[ci];
      const ctMatch = chunk.match(/Content-Type:\s*([^;\r\n]+)/i);
      if (!ctMatch || !wantType.test(ctMatch[1])) continue;
      const mimeType = ctMatch[1].trim();
      const nameMatch = chunk.match(/(?:filename|name)\s*=\s*"?([^"\r\n;]+)"?/i);
      const filename = nameMatch ? nameMatch[1].trim() : ('attachment.' + (/pdf/i.test(mimeType) ? 'pdf' : 'html'));
      const bodyMatch = chunk.match(/\r?\n\r?\n([\s\S]*)$/);
      if (!bodyMatch) continue;
      let payload = bodyMatch[1];
      if (/Content-Transfer-Encoding:\s*base64/i.test(chunk)) {
        try {
          const bytes = Utilities.base64Decode(payload.replace(/[^A-Za-z0-9+/=]/g, ''));
          return Utilities.newBlob(bytes, mimeType, filename);
        } catch (e2) { continue; }
      }
      // Non-base64 (rare for PDFs, possible for HTML parts) — use as text directly.
      return Utilities.newBlob(payload, mimeType, filename);
    }
  } catch (e3) {}
  return null;
}

function threadHasMarker_(msg) {
  try {
    return msg.getThread().getLabels().some(function (l) {
      return l.getName() === CONFIG.MARKER_LABEL;
    });
  } catch (e) { return false; }
}

// ========================== PROCESSING ==========================

/**
 * Runs extraction, resolves the filename against the staging index,
 * and writes the file (attachment copy or generated PDF).
 */
function processMessage_(msg, v, staging, log) {
  const ext = runExtraction_(msg, v);
  if (ext && ext.skip) {
    return { status: 'SKIPPED', note: ext.reason || 'skipped per policy', shortName: shortName_('', v.shortName) };
  }
  if (!ext.ok) {
    return { status: 'FLAGGED', note: ext.reason, shortName: shortName_('', v.shortName) };
  }

  if (ext.amount < CONFIG.AMOUNT_MIN || ext.amount > CONFIG.AMOUNT_MAX) {
    return {
      status: 'FLAGGED',
      note: 'Amount ' + money_(ext.amount) + ' outside sanity bounds — review',
      shortName: ext.shortName,
      amountText: money_(ext.amount), currency: ext.currency, invoices: ext.invoices,
    };
  }

  // Extraction-QA gate - the single checkpoint that guarantees no incomplete or
  // mislabeled record is ever written. Anything that fails here goes to Review
  // instead of producing a bad file/row.
  const vq = validateExtraction_(ext, true); // invoices are best-effort, not required (see note above)
  if (!vq.ok) {
    return { status: 'FLAGGED', note: vq.reason, shortName: ext.shortName,
             amountText: (ext.amount != null ? money_(ext.amount) : ''), currency: ext.currency, invoices: ext.invoices };
  }

  const base = buildFilename_(ext, ext.fileExt || 'pdf');
  const resolved = resolveFilename_(log.saved, base, ext.invoices);
  if (resolved.duplicate) {
    return {
      status: 'DUPLICATE',
      note: 'Same filename + same invoices already staged (' + resolved.filename + ')',
      shortName: ext.shortName,
      amountText: money_(ext.amount), currency: ext.currency, invoices: ext.invoices,
      filename: resolved.filename,
    };
  }

  let file;
  try {
    if (ext.sourceBlob) {
      file = staging.createFile(ext.sourceBlob.copyBlob()).setName(resolved.filename);
    } else {
      file = generateBodyPdf_(msg, ext, resolved.filename, staging);
    }
  } catch (e) {
    return { status: 'FLAGGED', note: 'File write failed: ' + e, shortName: ext.shortName };
  }

  // RIGOROUS VALIDATION: verify the file truly landed in the live folder, is a real
  // non-empty PDF, and is named as intended — BEFORE we log it as saved. This is what
  // guarantees the log reflects reality (fixes the phantom-save gap).
  const vres = validateSavedFile_(file.getId(), resolved.filename);
  if (!vres.ok) {
    // Try to clean up a bad partial write so it can't masquerade as good later.
    try { file.setTrashed(true); } catch (e) {}
    return {
      status: 'ERROR',
      note: 'Save could not be verified — ' + vres.reason + '. Not logged as saved; needs a re-run.',
      shortName: ext.shortName,
      amountText: money_(ext.amount), currency: ext.currency, invoices: ext.invoices,
      filename: resolved.filename,
    };
  }

  log.saved.appendRow([
    fmtDate_(new Date()), resolved.filename, money_(ext.amount), ext.currency,
    ext.invoices.join(', '), ext.payor, msg.getSubject(), msg.getId(), file.getUrl(),
  ]);

  return {
    status: ext.sourceBlob ? 'SAVED' : 'GENERATED',
    note: (ext.note || '') + ' (verified in live folder)',
    shortName: ext.shortName,
    amountText: money_(ext.amount),
    currency: ext.currency,
    invoices: ext.invoices,
    filename: resolved.filename,
    fileUrl: file.getUrl(),
    verified: true,
  };
}

/**
 * Decides the extraction path and returns
 * { ok, payor, shortName, amount, currency, invoices[], sourceBlob?, fileExt?, note?, reason? }
 */
function runExtraction_(msg, v) {
  const att = pickAttachment_(msg, false);

  if (v.action === 'save_attachment' && att) {
    const attResult = extractFromAttachment_(msg, v, att);
    if (attResult.ok) return attResult;
    // Attachment found but couldn't be read (PDF unreadable, Drive API issue, etc.)
    // Fall back to body extraction — payor may still be in subject/body.
    const bodyResult = extractFromBody_(msg, v);
    if (bodyResult.ok) {
      bodyResult.note = ((bodyResult.note || '') + ' PDF unreadable — extracted from body instead').trim();
      return bodyResult;
    }
    // Both failed — return the original attachment error so the note is informative.
    return attResult;
  }
  // extract_body — or an attachment rule whose attachment never arrived
  // (e.g. Regeneron sends the advice in the body): fall back to body.
  const ext = extractFromBody_(msg, v);
  if (ext.ok && v.action === 'save_attachment') {
    ext.note = ((ext.note || '') + ' No attachment found — extracted from body instead').trim();
  }
  return ext;
}

// ------------------------- Track A: body -------------------------

function extractFromBody_(msg, v) {
  const subject = msg.getSubject() || '';
  let body = '';
  try { body = msg.getPlainBody() || ''; } catch (e) {}
  // If getPlainBody() returned empty (common in trigger context for multipart emails),
  // extract the plain-text part from the raw MIME. This is reliable across all contexts.
  if (!body || body.length < 10) {
    try {
      const raw = msg.getRawContent();
      if (raw) {
        // Find text/plain MIME part
        const chunks = raw.split(/\r?\n--[^\r\n]+\r?\n/);
        for (let ci = 0; ci < chunks.length; ci++) {
          const chunk = chunks[ci];
          if (!/content-type:\s*text\/plain/i.test(chunk)) continue;
          const pm = chunk.match(/\r?\n\r?\n([\s\S]*)$/);
          if (!pm) continue;
          let part = pm[1];
          // Handle quoted-printable encoding
          if (/content-transfer-encoding:\s*quoted-printable/i.test(chunk)) {
            part = part.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/gi,
              function(_, h) { return String.fromCharCode(parseInt(h, 16)); });
          }
          // Handle base64 encoding
          if (/content-transfer-encoding:\s*base64/i.test(chunk)) {
            try { part = Utilities.newBlob(Utilities.base64Decode(part.replace(/\s/g,''))).getDataAsString(); } catch(e2) {}
          }
          part = part.trim();
          if (part.length > 10) { body = part; break; }
        }
      }
    } catch (e) {}
  }
  // NOTE: We deliberately do NOT fall back to the HTML body (msg.getBody()) here.
  // Gmail's getBody() returns the full threaded HTML — every prior message in the
  // conversation — which causes cross-customer payor/invoice contamination.
  // Plain body is always sufficient; if it's empty the email will flag for review.

  // Some remittances (e.g. Regeneron) deliver the full advice as an HTML ATTACHMENT
  // rather than in the body — pull any HTML attachment text in too. Route through
  // pickAttachment_ (not a separate getAttachments() call) so this benefits from its
  // raw-MIME fallback for the same trigger-context empty-attachments quirk.
  let attText = '';
  try {
    const htmlAtt = pickAttachment_(msg, false);
    if (htmlAtt && /html/i.test(htmlAtt.getContentType() || '') || (htmlAtt && /\.html?$/i.test(htmlAtt.getName() || ''))) {
      attText += '\n' + stripHtml_(htmlAtt.getDataAsString());
    }
  } catch (e) {}
  let text = subject + '\n' + body + '\n' + attText;
  // If nothing that looks like a money amount is present, the advice is likely inside an
  // HTML attachment GmailApp can't see — fetch every part via the Gmail REST API.
  if (!/[\d,]{1,12}\.\d{2}/.test(text)) {
    try { text += '\n' + stripHtml_(fetchAllHtmlParts_(msg)); } catch (e) {}
  }
  const ruleId = v.ruleObj ? v.ruleObj.id : '';

  let r = null;
  if (/^bill/.test(ruleId))                          r = extractBill_(subject, body);
  else if (/^ramp/.test(ruleId))                     r = extractRamp_(subject, body);
  else if (ruleId === 'merck-body')                  r = extractMerck_(text);
  else if (ruleId === 'coupa-body' || ruleId === 'neurocrine-body') r = extractCoupa_(subject, body, ruleId);
  else if (/^regeneron/.test(ruleId))                r = extractRegeneron_(text);
  else if (/^svb/.test(ruleId))                      r = extractSVB_(text);
  else if (/^ariba/.test(ruleId))                    r = extractAriba_(text);
  else if (/^brex/.test(ruleId))                     r = extractBrex_(subject, body);
  else if (/^zip-payment/.test(ruleId))              r = extractZip_(subject, body);
  else if (/^mineraltree/.test(ruleId))              r = extractMineralTree_(text);
  else                                               r = extractGenericBody_(text);
  if (!r) r = extractGenericBody_(text);

  // SVB payment with an invoice RANGE (not individually specified) is skipped per policy.
  if (r && r.isRange) {
    return { ok: false, skip: true, reason: 'SVB payment lists an invoice range, not individual invoices — skipped per policy' };
  }

  if (!r || !r.amount) {
    return { ok: false, reason: 'Amount not found in body — needs human review' };
  }
  // Invoice numbers are best-effort, not required — confirmed structurally absent from
  // plain text for some BILL/Zip templates (the numbers exist only in an HTML table).
  // Payor + amount are already strictly gated (SHORT_NAMES/junk check, mismatch guard,
  // amount bounds), so an empty invoice list no longer blocks saving.
  const invoices = r.invoices && r.invoices.length ? r.invoices : findInvoices_(text);

  // Payor QA: if the extractor produced a junk/fragment payor (e.g. a marketing
  // subject tail like "... is on the way - get paid instantly"), try to recover a
  // known payor from the text; otherwise reject so it goes to review, not a file.
  let payor = (r.payor || '').trim();
  if (!payor || looksLikePayorJunk_(payor)) {
    const known = bestPayorFromText_(text);
    payor = known || ((v.shortName && !looksLikePayorJunk_(v.shortName)) ? v.shortName : '');
  }
  if (!payor) return { ok: false, reason: 'Payor not identified - needs human review' };

  const sn = shortName_(payor, v.shortName);
  if (!sn || looksLikePayorJunk_(sn)) {
    return { ok: false, reason: 'Payor short name could not be resolved (avoid bad filename) - needs human review' };
  }

  // Mismatch guard: if the extracted payor is a well-known SHORT_NAMES entity but their
  // name doesn't appear anywhere in the subject OR the attachment text, the extraction
  // is almost certainly wrong (threaded body contamination). Flag rather than file.
  //
  // Scope: only for rules broad enough to actually collide across payors. The guard's
  // original purpose was catching a self-referential local rule that hijacked every
  // email in the inbox (fixed permanently at load time in loadRules_ — see the
  // OWN_DOMAIN guard there). That class of bug can no longer occur. For a DEDICATED
  // single-payor rule (subject/sender pattern unique to that one vendor, e.g.
  // regeneron-body, merck-body), the rule match itself is already strong evidence —
  // additionally requiring the name to be re-found in body/attachment text only
  // punishes correct extractions when body/attachment access is flaky, with no
  // remaining upside. Keep the strict check for the two rules proven broad enough to
  // genuinely collide, and for the true no-rule-matched fallback.
  const BROAD_COLLISION_PRONE_RULES = { 'payment-advice-note': 1, 'remittance-advice-attachment': 1 };
  const ruleIdForGuard = (v && v.ruleObj && v.ruleObj.id) || '';
  const guardApplies = !ruleIdForGuard || BROAD_COLLISION_PRONE_RULES[ruleIdForGuard];
  const snLower = sn.toLowerCase();
  const subjectLower = subject.toLowerCase();
  const knownPayors = SHORT_NAMES.map(function(e){ return e[1].toLowerCase(); });
  if (guardApplies && knownPayors.indexOf(snLower) >= 0) {
    const payorInSubject = sn.split(' ').some(function(w){
      return w.length > 3 && subjectLower.indexOf(w.toLowerCase()) >= 0;
    });
    // Also check attachment text and the plain BODY — a Merck/Regeneron-style email with
    // no company name in the subject and no PDF attachment can still be a 100% correct
    // extraction if the payor's name is right there in the body itself.
    const attTextLower = attText.toLowerCase();
    const bodyLower = body.toLowerCase();
    const payorInAtt = (attTextLower || bodyLower) && sn.split(' ').some(function(w){
      const lw = w.toLowerCase();
      return w.length > 3 && (attTextLower.indexOf(lw) >= 0 || bodyLower.indexOf(lw) >= 0);
    });
    if (!payorInSubject && !payorInAtt) {
      return { ok: false, reason: 'Payor mismatch: extracted "' + sn + '" but "' + sn + '" does not appear in the subject or attachment — likely threading contamination, needs human review' };
    }
  }

  return {
    ok: true,
    payor: payor,
    shortName: sn,
    amount: r.amount,
    currency: r.currency || detectCurrency_(text),
    invoices: invoices,
    note: r.note || '',
  };
}

/** BILL.com — the four body formats. */
function extractBill_(subject, body) {
  const text = subject + '\n' + body;

  // SUBJECT-FIRST for "Your payment from X will be deposited today" — payor is
  // unambiguous in the subject. Check before touching body, which may contain
  // threaded HTML from prior emails with different customers.
  let m = subject.match(/payment from\s+(.+?)\s+(?:will be deposited|is on the way|is delayed)/i);
  if (m) {
    // Try body first; fall back to full text (which may include HTML parts) for amount.
    // Payor always comes from subject — immune to body contamination.
    const amt = firstAmount_(body) || firstAmount_(text);
    if (amt) return { payor: m[1], amount: amt, invoices: findInvoices_(text) };
  }

  // "Ansa Biotechnologies, Inc. Sent a payment of 1772.25" (no $)
  m = body.match(/([^\r\n]{2,90}?)\s+Sent a payment of\s+\$?([\d,]+\.\d{2})/i);
  if (m) return { payor: m[1], amount: toNum_(m[2]), invoices: findInvoices_(text) };
  // "Vedana Therapeutics, Inc. initiated a payment of $584977.80"
  m = body.match(/([^\r\n]{2,90}?)\s+initiated a payment of\s+\$([\d,]+\.\d{2})/i);
  if (m) return { payor: m[1], amount: toNum_(m[2]), invoices: findInvoices_(text) };
  // "X sent you a payment arriving Jul 22"
  m = subject.match(/^(.+?)\s+sent you a payment arriving/i);
  if (m) {
    const amt = firstAmount_(body);
    if (amt) return { payor: m[1], amount: amt, invoices: findInvoices_(text) };
  }
  // "X sent you a payment of $366.48" (BILL variant that includes "you")
  m = subject.match(/^(.+?)\s+sent you a payment of\s+\$?([\d,]+\.\d{2})/i)
     || body.match(/([^\r\n]{2,90}?)\s+sent you a payment of\s+\$?([\d,]+\.\d{2})/i);
  if (m) return { payor: m[1], amount: toNum_(m[2]), invoices: findInvoices_(text) };
  // "X paid you USD 10,500.00" / "X paid you $10,500.00" (e.g. "Payment should have arrived: X paid you ...")
  m = text.match(/([A-Z][A-Za-z0-9&.,'\-\u2019 ]+?)\s+paid you\s+(?:([A-Z]{3})\s+)?\$?([\d,]+\.\d{2})/);
  if (m) return { payor: m[1], amount: toNum_(m[3]), currency: (m[2] || 'USD'), invoices: findInvoices_(text) };
  return null;
}

/** Ramp — payor + invoice from the body line "X sent payment for INV"; amount from the labeled field. */
function extractRamp_(subject, body) {
  const text = subject + '\n' + body;
  let payor = null, invoices = [];

  // P3 FIRST: Subject "Payment received: RI-x from Y" — payor is unambiguous in the
  // subject line. Check this before touching the body, because msg.getBody() returns
  // threaded HTML which can contain earlier messages from different customers, causing
  // P1 below to pick up the wrong company name.
  let m = subject.match(/Payment received:\s*((?:RI|CN)-\d+)\s+from\s+(.+)$/i);
  if (m) {
    invoices = [m[1].toUpperCase()]; payor = m[2].trim();
    // Get amount from text (body or HTML parts) — payor already locked from subject
    const amt3 = firstAmount_(body) || firstAmount_(text);
    if (amt3 && payor) return { payor, amount: amt3, currency: 'USD', invoices };
  }

  // P3b: Subject "Payment initiated for N bills to Y from X" (batch)
  if (!payor) {
    m = subject.match(/Payment initiated for .+? from\s+(.+)$/i);
    if (m) payor = m[1].trim();
  }

  if (!payor) {
    // Body H1: "Arda Therapeutics, Inc. sent payment for RI-0000154773"
    m = body.match(/^(.+?)\s+sent payment for\s+((?:RI|CN)-\d+)/im);
    if (m) { payor = m[1].trim(); invoices = [m[2].toUpperCase()]; }
  }

  // Fallbacks that still avoid the marketing subject tail:
  if (!payor) {
    m = body.match(/Someone at\s+(.+?)\s+is attempting to complete a payment/i);
    if (m) payor = m[1].trim();
  }

  // Subject "Payment from X is on the way / will be deposited" - capture X, drop the tail.
  if (!payor) {
    m = subject.match(/Payment from\s+(.+?)\s+(?:is on the way|will be deposited|is delayed|sent you)/i);
    if (m) payor = m[1].trim();
  }

  // Amount: prefer the labeled "Payment amount" field; never the marketing "1.0% fee" line.
  let amt = null;
  m = body.match(/Payment amount[^\n]*\n?\s*\$?([\d,]+\.\d{2})/i);
  if (m) amt = toNum_(m[1]);
  if (!amt) { m = body.match(/Invoice total\s*\n?\s*\$([\d,]+\.\d{2})/i); if (m) amt = toNum_(m[1]); }
  if (!amt) amt = firstAmount_(body);

  if (!payor || !amt) return null;
  if (!invoices.length) invoices = findInvoices_(text);
  // Strip any accidental marketing tail that slipped in via an em dash.
  payor = payor.replace(/\s+(is on the way|—.*|-\s*get paid.*)$/i, '').trim();
  return { payor: payor, amount: amt, invoices: invoices };
}

/** Brex notification: "PAYOR sent you a payment of $AMOUNT" — payor comes from the
 *  subject line; amount/invoice from the short body ("Amount: $x", "Description: Invoice RI-..."). */
function extractBrex_(subject, body) {
  const text = subject + '\n' + body;
  let payor = null, amount = null;

  let m = subject.match(/^(.+?)\s+sent you a payment of\s*\$?\s*([\d,]+\.\d{2})/i);
  if (m) { payor = m[1].trim(); amount = toNum_(m[2]); }

  if (!payor) { m = body.match(/^(.+?)\s+sent you a payment of/im); if (m) payor = m[1].trim(); }
  if (!amount) { m = body.match(/Amount:\s*\*{0,2}\s*\$?\s*([\d,]+\.\d{2})/i); if (m) amount = toNum_(m[1]); }
  if (!amount) amount = firstAmount_(body);

  if (!payor || !amount) return null;
  return { payor: payor, amount: amount, invoices: findInvoices_(text) };
}

/** Merck — Payor Name / Payment Amount fields; three entities → Merck. */
function extractMerck_(text) {
  const pm = text.match(/Payor Name:\s*([^\r\n]+)/i);
  let amount = null;
  let m = text.match(/Payment Amount[:\s]*\$?\s*([\d,]+\.\d{2})/i);
  if (m) amount = toNum_(m[1]);
  // The columnar "PAYMENT REMITTANCE DETAIL" body has no "Payment Amount" label; the
  // remitted total sits in the "Payment#" row (and is the largest USD figure) — never
  // the first invoice line item, which the old fallback wrongly grabbed.
  if (!amount) { m = text.match(/Payment#[\s\S]{0,150}?([\d,]+\.\d{2})\s*USD/i); if (m) amount = toNum_(m[1]); }
  if (!amount) {
    var nums = (text.match(/([\d,]+\.\d{2})\s*USD/gi) || []).map(function(s){ return toNum_(s.replace(/\s*USD/i, '')); });
    if (nums.length) amount = Math.max.apply(null, nums);
  }
  if (!amount) return null;
  return {
    payor: pm ? pm[1].trim() : 'Merck',
    amount: amount,
    currency: 'USD',
    invoices: findInvoices_(text),
  };
}

/** Coupa portal — "X has sent you a 174,333.91 USD payment" (subject). */
function extractCoupa_(subject, body, ruleId) {
  const text = subject + '\n' + body;
  let m = text.match(/(.+?)\s+has sent you a\s+([\d,]+\.\d{2})\s+(USD|GBP|EUR)\s+payment/i);
  if (!m) return null;
  let payor = m[1].replace(/^.*?(?=[A-Z])/, '').trim();
  if (ruleId === 'neurocrine-body' || /neurocrine/i.test(text)) payor = 'Neurocrine';
  return { payor: payor, amount: toNum_(m[2]), currency: m[3], invoices: findInvoices_(text) };
}

/** Zip payment notifications — "Payment should have arrived: X paid you USD Y"
 *  or "Payment initiated: X paid you USD Y" — payor and amount in subject. */
function extractZip_(subject, body) {
  const text = subject + '\n' + body;
  const m = subject.match(/Payment (?:should have arrived|initiated):\s*(.+?)\s+paid you\s+(?:[A-Z]{3}\s*)?([\d,]+\.\d{2})/i);
  if (!m) return null;
  const payor = m[1].trim();
  const amount = toNum_(m[2]);
  const cm = subject.match(/Payment (?:should have arrived|initiated):.+paid you\s+([A-Z]{3})\s*[\d,]+\.\d{2}/i);
  const currency = cm ? cm[1] : 'USD';
  return { payor, amount, currency, invoices: findInvoices_(text) };
}

/** MineralTree "Account remittance detail for your payment" (Land Therapeutics, Senti
 *  Biosciences, and other MineralTree-paying customers). Payor sits in "Your payment from
 *  X has been processed"; the remitted total is the ACH amount (the largest 2-decimal
 *  figure — line items and 0.00 discount/amount-due columns are always smaller). Invoices
 *  are RI-numbers in the detail table. */
function extractMineralTree_(text) {
  var pm = text.match(/payment from\s+(.+?)\s+has been processed/i);
  var payor = pm ? pm[1].replace(/,?\s*(?:inc|llc|ltd|corp|corporation|company|co)\.?\s*$/i, '').trim() : '';
  var amount = null;
  var m = text.match(/ACH\s*Amount\s*(?:USD)?\s*\$?\s*([\d,]+\.\d{2})/i);
  if (m) amount = toNum_(m[1]);
  if (!amount) {
    var nums = (text.match(/([\d,]+\.\d{2})/g) || []).map(toNum_).filter(function (n) { return n > 0; });
    if (nums.length) amount = Math.max.apply(null, nums);
  }
  if (!amount) return null;
  var cur = (text.match(/ACH\s*Amount\s*([A-Z]{3})/i) || [])[1] || 'USD';
  return { payor: payor || 'MineralTree', amount: amount, currency: cur, invoices: findInvoices_(text) };
}

/** Generic remittance-advice body (Regeneron, VIR/FISPAN, SVB-style layouts). */
/**
 * Regeneron "Payment Remittance Advice" (arrives with subject "Separate Remittance Advice").
 * Payor follows "From Payer"; the payment total follows "Payment Amount" (no $ symbol, on the
 * next line - which defeated the generic amount finder); currency follows "Payment Currency";
 * clean RI-/CN- invoices sit in the Remittance Detail table.
 */
function extractAriba_(text) {
  // SAP/Ariba "You have a new scheduled payment" notice carries real data:
  // "$NN.NK by <Payor> ... Amount due $N,NNN.NN CUR ... Invoice number RI-XXXX".
  // (The other Ariba type — "Notice of new Remittance Advice" — has no amount/invoice,
  // only a login link, and is skipped by rule.)
  let payor = '';
  let m = text.match(/\bby\s+(.+?)\s+Amount due/i);
  if (m) payor = m[1].trim();
  let amount = null;
  m = text.match(/(?:Amount due|Original amount)\s*\$?\s*([\d,]+\.\d{2})/i);
  if (m) amount = toNum_(m[1]);
  if (!amount) {
    const all = (text.match(/[\d,]{1,12}\.\d{2}/g) || []).map(function (x) { return toNum_(x); }).filter(function (n) { return n > 0; });
    if (all.length) amount = Math.max.apply(null, all);
  }
  let currency = 'USD';
  m = text.match(/(?:Amount due|Original amount)\s*\$?\s*[\d,]+\.\d{2}\s*([A-Z]{3})/i);
  if (m) currency = m[1].toUpperCase();
  return { payor: payor || '', amount: amount, currency: currency, invoices: findInvoices_(text) };
}

function extractSVB_(text) {
  // SVB "Payment Notification" template: "made by X to Science Exchange ... Amount: N CUR
  // ... Note: Inv <invoices>". Per policy, only save when invoices are listed individually;
  // a range ("RI-a to RI-b") is not a usable reference and is skipped.
  let payor = '';
  let m = text.match(/made by\s+(.+?)\s+to\s+Science Exchange/i);
  if (m) payor = m[1].trim().replace(/[,.]\s*$/, '');
  let amount = null;
  m = text.match(/Amount:\s*\$?\s*([\d,]+\.\d{2})/i);
  if (m) amount = toNum_(m[1]);
  let currency = 'USD';
  m = text.match(/Amount:\s*\$?\s*[\d,]+\.\d{2}\s*([A-Z]{3})/i);
  if (m) currency = m[1].toUpperCase();
  const isRange = /(?:RI|CN)-?\d{5,}\s*(?:to|through|thru|–|—)\s*(?:RI|CN)-?\d{5,}/i.test(text);
  const invoices = isRange ? [] : findInvoices_(text);
  return { payor: payor || '', amount: amount, currency: currency, invoices: invoices, isRange: isRange };
}

function extractRegeneron_(text) {
  let payor = '';
  let m = text.match(/From Payer[\s:]*([A-Za-z][^\r\n]{1,70})/i);
  if (m) payor = m[1].trim();
  let amount = null;
  m = text.match(/Payment Amount[\s\S]{0,30}?([\d,]+\.\d{2})/i);
  if (m) amount = toNum_(m[1]);
  if (!amount) {
    // Fallback: the payment total is the largest 2-decimal figure in the advice.
    const all = (text.match(/[\d,]{1,12}\.\d{2}/g) || []).map(function (x) { return toNum_(x); }).filter(function (n) { return n > 0; });
    if (all.length) amount = Math.max.apply(null, all);
  }
  let currency = 'USD';
  m = text.match(/Payment Currency[\s:]*([A-Z]{3})/i);
  if (m) currency = m[1].toUpperCase();
  return { payor: payor || 'Regeneron', amount: amount, currency: currency, invoices: findInvoices_(text) };
}

function extractGenericBody_(text) {
  let payor = null;
  let m = text.match(/From Payer\s*[\r\n:]+\s*([^\r\n]+)/i) ||
          text.match(/Payer Name[:\s]+([^\r\n]+)/i) ||
          text.match(/Payor Name[:\s]+([^\r\n]+)/i) ||
          text.match(/([A-Z][^\r\n]{2,80}?)\s+has initiated a payment/i);
  if (m) payor = m[1].trim();

  let amount = null;
  m = text.match(/Payment Amount[:\s]*[£$€]?\s*([\d,]+\.\d{2})/i) ||
      text.match(/(?:^|\n)\s*AMOUNT[:\s]*[£$€]?\s*([\d,]+\.\d{2})/i) ||
      text.match(/payment (?:via ACH[^$£€\d]*)?(?:for:?|of)\s*[£$€]\s*([\d,]+\.\d{2})/i) ||
      text.match(/Total(?:\s+Amount)?[:\s]*[£$€]?\s*([\d,]+\.\d{2})/i);
  if (m) amount = toNum_(m[1]);

  if (!amount) return null;
  return { payor: payor, amount: amount, invoices: findInvoices_(text) };
}

// ---------------------- Track B: attachment ----------------------

function extractFromAttachment_(msg, v, att) {
  const name = att.getName() || 'attachment';
  const isHtml = /html/i.test(att.getContentType() || '') || /\.html?$/i.test(name);
  const fileExt = isHtml ? 'html' : 'pdf';

  let text = null, serviceMissing = false;
  if (isHtml) {
    try { text = stripHtml_(att.getDataAsString()); } catch (e) { text = null; }
  } else {
    const res = pdfText_(att);
    text = res.text;
    serviceMissing = res.serviceMissing;
  }

  if (!text) {
    return {
      ok: false,
      reason: serviceMissing
        ? 'PDF could not be read — enable the Drive API service (see setup notes at top of script)'
        : 'Could not read text out of the attachment — needs human review',
    };
  }

  const subjBody = (msg.getSubject() || '') + '\n' + safePlainBody_(msg);
  const full = text + '\n' + subjBody;

  // SVB attachment listing an invoice RANGE is skipped per policy (only individually-listed invoices are usable).
  const _rid = (v && v.ruleObj) ? (v.ruleObj.id || '') : '';
  if (/^svb/.test(_rid) && /(?:RI|CN)-?\d{5,}\s*(?:to|through|thru|–|—)\s*(?:RI|CN)-?\d{5,}/i.test(full)) {
    return { ok: false, skip: true, reason: 'SVB payment lists an invoice range, not individual invoices — skipped per policy' };
  }

  // Amount extraction, in priority order:
  //  1) An explicit "amount paid to vendor / total amount paid" total. BMS/E.R. Squibb
  //     print this with NO currency symbol and with the label far from the figure, so a
  //     generic first-$ grab would wrongly pick the first line-item amount.
  //  2) Other labeled totals (Payment/Net/Total ...).
  //  3) The largest currency-marked figure; or, if the doc prints bare amounts (BMS), the
  //     largest 2-decimal figure in the document.
  let amount = null, note = '';
  let m = text.match(/(?:Total\s+)?Amount\s+Paid(?:\s+to\s+Vendor)?[:\s]*[£$€]?\s*([\d,]+\.\d{2})/i);
  if (!m) m = text.match(/(?:Payment|Net|Total)\s*(?:amount|total|value|paid)?\s*[:\s]\s*[£$€]?\s*([\d,]+\.\d{2})/i);
  // SAP / Amgen / J&J advices print the grand total masked as "USD ********48,579.08*"
  // (currency word + asterisk padding), which the labeled patterns above skip over.
  if (!m) m = text.match(/(?:USD|GBP|EUR)\s*\*{2,}\s*([\d,]+\.\d{2})/i);
  if (m) amount = toNum_(m[1]);
  if (!amount) {
    let all = (text.match(/[£$€]\s*([\d,]+\.\d{2})/g) || [])
      .map(function (x) { return toNum_(x.replace(/[£$€\s]/g, '')); });
    if (!all.length) {
      all = (text.match(/\b[\d,]{1,12}\.\d{2}\b/g) || []).map(function (x) { return toNum_(x); });
    }
    if (all.length) {
      amount = Math.max.apply(null, all);
      note = 'Amount taken as largest figure in document — verify';
    }
  }
  if (!amount) return { ok: false, reason: 'Amount not found in attachment — needs human review' };

  // Payor - extraction-QA ladder (reject junk, then recover):
  //  1) a labeled "Payer/Payor Name" field, but ONLY if it isn't a table-header
  //     label like "Supplier Payee Name" (that exact bug produced bad filenames);
  //  2) otherwise, a known payor found anywhere in the document text (recovers
  //     Gilead, whose header layout defeats the labeled-field capture);
  //  3) otherwise the rule's short_name hint, if it's a real name.
  // If none yield a real payor, flag for review rather than write a bad file.
  let payor = '';
  m = text.match(/(?:Payer|Payor)\s*Name[:\s]+([^\r\n]+)/i) || text.match(/From Payer\s*[\r\n:]+\s*([^\r\n]+)/i);
  if (m && m[1].trim() && !looksLikePayorJunk_(m[1])) payor = m[1].trim();
  if (!payor) { const known = bestPayorFromText_(text) || bestPayorFromText_(subjBody); if (known) payor = known; }
  if (!payor && v.shortName && !looksLikePayorJunk_(v.shortName)) payor = v.shortName;
  if (!payor) return { ok: false, reason: 'Payor not identified (only field labels found) - needs human review' };

  const snA = shortName_(payor, v.shortName);
  if (!snA || looksLikePayorJunk_(snA)) {
    return { ok: false, reason: 'Payor short name could not be resolved (avoid bad filename) - needs human review' };
  }
  return {
    ok: true,
    payor: payor,
    shortName: snA,
    amount: amount,
    currency: detectCurrency_(text) || detectCurrency_(subjBody) || 'USD',
    invoices: findInvoices_(full), // invoices optional for attachments — file itself is the record
    sourceBlob: att,
    fileExt: fileExt,
    note: note,
  };
}

/** PDF → text via a throwaway Google-Doc conversion (Drive advanced service). */
function pdfText_(blob) {
  if (typeof Drive === 'undefined') return { text: null, serviceMissing: true };
  let docId = null;
  try {
    const created = Drive.Files.create(
      { name: 'tmp-remit-extract', mimeType: 'application/vnd.google-apps.document' },
      blob.copyBlob(),
      { ocrLanguage: 'en', fields: 'id' }
    );
    docId = created.id;
    const text = DocumentApp.openById(docId).getBody().getText();
    return { text: text, serviceMissing: false };
  } catch (e) {
    return { text: null, serviceMissing: false };
  } finally {
    if (docId) { try { DriveApp.getFileById(docId).setTrashed(true); } catch (e2) {} }
  }
}

// ------------------------ PDF generation ------------------------

/** Body-only emails become a clean, printable PDF via a throwaway Doc. */
function generateBodyPdf_(msg, ext, filename, staging) {
  const doc = DocumentApp.create('tmp — ' + filename);
  const body = doc.getBody();

  body.appendParagraph('Payment Remittance Advice')
    .setHeading(DocumentApp.ParagraphHeading.HEADING1);
  body.appendParagraph('Science Exchange, Inc. — AR Operations')
    .setFontSize(10).setForegroundColor('#666666');
  body.appendHorizontalRule();

  body.appendParagraph('Payment Amount').setBold(true).setFontSize(9).setForegroundColor('#444444');
  const amt = body.appendParagraph(
    money_(ext.amount) + (ext.currency !== 'USD' ? ' ' + ext.currency : '')
  );
  amt.setFontSize(22).setBold(true);

  const fields = [
    ['Payor', ext.payor],
    ['Currency', ext.currency],
    ['Email date', fmtDate_(msg.getDate())],
    ['Subject', msg.getSubject() || '—'],
    ['Source', 'remittances@ group — ' + (msg.getFrom() || '')],
    ['Message ID', msg.getId()],
    ['Processed', fmtDate_(new Date())],
  ];
  fields.forEach(function (f) {
    body.appendParagraph(f[0]).setBold(true).setFontSize(9).setForegroundColor('#444444');
    body.appendParagraph(String(f[1])).setBold(false).setFontSize(11);
  });

  if (ext.invoices.length) {
    body.appendParagraph('Invoices (' + ext.invoices.length + ')')
      .setBold(true).setFontSize(9).setForegroundColor('#444444');
    ext.invoices.forEach(function (inv) {
      body.appendListItem(inv).setGlyphType(DocumentApp.GlyphType.BULLET).setFontFamily('Courier New');
    });
  }

  body.appendHorizontalRule();
  body.appendParagraph('Generated by SE Remittance Agent · not a substitute for the original remittance document')
    .setFontSize(8).setForegroundColor('#999999');

  doc.saveAndClose();
  const pdfBlob = DriveApp.getFileById(doc.getId()).getAs('application/pdf').setName(filename);
  const file = staging.createFile(pdfBlob);
  try { DriveApp.getFileById(doc.getId()).setTrashed(true); } catch (e) {}
  return file;
}

// ==================== NAMING + DEDUPLICATION ====================

function buildFilename_(ext, fileExt) {
  const cur = ext.currency && ext.currency !== 'USD' ? ' ' + ext.currency : '';
  return '$' + money_(ext.amount) + ' ' + sanitize_(ext.shortName) + cur + '.' + (fileExt || 'pdf');
}

/**
 * Same filename + same invoices → true duplicate (skip).
 * Same filename + different invoices → _2, _3 …
 */
function resolveFilename_(savedSheet, base, invoices) {
  const key = invoices.slice().sort().join(',');
  const index = {}; // lower(filename) -> invoice key
  const last = savedSheet.getLastRow();
  if (last >= 2) {
    savedSheet.getRange(2, 2, last - 1, 4).getValues().forEach(function (r) {
      const fn = String(r[0] || '').toLowerCase();
      const inv = String(r[3] || '').split(/\s*,\s*/).filter(String).sort().join(',');
      if (fn) index[fn] = inv;
    });
  }
  let candidate = base, n = 1;
  while (index.hasOwnProperty(candidate.toLowerCase())) {
    if (index[candidate.toLowerCase()] === key && key !== '') {
      return { filename: candidate, duplicate: true };
    }
    n++;
    candidate = base.replace(/(\.[a-z0-9]+)$/i, '_' + n + '$1');
  }
  return { filename: candidate, duplicate: false };
}

// ====================== EXTRACTION HELPERS ======================

const SHORT_NAMES = [
  [/\bregeneron\b/i, 'Regeneron'],
  [/\bsyngenta\b/i, 'Syngenta'],
  [/glaxosmithkline|(^|\W)gsk(\W|$)/i, 'GSK'],
  [/bristol[- ]?myers|(^|\W)bms(\W|$)/i, 'BMS'],
  [/mrl san francisco|merck sharp|merck research|(^|\W)merck(\W|$)/i, 'Merck'],
  [/neuralink/i, 'Neuralink'],
  [/reckitt/i, 'Reckitt'],
  [/\bipsen\b/i, 'Ipsen'],
  [/insitro/i, 'Insitro'],
  [/rainwater/i, 'Rainwater Charitable Foundation'],
  [/deerfield/i, 'Deerfield'],
  [/gilead/i, 'Gilead Sciences'],
  [/takeda/i, 'Takeda'],
  [/abbvie/i, 'AbbVie'],
  [/neurocrine/i, 'Neurocrine'],
  [/terray/i, 'Terray Therapeutics'],
  [/ais operating/i, 'AIS Operating'],
  [/vertex/i, 'Vertex'],
  [/weatherwax/i, 'Weatherwax Biotechnologies'],
  [/vir biotechnology/i, 'VIR Biotechnology'],
  [/recursion/i, 'Recursion'],
  [/haleon/i, 'GSK'],
  [/amgen/i, 'Amgen'],
  [/janssen|johnson\s*&\s*johnson/i, 'Janssen Research'],
  [/incyte/i, 'Incyte'],
];

/**
 * Extraction-QA helper: is this "payor" actually a table-header label, a document
 * field name, a notification subject fragment, or a rule id — i.e. never a real
 * payor? Used to reject bad captures (the "Supplier Payee Name" class of bug).
 */
function looksLikePayorJunk_(name) {
  const n = (name || '').trim().toLowerCase();
  if (!n || n.length < 2) return true;
  const labels = [
    'supplier', 'payee name', 'supplier payee name', 'bank name', 'bank number',
    'branch number', 'bank bic code', 'bank account', 'payment reference number',
    'payment date', 'payment currency', 'payment amount', 'remittance details',
    'remittance message', 'remittance advice', 'payment remittance advice',
    'invoice number', 'gross amount', 'amount paid', 'total amount', 'payer name',
    'payor name', 'from payer', 'description', 'purchase order', 'page'
  ];
  if (labels.indexOf(n) !== -1) return true;
  // Unambiguous label substrings (no real payor contains these).
  if (/(payee name|supplier payee|remittance advice|payment reference|bank bic|branch number)/.test(n)) return true;
  // Notification subject fragments that leaked in as a payor.
  if (/(is on the way|get paid instantly|will be deposited|deposited today|sent you a payment|has sent you|payment arriving|on its way)/.test(n)) return true;
  // Rule-id-looking tokens ("extract_from_body", "bill-arriving", ...).
  if (/[_-]/.test(n) && /^[a-z0-9_ -]+$/.test(n) && /(extract|from_pdf|from_body|attachment|skip|flag|arriving|received|body)/.test(n)) return true;
  return false;
}

/**
 * Extraction-QA helper: scan arbitrary document/subject text for a KNOWN payor
 * (from SHORT_NAMES) and return its canonical short name. This is the recovery
 * step that fixes payors whose position in the document defeats field capture
 * (e.g. Gilead's two-column header). Returns null if no known payor is present.
 */
function bestPayorFromText_(text) {
  const t = text || '';
  for (let i = 0; i < SHORT_NAMES.length; i++) {
    if (SHORT_NAMES[i][0].test(t)) return SHORT_NAMES[i][1];
  }
  return null;
}

/**
 * Extraction-QA gate: the final data-quality checkpoint before anything is written.
 * Rejects a result whose payor is a label/fragment, whose amount is missing or out
 * of sane bounds, or (for body emails) that has no invoice numbers. A rejection
 * sends the email to Review — it never writes a bad file or log row.
 */
function validateExtraction_(ext, allowNoInvoices) {
  if (!ext || !ext.ok) return { ok: false, reason: (ext && ext.reason) || 'extraction failed' };
  if (looksLikePayorJunk_(ext.shortName) || looksLikePayorJunk_(ext.payor)) {
    return { ok: false, reason: 'Payor looks like a field label/fragment ("' + (ext.shortName || ext.payor) + '") - needs review' };
  }
  if (ext.amount == null || !(ext.amount > 0)) return { ok: false, reason: 'Amount missing or invalid - needs review' };
  if (ext.amount < CONFIG.AMOUNT_MIN || ext.amount > CONFIG.AMOUNT_MAX) return { ok: false, reason: 'Amount outside sane bounds - needs review' };
  if (!allowNoInvoices && (!ext.invoices || !ext.invoices.length)) return { ok: false, reason: 'No invoice numbers found - needs review' };
  return { ok: true };
}

function shortName_(payor, ruleHint) {
  const p = (payor || '').trim();
  if (p) {
    for (let i = 0; i < SHORT_NAMES.length; i++) {
      if (SHORT_NAMES[i][0].test(p)) return SHORT_NAMES[i][1];
    }
    // Strip corporate suffixes: "Ansa Biotechnologies, Inc." -> "Ansa Biotechnologies"
    let s = p;
    for (let g = 0; g < 3; g++) {
      s = s.replace(/[,\s]+(Inc\.?|LLC\.?|Ltd\.?|Limited|Incorporated|Corp\.?|Corporation|Co\.)\s*$/i, '');
    }
    s = s.trim();
    if (s) return s;
  }
  // Only fall back to the rule hint if it is a REAL short name, never a rule id.
  // Rule ids look like "bill-arriving", "extract_from_body", "merck-body" (contain - or _
  // with lowercase-only words). Reject those so we never name a file after a rule.
  const hint = (ruleHint || '').trim();
  const looksLikeRuleId = /[_-]/.test(hint) && /^[a-z0-9_-]+$/.test(hint);
  if (hint && !looksLikeRuleId) return hint;
  return ''; // caller will flag for review rather than write a bad filename
}

function findInvoices_(text) {
  const seen = {};
  const out = [];
  // Normalize a space right after the dash (PDF extraction sometimes yields "RI- 0000154139").
  const norm = String(text).replace(/\b(RI|CN)-\s+(\d)/gi, '$1-$2');
  // Canonical SE format: RI-/CN- + EXACTLY 10 digits. Taking exactly 10 (with no trailing
  // boundary requirement) is precisely what lets us stop cleanly at a glued date in Coupa
  // tables (RI-000015304328/05/2026 -> RI-0000153043) while still matching clean invoices.
  const re = /\b(RI|CN)-?(\d{10})/gi;
  let m;
  while ((m = re.exec(norm)) !== null) {
    const inv = (m[1] + '-' + m[2]).toUpperCase();  // normalize: RI0000150836 -> RI-0000150836
    if (!seen[inv]) { seen[inv] = true; out.push(inv); }
  }
  // Fallback for non-10-digit variants (older/edge formats): require a real boundary after
  // so we never swallow an adjacent date.
  if (!out.length) {
    const re2 = /\b((?:RI|CN)-\d{5,12})\b/gi;
    while ((m = re2.exec(norm)) !== null) {
      const inv = m[1].toUpperCase();
      if (!seen[inv]) { seen[inv] = true; out.push(inv); }
    }
  }
  return out;
}

function detectCurrency_(text) {
  if (/£|\bGBP\b/.test(text)) return 'GBP';
  if (/€|\bEUR\b/.test(text)) return 'EUR';
  if (/\$|\bUSD\b/.test(text)) return 'USD';
  return null;
}

function firstAmount_(text) {
  let m = text.match(/\$\s*([\d,]+\.\d{2})/);
  if (m) return toNum_(m[1]);
  m = text.match(/(?:payment of|amount[:\s]+)\s*\$?\s*([\d,]+\.\d{2})/i);
  if (m) return toNum_(m[1]);
  // Last resort: some remittance PDFs (OCR'd via Drive) render the total with neither a
  // $ sign nor a recognizable label — e.g. "USD 1,234.56" or a bare total on its own line.
  // Remittance totals are conventionally the LARGEST properly-formatted figure on the page
  // (line items are always smaller), so take the max rather than the first match — the
  // same heuristic already used for MineralTree/Regeneron-style layouts.
  const nums = (text.match(/\b[\d,]{1,12}\.\d{2}\b/g) || [])
    .map(toNum_).filter(function (n) { return n > 0 && isFinite(n); });
  return nums.length ? Math.max.apply(null, nums) : null;
}

function toNum_(s) { return parseFloat(String(s).replace(/,/g, '')); }

function money_(n) {
  const p = Number(n).toFixed(2).split('.');
  return p[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',') + '.' + p[1];
}

function sanitize_(s) {
  return String(s).replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, ' ').trim();
}

function fetchAllHtmlParts_(msg) {
  // Pull HTML out of the FULL raw MIME message. Senders like Regeneron deliver the payment
  // advice as an HTML attachment that GmailApp.getAttachments() won't surface, but
  // getRawContent() contains every part. Uses the Gmail scope the app already has.
  try {
    const raw = msg.getRawContent();
    if (!raw) return '';
    let out = '';
    // Split on MIME boundary delimiter lines (--boundary).
    const chunks = raw.split(/\r?\n--[^\r\n]+\r?\n/);
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      if (!/content-type:\s*text\/html/i.test(chunk)) continue;
      const m = chunk.match(/\r?\n\r?\n([\s\S]*)$/);
      if (!m) continue;
      let part = m[1];
      const enc = ((chunk.match(/content-transfer-encoding:\s*([^\r\n;]+)/i) || [null, ''])[1] || '').toLowerCase().trim();
      if (enc === 'base64') {
        try { part = Utilities.newBlob(Utilities.base64Decode(part.replace(/[^A-Za-z0-9+/=]/g, ''))).getDataAsString(); } catch (e) {}
      } else if (enc === 'quoted-printable') {
        part = part.replace(/=\r?\n/g, '').replace(/=([0-9A-Fa-f]{2})/g, function (_, h) { return String.fromCharCode(parseInt(h, 16)); });
      }
      out += '\n' + part;
    }
    return out;
  } catch (e) { return ''; }
}

function stripHtml_(html) {
  return String(html)
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|td|th|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&#39;|&rsquo;/gi, "'")
    .replace(/[ \t]+/g, ' ');
}

function safePlainBody_(msg) {
  try { return msg.getPlainBody() || ''; } catch (e) { return ''; }
}

// ============================ RULES =============================

function loadRules_() {
  const props = PropertiesService.getScriptProperties();
  const token = props.getProperty('GITHUB_TOKEN'); // only if the repo goes private
  const options = { muteHttpExceptions: true, headers: {} };
  if (token) options.headers.Authorization = 'Bearer ' + token;

  let parsed = null, source = '';
  try {
    const resp = UrlFetchApp.fetch(CONFIG.RULES_URL, options);
    if (resp.getResponseCode() === 200) {
      const text = resp.getContentText();
      parsed = JSON.parse(text);
      source = 'GitHub (live)';
      // Cache the full rules for the GitHub-down fallback. CacheService holds up to
      // 100KB per key (6h TTL), so it keeps working as rules.json grows past the
      // 9KB Script-Property ceiling. Keep a Property copy too when it still fits,
      // as a longer-lived backup that survives cache expiry.
      try { CacheService.getScriptCache().put('RULES_CACHE_V2', text, 21600); } catch (e2) {}
      try { if (text.length < 9000) props.setProperty('RULES_CACHE', text); } catch (e3) {}
    }
  } catch (e) { /* fall through to cache */ }

  if (!parsed) {
    let cached = null;
    try { cached = CacheService.getScriptCache().get('RULES_CACHE_V2'); } catch (e4) {}
    if (!cached) cached = props.getProperty('RULES_CACHE');
    if (cached) { parsed = JSON.parse(cached); source = 'cached copy (GitHub unreachable)'; }
  }
  if (!parsed || !Array.isArray(parsed.rules)) {
    throw new Error('Could not load rules.json from GitHub and no cached copy exists yet.');
  }
  // Layer UI-created local overrides ON TOP (higher priority) so a rule made in the
  // Review page classifies the very next run, without needing a GitHub push.
  let localList = [];
  try {
    const localRaw = props.getProperty('LOCAL_RULES');
    if (localRaw) localList = JSON.parse(localRaw) || [];
  } catch (e) { localList = []; }

  // GUARD — drop self-referential local rules.
  // Mail reaches us via the remittances@ group, so msg.getFrom() is often OUR OWN
  // domain. A local rule built from that signal matches EVERY email and force-
  // overrides both the action and the payor short name for the whole inbox.
  // Such a rule can never be legitimate: our own domain is the payee, not a payor.
  const OWN_DOMAIN = String(CONFIG.GROUP || 'remittances@scienceexchange.com')
                       .split('@').pop().toLowerCase();
  // Local rules are a TEMPORARY fallback for when the GitHub write fails. They are only
  // reconciled away if an identical rule later lands in GitHub — which may never happen.
  // Expire them after 7 days so nothing can silently override the shared rules forever.
  const LOCAL_TTL_MS = 7 * 24 * 60 * 60 * 1000;
  const nowMs = Date.now();
  const droppedLocal = [];
  localList = localList.filter(function (r) {
    if (!r || !r.match) { droppedLocal.push((r && r.id) || '(malformed)'); return false; }
    // Expired, or undated (legacy — predates created-stamping, the class that caused the
    // inbox-wide payor hijack). Either way it must not outlive the shared rules.
    const createdMs = r.created ? Date.parse(r.created) : NaN;
    if (!isFinite(createdMs) || (nowMs - createdMs) > LOCAL_TTL_MS) {
      droppedLocal.push((r.id || '(unnamed)') + (isFinite(createdMs) ? ' [expired]' : ' [undated]'));
      return false;
    }
    const froms = r.match.from_contains || [];
    const subjs = r.match.subject_contains || [];
    const snips = r.match.snippet_contains || [];
    // bare domain fragment (no mailbox) that our own domain contains => matches everything
    const selfMatching = froms.some(function (f) {
      const v = String(f || '').toLowerCase().trim();
      return v && v.indexOf('@') === -1 && OWN_DOMAIN.indexOf(v) !== -1;
    });
    const noCriteria = !froms.length && !subjs.length && !snips.length;
    if (selfMatching || noCriteria) { droppedLocal.push(r.id || '(unnamed)'); return false; }
    return true;
  });
  if (droppedLocal.length) {
    try { props.setProperty('DROPPED_LOCAL_RULES',
      droppedLocal.join(', ').slice(0, 900)); } catch (e5) {}
  }

  const combined = localList.concat(parsed.rules);
  return { list: combined, version: parsed.version || '?', source: source,
           localCount: localList.length, droppedLocal: droppedLocal.length };
}

// ==================== LOG SHEET + STAGING =======================

const MESSAGE_HEADERS = [
  'Logged at', 'Email date', 'Found in', 'From', 'Subject', 'PDF attached',
  'Verdict', 'Rule matched', 'Payor short name', 'Outcome', 'Note',
  'Message ID', 'Open in Gmail', 'Amount', 'Currency', 'Invoices', 'Filename', 'File link',
];
const RUN_HEADERS = [
  'Run at', 'In window', 'New logged', 'Rules loaded', 'Rules version', 'Rules source', 'Error', 'Outcomes',
];
const SAVED_HEADERS = [
  'Saved at', 'Filename', 'Amount', 'Currency', 'Invoices', 'Payor', 'Subject', 'Message ID', 'File link',
];

function getLog_() {
  const props = PropertiesService.getScriptProperties();
  let ss = null;
  const id = props.getProperty('LOG_SPREADSHEET_ID');
  if (id) { try { ss = SpreadsheetApp.openById(id); } catch (e) { ss = null; } }

  if (!ss) {
    ss = SpreadsheetApp.create(CONFIG.LOG_FILE_NAME);
    props.setProperty('LOG_SPREADSHEET_ID', ss.getId());
    ss.getSheets()[0].setName('Messages');
  }

  const messages = ensureSheet_(ss, 'Messages', MESSAGE_HEADERS);
  const runs = ensureSheet_(ss, 'Runs', RUN_HEADERS);
  const saved = ensureSheet_(ss, 'Saved', SAVED_HEADERS);
  return { ss: ss, url: ss.getUrl(), messages: messages, runs: runs, saved: saved };
}

/** Creates the tab if missing; upgrades the header row in place if short. */
function ensureSheet_(ss, name, headers) {
  let sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  sheet.setFrozenRows(1);
  return sheet;
}

function getStagingFolder_() {
  // The agent now writes DIRECTLY to the live "remits not applied" folder.
  // (Staging was removed — files are reference docs for payments already in the
  // accounting system, and every write is verified by validateSavedFile_ below.)
  return DriveApp.getFolderById(CONFIG.LIVE_FOLDER_ID);
}

/**
 * Rigorous post-write validation. Confirms the file we just wrote actually exists,
 * is in the live destination folder, is a non-empty PDF, and carries the intended
 * name. Returns { ok, checks, reason }. Only if this passes do we log "saved".
 */
function validateSavedFile_(fileId, intendedName) {
  const checks = { exists: false, inLiveFolder: false, nonEmpty: false, isPdf: false, nameMatches: false };
  try {
    const f = DriveApp.getFileById(fileId); // (1) read back by ID — proves it exists
    checks.exists = true;

    // (2) parent must be the live destination folder
    const parents = f.getParents();
    while (parents.hasNext()) {
      if (parents.next().getId() === CONFIG.LIVE_FOLDER_ID) { checks.inLiveFolder = true; break; }
    }
    // (3) non-empty
    checks.nonEmpty = f.getSize() > 0;
    // (4) is a PDF (by mime or extension)
    const mime = f.getMimeType() || '';
    checks.isPdf = /pdf/i.test(mime) || /\.pdf$/i.test(f.getName() || '');
    // (5) filename matches what we intended to write
    checks.nameMatches = f.getName() === intendedName;
  } catch (e) {
    return { ok: false, checks: checks, reason: 'read-back failed: ' + e };
  }
  const ok = checks.exists && checks.inLiveFolder && checks.nonEmpty && checks.isPdf && checks.nameMatches;
  let reason = '';
  if (!ok) {
    const failed = Object.keys(checks).filter(function (k) { return !checks[k]; });
    reason = 'validation failed: ' + failed.join(', ');
  }
  return { ok: ok, checks: checks, reason: reason };
}

/** Message IDs already logged (column 12) — keeps every run append-only. */
function getLoggedIds_(sheet) {
  const seen = new Set();
  const last = sheet.getLastRow();
  if (last >= 2) {
    // Col 10=Outcome, Col 11=Note (contains "[rules:X.Y.Z]"), Col 12=Message ID
    const rows = sheet.getRange(2, 10, last - 1, 3).getValues();

    // Current rules version. Use 'INIT' as sentinel so old untagged entries ('0') 
    // never accidentally match and get permanently locked out.
    let currentRulesVer = 'INIT';
    try {
      const stored = PropertiesService.getScriptProperties().getProperty('LAST_RULES_VERSION');
      if (stored) currentRulesVer = stored;
    } catch(e) {}

    // Permanent outcomes — message is fully handled, never retry.
    // SAVED = real attachment PDF in Drive. SKIPPED = intentional. DUPLICATE = dedup.
    // ALREADY PROCESSED = msgId dedup. ALREADY APPLIED = manual override.
    const PERMANENT = { SAVED: 1, SKIPPED: 1, DUPLICATE: 1, 'ALREADY PROCESSED': 1 };

    // Track per message: permanent flag, and what rules version it last flagged/generated under.
    const finalOutcome = new Set();
    const lastSoftVer  = {};  // msgId -> rules version of last FLAGGED or GENERATED entry

    rows.forEach(function (r) {
      const outcome = String(r[0] || '').trim().toUpperCase();
      const note    = String(r[1] || '');
      const msgId   = String(r[2] || '');
      if (!msgId) return;

      if (PERMANENT[outcome]) {
        finalOutcome.add(msgId);
      } else if (outcome === 'FLAGGED' || outcome === 'GENERATED') {
        // Soft outcome — version-aware retry. Extract [rules:X.Y.Z] from note.
        const vm = note.match(/\[rules:([\d.]+)\]/);
        lastSoftVer[msgId] = vm ? vm[1] : '0';  // '0' = pre-V67, will retry
      }
      // ALREADY PROCESSED, ERROR, empty — ignore (don't lock, don't track)
    });

    // Lock out permanent outcomes
    finalOutcome.forEach(function(id) { seen.add(id); });

    // Lock out soft outcomes only if they were under the CURRENT rules version.
    // If rules have changed since the flag/generate, allow one automatic retry.
    Object.keys(lastSoftVer).forEach(function(id) {
      if (!finalOutcome.has(id) && lastSoftVer[id] === currentRulesVer) {
        seen.add(id);
      }
    });
  }
  return seen;
}

// ============================ UTILS =============================

function fmtDate_(d) {
  return Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm');
}

