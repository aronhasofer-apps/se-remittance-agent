"""
SE Remittance Agent — GitHub Updater v2
- Rules: pulled from raw GitHub on every launch
- App updates: checks GitHub Releases API for new exe
"""

import json
import os
import urllib.request
import urllib.error

GITHUB_REPO   = "aronhasofer-apps/se-remittance-agent"
GITHUB_RAW    = f"https://raw.githubusercontent.com/{GITHUB_REPO}/main"
RULES_URL     = f"{GITHUB_RAW}/rules.json"
RELEASES_API  = f"https://api.github.com/repos/{GITHUB_REPO}/releases/latest"
APP_VERSION   = "2.2.0"


def fetch_url(url: str, timeout: int = 8) -> dict | None:
    try:
        req = urllib.request.Request(url, headers={"Accept": "application/vnd.github.v3+json"})
        with urllib.request.urlopen(req, timeout=timeout) as r:
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
    Check GitHub Releases for a newer version.
    Returns release info dict (with download_url) or None.
    """
    release = fetch_url(RELEASES_API)
    if not release:
        return None

    tag = release.get("tag_name", "").lstrip("v")
    if not tag or tag == APP_VERSION:
        return None

    # Find the exe asset
    assets = release.get("assets", [])
    exe_asset = next(
        (a for a in assets if a.get("name", "").endswith(".exe")),
        None
    )
    if not exe_asset:
        return None

    return {
        "version":      tag,
        "download_url": exe_asset["browser_download_url"],
        "notes":        release.get("body", ""),
        "tag":          release.get("tag_name", ""),
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
