"""
SE Remittance Agent — Gmail & Drive Client
Direct Google API access via OAuth2.
Fetches threads (not individual messages) so each conversation appears once.
Shows message count per thread in the preview.
"""

import os
import base64
import pickle
from googleapiclient.discovery import build
from google_auth_oauthlib.flow import InstalledAppFlow
from google.auth.transport.requests import Request

SCOPES = [
    "https://www.googleapis.com/auth/gmail.modify",
    "https://www.googleapis.com/auth/drive",
]


def _get_creds(base_dir: str):
    creds = None
    token_path = os.path.join(base_dir, "token.pickle")
    creds_path = os.path.join(base_dir, "credentials.json")
    if os.path.exists(token_path):
        with open(token_path, "rb") as f:
            creds = pickle.load(f)
    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            creds.refresh(Request())
        else:
            flow = InstalledAppFlow.from_client_secrets_file(creds_path, SCOPES)
            creds = flow.run_local_server(port=0, open_browser=True)
        with open(token_path, "wb") as f:
            pickle.dump(creds, f)
    return creds


class GoogleClient:
    def __init__(self, base_dir: str):
        self._base_dir = base_dir
        self._creds    = None
        self._gmail    = None
        self._drive    = None

    def _ensure_auth(self):
        if not self._creds or not self._creds.valid:
            self._creds = _get_creds(self._base_dir)
            self._gmail = build("gmail", "v1", credentials=self._creds)
            self._drive = build("drive", "v3", credentials=self._creds)

    # ── Gmail ─────────────────────────────────────────────────────────────────

    def fetch_unread_emails(self, label_name: str) -> list:
        self._ensure_auth()

        # Get all label IDs in one call
        labels_resp    = self._gmail.users().labels().list(userId="me").execute()
        label_id       = None
        agent_label_id = None
        name_lower     = label_name.lower()
        last_seg       = name_lower.split("/")[-1].strip()

        for lbl in labels_resp.get("labels", []):
            n = lbl["name"].lower()
            if n == name_lower or n.endswith("/" + last_seg) or n == last_seg:
                label_id = lbl["id"]
            if n == "remittance agent":
                agent_label_id = lbl["id"]

        if not label_id:
            return []

        # Fetch ALL unread threads in label (including already-labeled skip emails)
        result = self._gmail.users().threads().list(
            userId="me",
            labelIds=[label_id, "UNREAD"],
            maxResults=50,
        ).execute()

        threads = result.get("threads", [])
        emails  = []

        for thread in threads:
            detail   = self._gmail.users().threads().get(
                userId="me", id=thread["id"], format="full"
            ).execute()
            messages = detail.get("messages", [])
            if not messages:
                continue

            # Check if ALL messages have agent label (fully processed thread)
            all_labeled = agent_label_id and all(
                agent_label_id in m.get("labelIds", []) for m in messages
            )

            # Find unprocessed messages
            unprocessed = [m for m in messages
                          if not (agent_label_id and agent_label_id in m.get("labelIds", []))]

            if all_labeled:
                # All processed — skip entirely, don't show
                continue

            if not unprocessed:
                continue

            if len(unprocessed) == 1:
                parsed = self._parse_message(unprocessed[0])
                parsed["threadId"]     = thread["id"]
                parsed["messageCount"] = len(messages)
                emails.append(parsed)
            else:
                # Multiple unprocessed messages — add each separately
                for msg in unprocessed:
                    parsed = self._parse_message(msg)
                    parsed["threadId"]     = thread["id"]
                    parsed["messageCount"] = len(unprocessed)
                    emails.append(parsed)

        return emails

    def _parse_message(self, detail: dict) -> dict:
        headers = {h["name"].lower(): h["value"]
                   for h in detail.get("payload", {}).get("headers", [])}
        subject = detail.get("subject") or headers.get("subject", "(no subject)")
        sender  = detail.get("sender")  or headers.get("from", "")

        attachments = []
        for part in detail.get("payload", {}).get("parts", []):
            if part.get("filename") and part.get("body", {}).get("attachmentId"):
                attachments.append({
                    "name":         part["filename"],
                    "attachmentId": part["body"]["attachmentId"],
                    "mimeType":     part.get("mimeType", ""),
                })

        return {
            "threadId":     detail.get("threadId", ""),
            "messageId":    detail.get("id", ""),
            "subject":      subject,
            "sender":       sender,
            "snippet":      detail.get("snippet", ""),
            "date":         detail.get("date") or headers.get("date", ""),
            "attachments":  attachments,
            "messageCount": 1,
            "_raw":         detail,
        }

    def fetch_body(self, message_id: str, email: dict = None) -> str:
        """
        Extract plain text body. Uses already-fetched _raw payload if available.
        Handles both plaintextBody (MCP format) and HTML-only emails.
        """
        if email and email.get("_raw"):
            raw = email["_raw"]
            # Try plaintextBody first (MCP format)
            if raw.get("plaintextBody"):
                return raw["plaintextBody"]
            # Try htmlBody — strip tags to get plain text
            if raw.get("htmlBody"):
                return self._strip_html(raw["htmlBody"])
            # Try payload parsing (direct API format)
            payload = raw.get("payload", {})
            if payload:
                body = self._extract_body(payload)
                if body:
                    return body

        # Fallback: fetch from API
        self._ensure_auth()
        try:
            detail = self._gmail.users().messages().get(
                userId="me", id=message_id, format="full"
            ).execute()
            if detail.get("plaintextBody"):
                return detail["plaintextBody"]
            if detail.get("htmlBody"):
                return self._strip_html(detail["htmlBody"])
            return self._extract_body(detail.get("payload", {}))
        except Exception:
            return ""

    def _strip_html(self, html: str) -> str:
        """Strip HTML tags and decode entities to get plain text."""
        import re, html as html_lib
        # Remove style and script blocks
        text = re.sub(r'<(style|script)[^>]*>.*?</\1>', ' ', html, flags=re.DOTALL | re.I)
        # Replace block elements with newlines
        text = re.sub(r'<(br|tr|div|p|td|th)[^>]*>', '\n', text, flags=re.I)
        # Remove all remaining tags
        text = re.sub(r'<[^>]+>', ' ', text)
        # Decode HTML entities
        text = html_lib.unescape(text)
        # Collapse whitespace but preserve newlines
        lines = [' '.join(line.split()) for line in text.split('\n')]
        text = '\n'.join(line for line in lines if line.strip())
        return text

    def _extract_body(self, payload: dict) -> str:
        # Direct body data
        body_data = payload.get("body", {}).get("data", "")
        if body_data:
            raw = base64.urlsafe_b64decode(body_data).decode("utf-8", errors="replace")
            mime = payload.get("mimeType", "")
            if "html" in mime:
                return self._strip_html(raw)
            return raw

        plain_html = None
        for part in payload.get("parts", []):
            mime = part.get("mimeType", "")
            data = part.get("body", {}).get("data", "")
            if data:
                decoded = base64.urlsafe_b64decode(data).decode("utf-8", errors="replace")
                if mime == "text/plain":
                    return decoded          # plain text wins immediately
                if mime == "text/html":
                    plain_html = decoded    # keep as fallback
            # Recurse into multipart
            if mime.startswith("multipart"):
                result = self._extract_body(part)
                if result:
                    return result

        # Fall back to stripped HTML if no plain text found
        if plain_html:
            return self._strip_html(plain_html)
        return ""

    def fetch_attachment(self, message_id: str, attachment_id: str) -> bytes | None:
        self._ensure_auth()
        try:
            att  = self._gmail.users().messages().attachments().get(
                userId="me", messageId=message_id, id=attachment_id
            ).execute()
            data = att.get("data", "")
            if data:
                return base64.urlsafe_b64decode(data)
        except Exception:
            pass
        return None

    def add_label(self, thread_id: str, label_name: str, message_id: str = None):
        self._ensure_auth()
        labels_resp = self._gmail.users().labels().list(userId="me").execute()
        label_id    = None
        for lbl in labels_resp.get("labels", []):
            if lbl["name"].lower() == label_name.lower():
                label_id = lbl["id"]
                break
        if not label_id:
            new_label = self._gmail.users().labels().create(
                userId="me", body={"name": label_name}
            ).execute()
            label_id = new_label["id"]

        if message_id:
            # Label individual message (better for multi-message threads)
            self._gmail.users().messages().modify(
                userId="me", id=message_id,
                body={"addLabelIds": [label_id]}
            ).execute()
        else:
            # Label entire thread
            self._gmail.users().threads().modify(
                userId="me", id=thread_id,
                body={"addLabelIds": [label_id], "removeLabelIds": []}
            ).execute()

    def remove_label(self, thread_id: str, label_name: str):
        self._ensure_auth()
        labels_resp = self._gmail.users().labels().list(userId="me").execute()
        label_id    = None
        for lbl in labels_resp.get("labels", []):
            if lbl["name"].lower() == label_name.lower():
                label_id = lbl["id"]
                break
        if label_id:
            self._gmail.users().threads().modify(
                userId="me", id=thread_id,
                body={"removeLabelIds": [label_id]}
            ).execute()

    # ── Drive ─────────────────────────────────────────────────────────────────

    def is_authenticated(self) -> bool:
        try:
            self._ensure_auth()
            return True
        except Exception:
            return False
