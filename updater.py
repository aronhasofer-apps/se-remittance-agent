"""
SE Remittance Agent — GitHub Updater v3
- Rules: pulled from raw GitHub on every launch
- App updates: checks raw version.json (no rate limiting), downloads from Releases
"""

import json
import os
import urllib.request
import urllib.error

GITHUB_REPO   = "aronhasofer-apps/se-remittance-agent"
GITHUB_RAW    = f"https://raw.githubusercontent.com/{GITHUB_REPO}/main"
RULES_URL     = f"{GITHUB_RAW}/rules.json"
VERSION_URL   = f"{GITHUB_RAW}/version.json"
DOWNLOAD_BASE = f"https://github.com/{GITHUB_REPO}/releases/download"
APP_VERSION   = "2.2.1"


def fetch_url(url: str, timeout: int = 8) -> dict | None:
    try:
        import ssl
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode    = ssl.CERT_NONE
        req = urllib.request.Request(url, headers={"User-Agent": "SE-Remittance-Agent/2.2"})
        with urllib.request.urlopen(req, context=ctx, timeout=timeout) as r:
            return json.loads(r.read())
    except Exception:
        return None


def sync_rules(base_dir: str) -> dict:
    """Download latest rules.json from GitHub. Falls back to local cache."""
    local_path = os.path.join(base_dir, "rules_cache.json")
    remote = fetch_url(RULES_URL)
    if remote:
        with open(local_path, "w") as f:
            json.dump(remote, f, indent=2)
        return remote
    if os.path.exists(local_path):
        with open(local_path) as f:
            return json.load(f)
    return {"rules": []}


def check_update() -> dict | None:
    """
    Check raw version.json for a newer version (no API rate limiting).
    Returns update info dict or None if already up to date.
    """
    remote = fetch_url(VERSION_URL)
    if not remote:
        return None

    tag = remote.get("version", "").strip()
    if not tag or tag == APP_VERSION:
        return None

    return {
        "version":      tag,
        "download_url": f"{DOWNLOAD_BASE}/v{tag}/SE.Remittance.Agent.exe",
        "notes":        remote.get("notes", ""),
        "tag":          f"v{tag}",
    }


def classify_by_rules(email: dict, rules: list) -> dict:
    """Apply rules to classify an email. Returns action dict."""
    subject = email.get("subject", "").lower()
    sender  = email.get("sender",  "").lower()
    snippet = email.get("snippet", "").lower()

    for rule in rules:
        match         = rule.get("match", {})
        subject_terms = match.get("subject_contains", [])
        sender_terms  = match.get("sender_contains",  [])
        snippet_terms = match.get("snippet_contains", [])
        matched = True

        if subject_terms:
            if not any(t.lower() in subject for t in subject_terms):
                matched = False
        if matched and sender_terms:
            if not any(t.lower() in sender for t in sender_terms):
                matched = False
        if matched and snippet_terms:
            if not any(t.lower() in snippet for t in snippet_terms):
                matched = False

        if matched:
            return {
                "action":      rule.get("action", "flag"),
                "short_name":  rule.get("short_name", ""),
                "notes":       rule.get("notes", ""),
                "rule_id":     rule.get("id", ""),
                "description": rule.get("description", ""),
                "no_label":    rule.get("no_label", False),
            }

    return {
        "action":      "flag",
        "short_name":  "",
        "notes":       "No matching rule found",
        "rule_id":     "unknown",
        "description": "Unrecognized email — attempting extraction",
        "no_label":    False,
    }
