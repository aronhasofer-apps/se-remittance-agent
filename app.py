"""
SE Remittance Agent — Main Application v2.1.0
- Rules pulled from GitHub automatically on every launch
- Per-email action selector in preview (Process / Skip / Flag)
- Save attachment vs Extract from body based on rules
- No rebuild needed when rules change
"""

import sys, os, json, threading, webbrowser, time, urllib.request, re, base64
from http.server import HTTPServer, BaseHTTPRequestHandler
from datetime import datetime

if getattr(sys, "frozen", False):
    BASE_DIR = os.path.dirname(sys.executable)
else:
    BASE_DIR = os.path.dirname(os.path.abspath(__file__))

sys.path.insert(0, BASE_DIR)

from settings     import Settings
from history      import RunHistory, ReviewQueue
from engine       import (smart_extract, extract_ariba_meta,
                          build_filename, safe_filename, dedupe_filename,
                          generate_pdf, write_meta)
from gmail_client import GoogleClient
from updater      import sync_rules, check_update, classify_by_rules, APP_VERSION

SETTINGS    = Settings(BASE_DIR)
HISTORY     = RunHistory(os.path.dirname(SETTINGS.staging_path))
QUEUE       = ReviewQueue(os.path.dirname(SETTINGS.staging_path))
GOOGLE      = GoogleClient(BASE_DIR)
PORT        = 7823

_run_lock   = threading.Lock()
_run_log    = []
_run_status = "idle"
_rules      = []          # loaded from GitHub on startup
_update_info = None       # set if update available

# ── Load rules on startup ─────────────────────────────────────────────────────

def _load_rules():
    global _rules, _update_info
    data = sync_rules(BASE_DIR)
    _rules = data.get("rules", [])
    _update_info = check_update()

threading.Thread(target=_load_rules, daemon=True).start()

# ── Classification ────────────────────────────────────────────────────────────

def classify_email(email: dict) -> dict:
    """Returns classification dict with action, short_name, notes, rule_id."""
    result = classify_by_rules(email, _rules)
    # Map action to display track
    action = result["action"]
    if action == "save_attachment":
        result["track"] = "Save Attachment"
        result["track_code"] = "ATTACHMENT"
    elif action == "extract_body":
        result["track"] = "Extract from Body"
        result["track_code"] = "BODY"
    elif action == "skip":
        result["track"] = "Skip"
        result["track_code"] = "SKIP"
    else:
        result["track"] = "Flag for Review"
        result["track_code"] = "FLAG"
    return result

# ── Processing ────────────────────────────────────────────────────────────────

def _log(msg: str):
    _run_log.append(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}")

def process_email(email: dict, override_action: str = None) -> dict:
    subject   = email.get("subject", "(no subject)")
    sender    = email.get("sender", "")
    thread_id = email.get("threadId", "")

    classification = classify_email(email)
    action = override_action or classification["action"]
    short_name = classification.get("short_name", "")

    # ── Skip ──────────────────────────────────────────────────────────────────
    if action == "skip":
        _log(f"SKIPPED  {subject[:60]}")
        # Don't label Ariba portal emails — user needs to handle them manually
        rule_id = classification.get("rule_id", "")
        if rule_id != "ariba-skip":
            GOOGLE.add_label(thread_id, SETTINGS.agent_label, email.get("messageId"))
        return {"status": "skipped", "subject": subject, "reason": classification.get("description", "")}

    # ── Flag (explicit rule) ──────────────────────────────────────────────────
    if action == "flag":
        _log(f"FLAGGED  {subject[:60]}")
        GOOGLE.add_label(thread_id, SETTINGS.agent_label, email.get("messageId"))
        QUEUE.add({"threadId": thread_id, "subject": subject, "sender": sender,
                   "reason": classification.get("notes") or classification.get("description", ""),
                   "rule_id": classification.get("rule_id", "unknown")})
        return {"status": "flagged", "subject": subject}

    # ── Smart extraction: try attachment → try body → flag ────────────────────
    _log(f"Processing  {subject[:55]}")

    # Fetch body (always needed — used as fallback and for invoice extraction)
    body = GOOGLE.fetch_body(email.get("messageId", ""), email)


    # Fetch attachment if present
    pdf_bytes = None
    attachments = email.get("attachments", [])
    if attachments:
        _log(f"  → Downloading attachment...")
        pdf_bytes = GOOGLE.fetch_attachment(
            email.get("messageId", ""), attachments[0].get("attachmentId", ""))
        if not pdf_bytes:
            _log(f"  → Attachment download failed, trying body")

    # Smart extract: tries attachment first, falls back to body
    data, bytes_to_save, fail_reason = smart_extract(email, pdf_bytes, body, short_name)

    if not data:
        _log(f"  → Flagged: {fail_reason}")
        GOOGLE.add_label(thread_id, SETTINGS.agent_label, email.get("messageId"))
        QUEUE.add({"threadId": thread_id, "subject": subject, "sender": sender,
                   "reason": fail_reason, "rule_id": classification.get("rule_id", "")})
        return {"status": "queued", "subject": subject}

    # Apply rule short_name if extraction didn't identify payor
    if not data.get("payorShort") and short_name and short_name not in (
            "extract_from_subject", "extract_from_body", "extract_from_pdf"):
        data["payorShort"] = short_name

    return _save_file(email, data, bytes_to_save, "")


def _save_file(email: dict, data: dict, pdf_bytes, source: str) -> dict:
    thread_id = email.get("threadId", "")
    subject   = email.get("subject", "")
    t_start   = time.time()

    filename = safe_filename(build_filename(data))
    staging  = SETTINGS.staging_path
    os.makedirs(staging, exist_ok=True)
    filename, is_dupe = dedupe_filename(filename, staging, data.get("invoices", []))

    if is_dupe:
        _log(f"  → Duplicate — skipped")
        GOOGLE.add_label(thread_id, SETTINGS.agent_label, email.get("messageId"))
        return {"status": "skipped", "subject": subject, "reason": "duplicate"}

    out_path = os.path.join(staging, filename)

    if pdf_bytes:
        with open(out_path, "wb") as f:
            f.write(pdf_bytes)
    else:
        generate_pdf(out_path, data, email)

    write_meta(staging, filename, data, email)
    GOOGLE.add_label(thread_id, SETTINGS.agent_label, email.get("messageId"))

    if not SETTINGS.test_mode:
        # Copy directly to live path (Google Drive for Desktop local folder)
        live_path = SETTINGS.live_path
        if live_path and os.path.isdir(live_path):
            import shutil
            shutil.copy2(out_path, os.path.join(live_path, filename))
        else:
            _log(f"  ⚠ Live path not found: {live_path}")

    # Auto-resolve any review queue entries for this thread
    for i, item in enumerate(QUEUE.get_all()):
        if not item.get("resolved") and item.get("threadId") == thread_id:
            QUEUE.resolve(i)

    elapsed = round(time.time() - t_start, 1)
    _log(f"  → SAVED  {filename}  ({elapsed}s)")
    return {
        "status": "saved", "filename": filename,
        "amount": data.get("amount"), "payor": data.get("payorShort"),
        "invoices": data.get("invoices", []),
        "threadId": thread_id, "elapsed": elapsed,
    }


def run_processing(email_list: list):
    global _run_status, _run_log
    with _run_lock:
        _run_status = "running"
        _run_log    = []
        run_id      = HISTORY.start_run()
        saved, skipped, flagged, errors = [], [], [], []
        processed   = HISTORY.get_all_processed_thread_ids()

        _log(f"Run started — {len(email_list)} email(s)")
        _log(f"Rules loaded: {len(_rules)} rules from GitHub")
        if SETTINGS.test_mode:
            _log("TEST MODE — staging only, Drive untouched")

        for i, item in enumerate(email_list, 1):
            email  = item.get("email", item)
            override_action = item.get("override_action")
            tid    = email.get("threadId", "")
            subj   = email.get("subject", "")

            _log(f"[{i}/{len(email_list)}] ──────────────────────────────")
            try:
                r = process_email(email, override_action)
                status = r.get("status")
                if status == "saved":      saved.append(r)
                elif status == "skipped":  skipped.append(r)
                elif status in ("flagged","queued"): flagged.append(r)
                else:                      errors.append(r)
            except Exception as e:
                _log(f"  → ERROR: {e}")
                errors.append({"subject": subj, "error": str(e)})

        HISTORY.finish_run(run_id, saved, skipped, flagged, errors)
        _log(f"\n═══ Done — Saved:{len(saved)}  Skipped:{len(skipped)}  "
             f"Flagged:{len(flagged)}  Errors:{len(errors)} ═══")
        _run_status = "done"

# ── Dashboard HTML ────────────────────────────────────────────────────────────

DASHBOARD_HTML = r"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>SE Remittance Agent</title>
<style>
:root{--bg:#0f1117;--surface:#181c25;--border:#252a38;--accent:#3b82f6;--accent2:#1d4ed8;--green:#22c55e;--yellow:#eab308;--red:#ef4444;--text:#e2e8f0;--muted:#64748b;--mono:'Roboto Mono','Consolas',monospace;--sans:'Inter','Segoe UI',system-ui,sans-serif}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--text);font-family:var(--sans);font-size:14px;min-height:100vh}
.topbar{display:flex;align-items:center;gap:12px;padding:0 24px;height:52px;background:var(--surface);border-bottom:1px solid var(--border);position:sticky;top:0;z-index:100}
.topbar-brand{font-size:13px;font-weight:600;letter-spacing:.04em}
.topbar-sub{font-size:11px;color:var(--muted);margin-right:auto}
.mode-badge{font-size:11px;font-weight:600;letter-spacing:.06em;padding:3px 10px;border-radius:4px;background:rgba(234,179,8,.15);color:var(--yellow);border:1px solid rgba(234,179,8,.3)}
.mode-badge.live{background:rgba(34,197,94,.12);color:var(--green);border-color:rgba(34,197,94,.3)}
.nav-btn{background:none;border:none;color:var(--muted);font:inherit;font-size:12px;padding:6px 12px;border-radius:5px;cursor:pointer;transition:color .15s,background .15s}
.nav-btn:hover,.nav-btn.active{color:var(--text);background:var(--border)}
.nav-btn.active{color:var(--accent)}
#update-banner{display:none;align-items:center;gap:12px;padding:10px 24px;background:rgba(59,130,246,.12);border-bottom:1px solid rgba(59,130,246,.25);font-size:13px}
#update-banner button{margin-left:auto;background:var(--accent);color:#fff;border:none;padding:5px 14px;border-radius:5px;font:inherit;cursor:pointer;font-size:12px}
.page{display:none;padding:24px;max-width:1100px;margin:0 auto}
.page.active{display:block}
.stats-row{display:flex;gap:12px;margin-bottom:24px;flex-wrap:wrap}
.stat-card{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:16px 20px;min-width:110px}
.stat-card .num{font-family:var(--mono);font-size:28px;font-weight:700;line-height:1;margin-bottom:4px}
.stat-card .lbl{font-size:11px;color:var(--muted);letter-spacing:.05em;text-transform:uppercase}
.stat-card.green .num{color:var(--green)}.stat-card.yellow .num{color:var(--yellow)}.stat-card.red .num{color:var(--red)}.stat-card.blue .num{color:var(--accent)}
.btn{display:inline-flex;align-items:center;gap:7px;padding:9px 20px;border-radius:6px;font:inherit;font-size:13px;font-weight:600;cursor:pointer;border:none;transition:opacity .15s,background .15s}
.btn:disabled{opacity:.4;cursor:default}
.btn-primary{background:var(--accent);color:#fff}.btn-primary:hover:not(:disabled){background:var(--accent2)}
.btn-ghost{background:var(--surface);color:var(--text);border:1px solid var(--border)}.btn-ghost:hover:not(:disabled){border-color:var(--accent);color:var(--accent)}
.action-bar{display:flex;align-items:center;gap:12px;margin-bottom:20px;flex-wrap:wrap}
.status-text{font-size:12px;color:var(--muted);margin-left:4px}
.progress-wrap{height:3px;background:var(--border);border-radius:2px;overflow:hidden;margin-bottom:20px;display:none}
.progress-wrap.visible{display:block}
.progress-bar{height:100%;width:0%;background:var(--accent);border-radius:2px;transition:width .3s}
.preview-box{background:var(--surface);border:1px solid var(--border);border-radius:8px;margin-bottom:20px;overflow:hidden;display:none}
.preview-box.visible{display:block}
.preview-header{padding:12px 16px;font-size:12px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;color:var(--muted);border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between}
.preview-header small{font-weight:400;color:var(--muted);letter-spacing:0;text-transform:none;font-size:11px}
table{width:100%;border-collapse:collapse}
th{text-align:left;font-size:11px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);padding:10px 16px;border-bottom:1px solid var(--border);background:var(--surface)}
td{padding:8px 16px;font-size:13px;border-bottom:1px solid var(--border);vertical-align:middle}
tr:last-child td{border-bottom:none}
tr:hover td{background:rgba(255,255,255,.02)}
.badge{display:inline-block;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:600;letter-spacing:.04em}
.badge-att{background:rgba(139,92,246,.15);color:#c4b5fd}
.badge-body{background:rgba(59,130,246,.15);color:#93c5fd}
.badge-skip{background:rgba(100,116,139,.15);color:var(--muted)}
.badge-flag{background:rgba(234,179,8,.15);color:var(--yellow)}
.badge-unk{background:rgba(239,68,68,.15);color:var(--red)}
.action-select{background:var(--bg);border:1px solid var(--border);color:var(--text);font:inherit;font-size:12px;padding:4px 8px;border-radius:5px;cursor:pointer;outline:none}
.action-select:focus{border-color:var(--accent)}
.action-select option{background:var(--surface)}
.row-skip{opacity:.45}
.section-head{font-size:11px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);margin-bottom:10px;margin-top:24px}
.section-head:first-child{margin-top:0}
.log-box{background:#0a0d14;border:1px solid var(--border);border-radius:8px;padding:14px 16px;font-family:var(--mono);font-size:12px;color:#94a3b8;min-height:200px;max-height:360px;overflow-y:auto;line-height:1.7}
.log-saved{color:var(--green)}.log-skip{color:var(--muted)}.log-flag{color:var(--yellow)}.log-error{color:var(--red)}.log-sep{color:#334155}.log-done{color:var(--accent)}
.history-run{background:var(--surface);border:1px solid var(--border);border-radius:8px;margin-bottom:10px;overflow:hidden}
.history-run-header{padding:12px 16px;display:flex;align-items:center;gap:12px;cursor:pointer;user-select:none}
.history-run-header:hover{background:rgba(255,255,255,.02)}
.run-ts{font-size:13px;font-weight:600}.run-summary{font-size:12px;color:var(--muted);margin-left:auto}
.run-detail{display:none;padding:0 16px 12px;border-top:1px solid var(--border)}.run-detail.open{display:block}
.run-file{font-family:var(--mono);font-size:12px;color:var(--green);padding:2px 0}
.queue-item{background:var(--surface);border:1px solid var(--border);border-left:3px solid var(--yellow);border-radius:8px;padding:14px 16px;margin-bottom:8px;display:flex;align-items:flex-start;gap:12px}
.qi-info{flex:1}.qi-subject{font-size:13px;font-weight:600;margin-bottom:2px}.qi-meta{font-size:12px;color:var(--muted)}.qi-reason{font-size:11px;color:var(--yellow);margin-top:4px}
.settings-group{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:20px;margin-bottom:16px}
.settings-group h3{font-size:12px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);margin-bottom:16px}
.field{margin-bottom:14px}.field label{display:block;font-size:12px;font-weight:600;color:var(--muted);margin-bottom:5px}
.field input{width:100%;background:var(--bg);border:1px solid var(--border);border-radius:5px;color:var(--text);font:inherit;font-size:13px;padding:8px 12px;outline:none;transition:border-color .15s}
.field input:focus{border-color:var(--accent)}
.toggle-row{display:flex;align-items:center;gap:12px;padding:12px 0;border-top:1px solid var(--border)}
.toggle-row .tl{flex:1}.tl-title{font-size:13px;font-weight:600}.tl-desc{font-size:12px;color:var(--muted);margin-top:2px}
.toggle{position:relative;width:40px;height:22px;flex-shrink:0}
.toggle input{opacity:0;width:0;height:0}
.toggle-slider{position:absolute;inset:0;background:var(--border);border-radius:11px;cursor:pointer;transition:background .2s}
.toggle-slider::before{content:'';position:absolute;width:16px;height:16px;border-radius:50%;left:3px;top:3px;background:#fff;transition:transform .2s}
.toggle input:checked+.toggle-slider{background:var(--accent)}
.toggle input:checked+.toggle-slider::before{transform:translateX(18px)}
.rules-info{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:16px 20px;margin-bottom:16px;font-size:12px;color:var(--muted)}
.rules-info strong{color:var(--text)}
.empty{text-align:center;padding:48px 24px;color:var(--muted);font-size:13px}
.empty .empty-icon{font-size:32px;margin-bottom:12px}
::-webkit-scrollbar{width:6px}::-webkit-scrollbar-track{background:transparent}::-webkit-scrollbar-thumb{background:var(--border);border-radius:3px}
</style>
</head>
<body>
<div class="topbar">
  <span class="topbar-brand">SE Remittance Agent</span>
  <span class="topbar-sub">Science Exchange · AR Operations</span>
  <span class="mode-badge" id="mode-badge">TEST MODE</span>
  <button class="nav-btn active" onclick="showPage('dashboard',this)">Dashboard</button>
  <button class="nav-btn" onclick="showPage('history',this)">History</button>
  <button class="nav-btn" onclick="showPage('queue',this)">Review <span id="queue-badge" style="display:none;margin-left:4px;background:var(--yellow);color:#000;border-radius:10px;padding:1px 6px;font-size:10px;font-weight:700"></span></button>
  <button class="nav-btn" onclick="showPage('settings',this)">Settings</button>
</div>
<div id="update-banner">
  <span>🔄 Update available — <strong id="update-ver"></strong></span>
  <button onclick="triggerUpdate()">Update &amp; Restart</button>
  <button onclick="document.getElementById('update-banner').style.display='none'" style="background:transparent;color:var(--muted);border:1px solid var(--border);margin-left:0">Dismiss</button>
</div>

<!-- DASHBOARD -->
<div id="page-dashboard" class="page active">
  <div class="stats-row">
    <div class="stat-card green"><div class="num" id="s-saved">0</div><div class="lbl">Saved</div></div>
    <div class="stat-card"><div class="num" id="s-skip">0</div><div class="lbl">Skipped</div></div>
    <div class="stat-card yellow"><div class="num" id="s-flag">0</div><div class="lbl">Flagged</div></div>
    <div class="stat-card red"><div class="num" id="s-err">0</div><div class="lbl">Errors</div></div>
    <div class="stat-card blue"><div class="num" id="s-queue">0</div><div class="lbl">In Queue</div></div>
  </div>
  <div class="action-bar">
    <button class="btn btn-primary" id="btn-preview" onclick="startPreview()">▶&nbsp; Process All</button>
    <button class="btn btn-primary" id="btn-confirm" onclick="confirmRun()" style="display:none;background:#16a34a">✓&nbsp; Confirm &amp; Run</button>
    <button class="btn btn-ghost" id="btn-cancel" onclick="cancelPreview()" style="display:none">✕&nbsp; Cancel</button>
    <button class="btn btn-ghost" onclick="openStaging()">📁&nbsp; Open Staging</button>
    <span class="status-text" id="status-text">Ready</span>
  </div>
  <div class="progress-wrap" id="progress-wrap"><div class="progress-bar" id="progress-bar"></div></div>

  <!-- Preview table -->
  <div class="preview-box" id="preview-box">
    <div class="preview-header">
      <span>📋 Preview — adjust actions then confirm</span>
      <small>Change any row before running · Skip = leave unread, Flag = send to review queue</small>
    </div>
    <table>
      <thead><tr>
        <th style="width:36px"><input type="checkbox" id="chk-all" onchange="toggleAll(this.checked)" title="Select all"></th>
        <th>Subject</th>
        <th>From</th>
        <th>Classified as</th>
        <th>Action</th>
      </tr></thead>
      <tbody id="preview-tbody"></tbody>
    </table>
    <div id="skip-section" style="display:none">
      <div style="padding:10px 16px;font-size:11px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);border-top:1px solid var(--border);background:rgba(0,0,0,.2)">
        ⏭ Skipped — labeled and excluded from processing
      </div>
      <table><thead><tr>
        <th>Subject</th><th>From</th><th>Reason</th>
      </tr></thead>
      <tbody id="skip-tbody"></tbody></table>
    </div>
  </div>

  <div class="section-head">Activity Log</div>
  <div class="log-box" id="log-box"><span style="color:var(--muted)">Ready. Click ▶ Process All to begin.</span></div>
</div>

<!-- HISTORY -->
<div id="page-history" class="page">
  <div class="section-head">Run History</div>
  <div id="history-list"><div class="empty"><div class="empty-icon">📋</div>No runs yet.</div></div>
</div>

<!-- QUEUE -->
<div id="page-queue" class="page">
  <div class="section-head">Items Needing Review</div>
  <div id="queue-list"><div class="empty"><div class="empty-icon">✅</div>Queue is clear.</div></div>
</div>

<!-- SETTINGS -->
<div id="page-settings" class="page">
  <div class="rules-info">
    <strong>Rules</strong> are loaded automatically from GitHub each time the app opens.<br>
    To add or update a rule, describe the email to Claude in your SE Remittance Agent chat.<br>
    Rules source: <strong>github.com/aronhasofer-apps/se-remittance-agent</strong> &nbsp;·&nbsp;
    <span id="rules-count">—</span> rules loaded &nbsp;·&nbsp;
    <button onclick="refreshRules()" style="background:none;border:none;color:var(--accent);cursor:pointer;font:inherit;font-size:12px;padding:0">↻ Refresh now</button>
  </div>
  <div class="settings-group">
    <h3>Processing</h3>
    <div class="toggle-row">
      <div class="tl"><div class="tl-title">Test Mode</div><div class="tl-desc">Files save to staging only. Drive folder untouched. Flip off when ready to go live.</div></div>
      <label class="toggle"><input type="checkbox" id="toggle-test" onchange="saveSetting('testMode',this.checked)"><span class="toggle-slider"></span></label>
    </div>
  </div>
  <div class="settings-group">
    <h3>Paths &amp; Destinations</h3>
    <div class="field"><label>Staging Folder (test mode)</label><input type="text" id="set-staging" onchange="saveSetting('stagingPath',this.value)"></div>
    <div class="field"><label>Live Destination Folder</label><input type="text" id="set-live" placeholder="G:\Shared drives\Finance\..." onchange="saveSetting('livePath',this.value)"><div style="font-size:11px;color:var(--muted);margin-top:4px">Local path via Google Drive for Desktop. Files copied here when Test Mode is off.</div></div>
    <div class="field"><label>Gmail Label</label><input type="text" id="set-label" onchange="saveSetting('gmailLabel',this.value)"></div>
  </div>
  <div class="settings-group">
    <h3>App</h3>
    <div style="font-size:12px;color:var(--muted);margin-bottom:12px">Version: <span id="set-version" style="font-family:var(--mono)"></span></div>
    <button class="btn btn-ghost" onclick="checkUpdate()" style="font-size:12px">Check for Updates</button>
    &nbsp;
    <button class="btn btn-ghost" onclick="reauth()" style="font-size:12px">Re-authenticate Google</button>
  </div>
</div>

<script>
let currentEmails = [];
let rowActions = {};  // index -> override action

async function api(path, method='GET', body=null) {
  const opts={method,headers:{'Content-Type':'application/json'}};
  if(body) opts.body=JSON.stringify(body);
  const r=await fetch(path,opts); return r.json();
}

function showPage(name,btn){
  document.querySelectorAll('.page').forEach(p=>p.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(b=>b.classList.remove('active'));
  document.getElementById('page-'+name).classList.add('active');
  if(btn) btn.classList.add('active');
  if(name==='history') loadHistory();
  if(name==='queue')   loadQueue();
  if(name==='settings') loadSettings();
}

async function init(){
  const s=await api('/api/state');
  updateStats(s);
  document.getElementById('mode-badge').textContent=s.testMode?'TEST MODE':'LIVE';
  document.getElementById('mode-badge').className='mode-badge'+(s.testMode?'':' live');
  updateQueueBadge(s.queueCount);
  if(s.updateAvailable) showUpdateBanner(s.updateInfo);
  if(s.rulesCount !== undefined) {
    const el = document.getElementById('rules-count');
    if(el) el.textContent = s.rulesCount + ' rules';
  }
}

function updateStats(s){
  document.getElementById('s-saved').textContent=s.saved??0;
  document.getElementById('s-skip').textContent=s.skipped??0;
  document.getElementById('s-flag').textContent=s.flagged??0;
  document.getElementById('s-err').textContent=s.errors??0;
  document.getElementById('s-queue').textContent=s.queueCount??0;
}
function updateQueueBadge(n){
  const b=document.getElementById('queue-badge');
  if(n>0){b.textContent=n;b.style.display='inline';}else{b.style.display='none';}
}

// ── Preview ──────────────────────────────────────────────────────────────────
async function startPreview(){
  setStatus('Fetching emails…');
  document.getElementById('btn-preview').disabled=true;
  showProgress(true);
  const r=await api('/api/preview');
  showProgress(false);
  if(r.error){setStatus('Error: '+r.error);document.getElementById('btn-preview').disabled=false;return;}
  if(!r.emails||r.emails.length===0){
    setStatus('No unread remittance emails found.');
    appendLog('No unread emails in the Remittances label.');
    document.getElementById('btn-preview').disabled=false;return;
  }
  currentEmails=r.emails;
  rowActions={};
  renderPreview(r.emails);
  document.getElementById('preview-box').classList.add('visible');
  document.getElementById('btn-confirm').style.display='inline-flex';
  document.getElementById('btn-cancel').style.display='inline-flex';
  document.getElementById('btn-preview').style.display='none';
  setStatus(`Found ${r.emails.length} email(s) — review and confirm`);
}

function renderPreview(emails){
  const tbody=document.getElementById('preview-tbody');
  const skipTbody=document.getElementById('skip-tbody');
  const skipSection=document.getElementById('skip-section');
  tbody.innerHTML=''; skipTbody.innerHTML='';
  let skipCount=0;

  emails.forEach((e,i)=>{
    const cl=e.classification||{};
    const action=cl.action||'flag';
    const track=cl.track||'Flag for Review';
    const count=e.messageCount||1;
    const countBadge=count>1?` <span style="font-size:10px;color:var(--muted);font-family:var(--mono)">(${count})</span>`:'';

    if(action==='skip'){
      skipCount++;
      skipTbody.innerHTML+=`<tr style="opacity:.65">
        <td style="max-width:320px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px">${esc(e.subject)}${countBadge}</td>
        <td style="color:var(--muted);font-size:11px;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(e.sender)}</td>
        <td style="font-size:11px;color:var(--muted)">${esc(cl.description||cl.rule_id||'skip rule')}</td>
      </tr>`;
    } else {
      let bc='badge-flag';
      if(action==='save_attachment') bc='badge-att';
      else if(action==='extract_body') bc='badge-body';
      tbody.innerHTML+=`<tr id="row-${i}">
        <td><input type="checkbox" id="chk-${i}" checked onchange="rowCheck(${i},this.checked)"></td>
        <td style="max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(e.subject)}">${esc(e.subject)}${countBadge}</td>
        <td style="color:var(--muted);font-size:11px;max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(e.sender)}</td>
        <td><span class="badge ${bc}">${esc(track)}</span><br><span style="font-size:10px;color:var(--muted)">${esc(cl.rule_id||'')}</span></td>
        <td>
          <select class="action-select" onchange="setAction(${i},this.value)">
            <option value="" ${action!=='flag'?'selected':''}>Process as classified</option>
            <option value="save_attachment" ${action==='save_attachment'?'selected':''}>Save Attachment</option>
            <option value="extract_body" ${action==='extract_body'?'selected':''}>Extract from Body</option>
            <option value="skip">Skip this run</option>
            <option value="flag" ${action==='flag'?'selected':''}>Flag for Review</option>
          </select>
        </td>
      </tr>`;
    }
  });
  skipSection.style.display=skipCount>0?'block':'none';
}

function setAction(i, val){
  rowActions[i]=val||null;
  const row=document.getElementById('row-'+i);
  if(row) row.className=val==='skip'?'row-skip':'';
}

function rowCheck(i, checked){
  if(!checked) rowActions[i]='skip';
  else delete rowActions[i];
  const row=document.getElementById('row-'+i);
  if(row) row.className=!checked?'row-skip':'';
}

function toggleAll(checked){
  currentEmails.forEach((_,i)=>{
    const chk=document.getElementById('chk-'+i);
    if(chk){chk.checked=checked; rowCheck(i,checked);}
  });
}

function cancelPreview(){
  document.getElementById('preview-box').classList.remove('visible');
  document.getElementById('btn-confirm').style.display='none';
  document.getElementById('btn-cancel').style.display='none';
  document.getElementById('btn-preview').style.display='inline-flex';
  document.getElementById('btn-preview').disabled=false;
  setStatus('Ready');
}

async function confirmRun(){
  const payload = currentEmails.map((email,i)=>({
    email,
    override_action: rowActions[i]||null
  }));
  document.getElementById('preview-box').classList.remove('visible');
  document.getElementById('btn-confirm').style.display='none';
  document.getElementById('btn-cancel').style.display='none';
  document.getElementById('btn-preview').disabled=true;
  document.getElementById('log-box').innerHTML='';
  showProgress(true); setStatus('Processing…');
  await api('/api/run','POST',{emails:payload});
  const poll=setInterval(async()=>{
    const r=await api('/api/status');
    if(r.log) renderLog(r.log);
    if(r.progress!=null) setProgressPct(r.progress);
    if(r.status==='done'||r.status==='idle'){
      clearInterval(poll); showProgress(false);
      document.getElementById('btn-preview').disabled=false;
      document.getElementById('btn-preview').style.display='inline-flex';
      setStatus('Done');
      const s=await api('/api/state');
      updateStats(s); updateQueueBadge(s.queueCount);
    }
  },1200);
}

function renderLog(lines){
  const box=document.getElementById('log-box');
  box.innerHTML=lines.map(l=>{
    let cls='';
    if(l.includes('SAVED')||l.includes('→ SAVED')) cls='log-saved';
    else if(l.includes('SKIPPED')) cls='log-skip';
    else if(l.includes('FLAG')||l.includes('queued')||l.includes('QUEUE')) cls='log-flag';
    else if(l.includes('ERROR')) cls='log-error';
    else if(l.includes('═══')||l.includes('Done')) cls='log-done';
    else if(l.includes('─────')) cls='log-sep';
    return `<div class="${cls}">${esc(l)}</div>`;
  }).join('');
  box.scrollTop=box.scrollHeight;
}
function appendLog(msg){
  const box=document.getElementById('log-box');
  if(box.querySelector('span')) box.innerHTML='';
  const d=document.createElement('div');d.style.color='var(--muted)';d.textContent=msg;box.appendChild(d);
}

async function loadHistory(){
  const r=await api('/api/history');
  const el=document.getElementById('history-list');
  if(!r.runs||r.runs.length===0){el.innerHTML='<div class="empty"><div class="empty-icon">📋</div>No runs yet.</div>';return;}
  el.innerHTML=r.runs.map((run)=>{
    const ts=new Date(run.startedAt).toLocaleString();
    const dur=run.durationSeconds?`${run.durationSeconds}s`:'';
    const sum=`${run.saved?.length??0} saved · ${run.skipped?.length??0} skipped · ${run.flagged?.length??0} flagged`;
    const files=(run.saved||[]).map(s=>`<div class="run-file">• ${esc(s.filename||s)}</div>`).join('');
    return `<div class="history-run"><div class="history-run-header" onclick="this.nextElementSibling.classList.toggle('open')"><span class="run-ts">${ts}</span><span style="font-size:11px;color:var(--muted)">${dur}</span><span class="run-summary">${sum}</span></div><div class="run-detail"><div style="margin-top:8px">${files||'<span style="color:var(--muted);font-size:12px">No files saved.</span>'}</div></div></div>`;
  }).join('');
}

async function loadQueue(){
  const r=await api('/api/queue');
  const el=document.getElementById('queue-list');
  const items=(r.items||[]).filter(i=>!i.resolved);
  if(items.length===0){el.innerHTML='<div class="empty"><div class="empty-icon">✅</div>Queue is clear.</div>';return;}
  el.innerHTML=`
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px;padding:8px 0;border-bottom:1px solid var(--border)">
      <input type="checkbox" id="qchk-all" onchange="toggleQueueAll(this.checked)" style="cursor:pointer">
      <label for="qchk-all" style="font-size:12px;color:var(--muted);cursor:pointer">Select all</label>
      <button class="btn btn-primary" onclick="reprocessSelected()" style="font-size:11px;padding:5px 14px;background:#16a34a;margin-left:8px">↺ Reprocess Selected</button>
      <button class="btn btn-ghost" onclick="resolveSelected()" style="font-size:11px;padding:5px 14px">✓ Resolve Selected</button>
    </div>`+
  items.map((item,i)=>`<div class="queue-item" id="qi-${i}">
    <input type="checkbox" id="qchk-${i}" style="margin-top:2px;cursor:pointer">
    <div class="qi-info">
      <div class="qi-subject">${esc(item.subject)}</div>
      <div class="qi-meta">${esc(item.sender||'')} · ${new Date(item.addedAt).toLocaleString()}</div>
      <div class="qi-reason">⚠ ${esc(item.reason||'')} ${item.rule_id?'· rule: '+esc(item.rule_id):''}</div>
    </div>
    <div style="display:flex;flex-direction:column;gap:6px">
      <button class="btn btn-primary" style="font-size:11px;padding:6px 12px;background:#16a34a" onclick="reprocessItem(${i})">↺ Reprocess</button>
      <button class="btn btn-ghost" style="font-size:11px;padding:6px 12px" onclick="resolveItem(${i})">✓ Resolved</button>
    </div>
  </div>`).join('');
}

function toggleQueueAll(checked){
  document.querySelectorAll('[id^="qchk-"]').forEach(chk=>{
    if(chk.id!=='qchk-all') chk.checked=checked;
  });
}

async function reprocessSelected(){
  const checked=[];
  document.querySelectorAll('[id^="qchk-"]').forEach(chk=>{
    if(chk.id!=='qchk-all'&&chk.checked) checked.push(parseInt(chk.id.replace('qchk-','')));
  });
  if(!checked.length){setStatus('No items selected.');return;}
  setStatus(`Reprocessing ${checked.length} item(s)...`);
  for(const i of checked.reverse()){
    await api('/api/queue/reprocess','POST',{index:i});
  }
  setStatus(`${checked.length} item(s) queued for reprocessing.`);
  loadQueue();const s=await api('/api/state');updateQueueBadge(s.queueCount);
}

async function resolveSelected(){
  const checked=[];
  document.querySelectorAll('[id^="qchk-"]').forEach(chk=>{
    if(chk.id!=='qchk-all'&&chk.checked) checked.push(parseInt(chk.id.replace('qchk-','')));
  });
  if(!checked.length){setStatus('No items selected.');return;}
  for(const i of checked.reverse()){
    await api('/api/queue/resolve','POST',{index:i});
  }
  setStatus(`${checked.length} item(s) resolved.`);
  loadQueue();const s=await api('/api/state');updateQueueBadge(s.queueCount);
}
async function resolveItem(i){
  await api('/api/queue/resolve','POST',{index:i});
  loadQueue();const s=await api('/api/state');updateQueueBadge(s.queueCount);
}
async function reprocessItem(i){
  setStatus('Removing label so email can be reprocessed...');
  const r=await api('/api/queue/reprocess','POST',{index:i});
  if(r.ok) setStatus('Ready — email will be picked up on next run.');
  else setStatus('Error: '+r.error);
  loadQueue();const s=await api('/api/state');updateQueueBadge(s.queueCount);
}

async function loadSettings(){
  const s=await api('/api/settings');
  document.getElementById('toggle-test').checked=s.testMode;
  document.getElementById('set-staging').value=s.stagingPath||'';
  document.getElementById('set-live').value=s.livePath||'';
  document.getElementById('set-label').value=s.gmailLabel||'';
  document.getElementById('set-version').textContent=s.version||'';
  const rc=document.getElementById('rules-count');
  if(rc) rc.textContent=(s.rulesCount||0)+' rules loaded';
}
async function saveSetting(key,value){
  await api('/api/settings','POST',{key,value});
  const s=await api('/api/state');
  document.getElementById('mode-badge').textContent=s.testMode?'TEST MODE':'LIVE';
  document.getElementById('mode-badge').className='mode-badge'+(s.testMode?'':' live');
}
async function refreshRules(){
  setStatus('Refreshing rules from GitHub…');
  const r=await api('/api/refresh-rules','POST');
  setStatus(r.count+' rules loaded');
  const rc=document.getElementById('rules-count');
  if(rc) rc.textContent=r.count+' rules loaded';
}
async function reauth(){await api('/api/reauth','POST');setStatus('Re-auth triggered — check browser.');}
async function checkUpdate(){const r=await api('/api/update-check');if(r.available)showUpdateBanner(r.info);else alert('You are on the latest version.');}
async function triggerUpdate(){await api('/api/update','POST');alert('Downloading update… app will restart.');}
function openStaging(){fetch('/api/open-staging');}
function setStatus(msg){document.getElementById('status-text').textContent=msg;}
function showProgress(on){document.getElementById('progress-wrap').classList.toggle('visible',on);if(on)setProgressPct(null);}
function setProgressPct(pct){const b=document.getElementById('progress-bar');if(pct==null){b.style.transition='none';b.style.width='0%';setTimeout(()=>{b.style.transition='width .4s';},50);}else{b.style.width=pct+'%';}}
function showUpdateBanner(info){document.getElementById('update-ver').textContent=info?.version||'new';document.getElementById('update-banner').style.display='flex';}
function esc(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}

init();
// Check for update 5s after load (background thread may not be done at init time)
setTimeout(async()=>{
  const s=await api('/api/state');
  if(s.updateAvailable) showUpdateBanner(s.updateInfo);
},5000);
// Poll every 10s — keeps queue count, stats, and update banner live
setInterval(async()=>{
  const s=await api('/api/state');
  updateStats(s);
  updateQueueBadge(s.queueCount);
  if(s.updateAvailable) showUpdateBanner(s.updateInfo);
},10000);
// Refresh everything when tab becomes visible again
document.addEventListener('visibilitychange',async()=>{
  if(document.hidden) return;
  await init();
  const active=document.querySelector('.page.active');
  if(!active) return;
  if(active.id==='page-queue')    loadQueue();
  if(active.id==='page-history')  loadHistory();
  if(active.id==='page-settings') loadSettings();
});
</script>
</body>
</html>"""

# ── HTTP handler ──────────────────────────────────────────────────────────────

class Handler(BaseHTTPRequestHandler):
    def log_message(self,*a): pass
    def _send(self,code,body,ct="application/json"):
        if isinstance(body,str): body=body.encode()
        self.send_response(code)
        self.send_header("Content-Type",ct)
        self.send_header("Content-Length",len(body))
        self.send_header("Access-Control-Allow-Origin","*")
        self.end_headers()
        self.wfile.write(body)
    def _json(self,data,code=200): self._send(code,json.dumps(data))
    def _body(self):
        n=int(self.headers.get("Content-Length",0))
        return json.loads(self.rfile.read(n)) if n else {}

    def do_GET(self):
        p=self.path.split("?")[0]
        if p in ("/","/index.html"):
            return self._send(200,DASHBOARD_HTML,"text/html; charset=utf-8")
        if p=="/api/state":
            last=HISTORY.get_last_run_summary()
            return self._json({
                "testMode":      SETTINGS.test_mode,
                "authenticated": GOOGLE.is_authenticated(),
                "saved":         len(last.get("saved",[])) if last else 0,
                "skipped":       len(last.get("skipped",[])) if last else 0,
                "flagged":       len(last.get("flagged",[])) if last else 0,
                "errors":        len(last.get("errors",[])) if last else 0,
                "queueCount":    QUEUE.count_unresolved(),
                "rulesCount":    len(_rules),
                "updateAvailable": _update_info is not None,
                "updateInfo":    _update_info,
            })
        if p=="/api/preview":
            try:
                emails=GOOGLE.fetch_unread_emails(SETTINGS.gmail_label)
                for e in emails:
                    e["classification"]=classify_email(e)
                return self._json({"emails":emails})
            except Exception as ex:
                return self._json({"error":str(ex)})
        if p=="/api/status":
            prog=0
            if _run_status=="done": prog=100
            elif _run_status=="running" and _run_log:
                for line in reversed(_run_log):
                    m=re.search(r"\[(\d+)/(\d+)\]",line)
                    if m:
                        x,y=int(m.group(1)),int(m.group(2))
                        prog=int(x/y*90) if y else 0; break
            return self._json({"status":_run_status,"log":_run_log[-200:],"progress":prog})
        if p=="/api/history":  return self._json({"runs":HISTORY.get_recent(20)})
        if p=="/api/queue":    return self._json({"items":QUEUE.get_all()})
        if p=="/api/settings": return self._json({
            "testMode":SETTINGS.test_mode,"stagingPath":SETTINGS.staging_path,
            "livePath":SETTINGS.live_path,"gmailLabel":SETTINGS.gmail_label,
            "version":APP_VERSION,"rulesCount":len(_rules),
        })
        if p=="/api/open-staging":
            import subprocess
            try: subprocess.Popen(["explorer",SETTINGS.staging_path])
            except: pass
            return self._json({"ok":True})
        if p=="/api/update-check":
            info=check_update()
            return self._json({"available":info is not None,"info":info})
        self._json({"error":"not found"},404)

    def do_POST(self):
        p=self.path.split("?")[0]
        body=self._body()
        if p=="/api/run":
            if not _run_lock.locked():
                threading.Thread(target=run_processing,args=(body.get("emails",[]),),daemon=True).start()
                return self._json({"ok":True})
            return self._json({"error":"run in progress"},409)
        if p=="/api/settings":
            key,val=body.get("key"),body.get("value")
            if key: SETTINGS.set(key,val)
            return self._json({"ok":True})
        if p=="/api/queue/resolve":
            idx=body.get("index")
            if idx is not None: QUEUE.resolve(int(idx))
            return self._json({"ok":True})
        if p=="/api/queue/reprocess":
            idx=body.get("index")
            if idx is not None:
                items=QUEUE.get_all()
                unresolved=[i for i in items if not i.get("resolved")]
                if 0<=int(idx)<len(unresolved):
                    item=unresolved[int(idx)]
                    thread_id=item.get("threadId","")
                    if thread_id:
                        try:
                            GOOGLE.remove_label(thread_id, SETTINGS.agent_label)
                        except Exception as e:
                            return self._json({"ok":False,"error":str(e)})
                        # Remove from run history so it's not blocked
                        for run in HISTORY.get_recent(50):
                            run["saved"] = [s for s in run.get("saved",[])
                                           if isinstance(s,dict) and s.get("threadId")!=thread_id]
                        HISTORY._save()
                    QUEUE.resolve(int(idx))
            return self._json({"ok":True})
        if p=="/api/refresh-rules":
            global _rules
            data=sync_rules(BASE_DIR)
            _rules=data.get("rules",[])
            return self._json({"ok":True,"count":len(_rules)})
        if p=="/api/reauth":
            token=os.path.join(BASE_DIR,"token.pickle")
            if os.path.exists(token): os.remove(token)
            threading.Thread(target=lambda:GOOGLE.is_authenticated(),daemon=True).start()
            return self._json({"ok":True})
        if p=="/api/update":
            threading.Thread(target=_do_update,daemon=True).start()
            return self._json({"ok":True})
        self._json({"error":"not found"},404)


def _do_update():
    try:
        info=check_update()
        if not info or not info.get("download_url"): return
        current=sys.executable if getattr(sys,"frozen",False) else __file__
        new_exe=current+".new"
        with urllib.request.urlopen(info["download_url"],timeout=60) as r:
            with open(new_exe,"wb") as f: f.write(r.read())
        bat=os.path.join(BASE_DIR,"_update.bat")
        with open(bat,"w") as f:
            f.write(f'@echo off\ntimeout /t 2 /nobreak>nul\nmove /y "{new_exe}" "{current}"\nstart "" "{current}"\ndel "%~f0"\n')
        import subprocess
        subprocess.Popen(["cmd","/c",bat])
        time.sleep(1); sys.exit(0)
    except Exception as e:
        _log(f"Update failed: {e}")


def main():
    os.makedirs(SETTINGS.staging_path,exist_ok=True)
    server=HTTPServer(("127.0.0.1",PORT),Handler)
    threading.Thread(target=server.serve_forever,daemon=True).start()
    time.sleep(0.4)
    webbrowser.open(f"http://127.0.0.1:{PORT}")
    try:
        while True: time.sleep(1)
    except KeyboardInterrupt:
        server.shutdown()

if __name__=="__main__":
    main()
