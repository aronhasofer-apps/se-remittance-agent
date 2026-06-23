"""
SE Remittance Agent — Processing Engine v2.2
Smart processing: try attachment first, fall back to body, flag only if
amount + payor + at least one invoice number cannot all be found.
"""

import re
import os
import base64
import json
import time
from datetime import datetime
from typing import Optional

AMOUNT_MIN = 100.0
AMOUNT_MAX = 500_000.0

SENDER_MAP = {
    "erppayables@gilead.com":        ("Gilead Sciences", "B"),
    "noreply-erp@gsk.com":           ("GSK",             "B"),
    "bio.finance":                   ("GSK",             "B"),
    "paymentremittances@merck.com":  ("Merck",           "A"),
    "apat@bms.com":                  ("BMS",             "B"),
    "efss.front-office@bms.com":     ("BMS",             "B"),
    "apat via remittances":          ("BMS",             "B"),
    "smb.vendor.query":              ("Takeda",          "B"),
    "ach@vrtx.com":                  ("Vertex",          "B"),
    "rachel.chung@terraytx.com":     ("Terray Therapeutics", "B"),
    "abbviecdo@abbvie.com":          ("AbbVie",          "B"),
    "communications@ramp.com":       ("Ramp",            "A"),
}

BODY_PAYOR_MAP = {
    "mrl san francisco":             "Merck",
    "merck sharp":                   "Merck",
    "merck research":                "Merck",
    "vertex pharmaceuticals incorporated": "Vertex",
    "vertex pharmaceuticals europe": "Vertex",
    "ais operating":                 "AIS Operating",
    "neurocrine":                    "Neurocrine",
}


# ── Invoice extraction (RI- and CN- prefixes) ─────────────────────────────────

def extract_invoices(text: str) -> list:
    return list(dict.fromkeys(re.findall(r'(?:RI|CN)-\d{7,12}', text)))


# ── Validation — all three required ──────────────────────────────────────────

def is_complete(data: dict) -> tuple[bool, str]:
    """
    Returns (True, "") if amount + payor + invoices all present.
    Returns (False, reason) if anything missing.
    """
    if not data:
        return False, "no data extracted"
    amount   = str(data.get("amount", "")).strip()
    payor    = (data.get("payorShort") or data.get("payor") or "").strip()
    invoices = data.get("invoices", [])

    if not amount or amount == "0":
        return False, "amount not found"
    try:
        amt = float(amount.replace(",", ""))
        if amt < AMOUNT_MIN or amt > AMOUNT_MAX:
            return False, f"amount ${amt:,.2f} outside expected range"
    except ValueError:
        return False, "amount not parseable"
    if not payor or payor in ("Unknown", "extract_from_subject", "extract_from_body", "extract_from_pdf"):
        return False, "payor not identified"
    if not invoices:
        return False, "no invoice numbers found (RI- or CN-) — contact payor billing team"
    return True, ""


# ── Smart process: try attachment → try body → flag ──────────────────────────

def smart_extract(email: dict, pdf_bytes: bytes | None, body_text: str) -> tuple[dict | None, bytes | None, str]:
    """
    Try every available source to get complete payment data.
    Returns (data, pdf_bytes_to_save, fail_reason)
    - If pdf_bytes_to_save is not None, save those bytes directly
    - If pdf_bytes_to_save is None but data is not None, generate PDF from data
    - If data is None, flag with fail_reason
    """
    sender  = email.get("sender", "")
    subject = email.get("subject", "")

    # ── Try attachment first if available ─────────────────────────────────────
    if pdf_bytes:
        data = extract_track_b(pdf_bytes, sender)
        # Supplement missing invoices from body
        if data and not data.get("invoices"):
            data["invoices"] = extract_invoices(body_text + " " + subject)
        ok, reason = is_complete(data)
        if ok:
            return data, pdf_bytes, ""
        # Attachment failed — try body before giving up
        body_data = extract_track_a(body_text, subject, sender)
        if body_data and not body_data.get("invoices"):
            body_data["invoices"] = extract_invoices(body_text + " " + subject)
        ok2, reason2 = is_complete(body_data)
        if ok2:
            # Body worked — generate PDF from body data (no attachment bytes)
            return body_data, None, ""
        # Both failed — use best reason
        return None, None, reason if reason else reason2

    # ── No attachment — try body ───────────────────────────────────────────────
    data = extract_track_a(body_text, subject, sender)
    if data and not data.get("invoices"):
        data["invoices"] = extract_invoices(body_text + " " + subject)
    ok, reason = is_complete(data)
    if ok:
        return data, None, ""
    return None, None, reason


# ── Track A extraction (body text) ────────────────────────────────────────────

def extract_track_a(body_text: str, subject: str, sender: str) -> Optional[dict]:
    sender_l = sender.lower()
    result = {
        "payor":       "",
        "payorShort":  "",
        "amount":      "",
        "currency":    "USD",
        "invoices":    [],
        "paymentDate": "",
        "confidence":  "low",
    }

    result["invoices"] = extract_invoices(body_text + " " + subject)

    # ── Ariba scheduled payment ────────────────────────────────────────────────
    if re.search(r"new scheduled payment|scheduled payment", subject + " " + body_text[:200], re.I):
        m = re.search(r"by\s+([A-Z][^\r\n]+?)[\r\n]", body_text, re.M)
        if m:
            result["payor"]      = m.group(1).strip()
            result["payorShort"] = m.group(1).strip()
        m2 = re.search(r"Amount due[^$]*\$([\d,]+\.\d{2})\s*(USD|GBP|EUR)?", body_text, re.I)
        if not m2:
            m2 = re.search(r"\$([\d,]{4,}\.\d{2})\s*(USD|GBP|EUR)", body_text, re.I)
        if m2:
            result["amount"]   = m2.group(1).replace(",", "")
            result["currency"] = m2.group(2) or "USD"
        m3 = re.search(r"Scheduled payment date\s*[\r\n]+\s*([^\r\n]+)", body_text, re.I)
        if m3:
            result["paymentDate"] = m3.group(1).strip()
        if result["amount"] and result["payorShort"]:
            result["confidence"] = "high"
        return result

    # ── Merck ──────────────────────────────────────────────────────────────────
    if "paymentremittances@merck.com" in sender_l:
        m = re.search(r"Payor Name[:\s]+([^\n<]+)", body_text, re.I)
        if m:
            raw = m.group(1).strip()
            result["payor"]      = raw
            result["payorShort"] = _map_body_payor(raw)
        m = re.search(r"Payment Amount[:\s]+\$?([\d,]+\.?\d*)", body_text, re.I)
        if m:
            result["amount"] = m.group(1).replace(",", "")
        m = re.search(r"Payment Date[:\s]+([\d/\-]+)", body_text, re.I)
        if m:
            result["paymentDate"] = m.group(1).strip()
        if result["amount"] and result["payorShort"]:
            result["confidence"] = "high"
        return result

    # ── Ramp ──────────────────────────────────────────────────────────────────
    if re.search(r"payment delivered for|payment received:|ramp has processed|is on the way|sent payment for", subject + " " + body_text[:200], re.I):
        m = re.search(r"from\s+(.+?)(?:,?\s*(?:Inc|LLC|Corp|Ltd)\.?\s*$|\.?\s*$)", subject, re.I)
        if not m:
            m = re.search(r"(?:from|for)\s+([A-Z][^\r\n,]+?)(?:\s+for\s+RI|\s+is\s+on|\s+sent)", subject, re.I)
        if m:
            raw = re.sub(r",?\s*(Inc|LLC|Corp|Ltd)\.?$", "", m.group(1), flags=re.I).strip()
            result["payor"]      = raw
            result["payorShort"] = raw
        m2 = re.search(r"Payment amount[^\n]*\n\$?\s*([\d,]+\.?\d*)", body_text, re.I)
        if not m2:
            m2 = re.search(r"\$\s*([\d,]+\.\d{2})", body_text)
        if m2:
            result["amount"] = m2.group(1).replace(",", "")
        if result["amount"] and result["payorShort"]:
            result["confidence"] = "high"
        return result

    # ── BILL.com delayed / deposited ──────────────────────────────────────────
    if re.search(r"payment is delayed|will be deposited|payment from|initiated a payment", subject + " " + body_text[:300], re.I):
        m = re.search(r"^\r?\n?([^\r\n]+?)\s+initiated a payment of", body_text, re.I | re.MULTILINE)
        if not m:
            m2 = re.search(r"payment from\s+(.+?)(?:\s+will|\s+is|\s+has|$)", subject, re.I)
            if m2:
                result["payor"]      = m2.group(1).strip()
                result["payorShort"] = m2.group(1).strip()
        else:
            payor = re.sub(r"^\*+|\*+$", "", m.group(1)).strip()
            result["payor"]      = payor
            result["payorShort"] = payor
        m3 = re.search(r"initiated a payment of[\r\n\s]+\$?\s*([\d,]+\.?\d*)", body_text, re.I)
        if not m3:
            m3 = re.search(r"\$\s*([\d,]+\.\d{2})", body_text)
        if m3:
            result["amount"] = m3.group(1).replace(",", "")
        m4 = re.search(r"Arriving:\s+([^\r\n]+)", body_text, re.I)
        if m4:
            result["paymentDate"] = m4.group(1).strip()
        if result["amount"] and result["payorShort"]:
            result["confidence"] = "high"
        return result

    # ── Coupa (check BEFORE BILL arriving — subject overlaps) ─────────────────
    if re.search(r"has sent you a|coupahost", subject + " " + body_text[:300], re.I) or "coupahost.com" in sender_l or "neurocrine" in subject.lower():
        m = re.search(r"^([A-Z][^\r\n]+?)\s+has sent you a", body_text, re.I | re.MULTILINE)
        if not m:
            m = re.search(r"^([A-Z][^\r\n]+?)\s+has sent you a", subject, re.I | re.MULTILINE)
        if m:
            result["payor"]      = m.group(1).strip()
            result["payorShort"] = m.group(1).strip()
        elif "neurocrine" in subject.lower():
            result["payor"]      = "Neurocrine Biosciences"
            result["payorShort"] = "Neurocrine"
        m2 = re.search(r"has sent you a (?:payment of )?([\d,]+\.?\d*)\s*(USD|GBP|EUR)?", body_text + " " + subject, re.I)
        if not m2:
            m2 = re.search(r"\$\s*([\d,]+\.\d{2})", body_text)
        if m2:
            result["amount"]   = m2.group(1).replace(",", "")
            result["currency"] = (m2.group(2) if m2.lastindex and m2.lastindex >= 2 else None) or "USD"
        if result["amount"] and result["payorShort"]:
            result["confidence"] = "high"
        return result

    # ── BILL "sent you a payment arriving" / "Sent a payment of" ─────────────
    if re.search(r"sent you a payment|Sent a payment of", subject + " " + body_text[:100], re.I):
        m = re.search(r"^(.+?)\s+sent you a payment", subject, re.I)
        if m:
            result["payor"]      = m.group(1).strip()
            result["payorShort"] = m.group(1).strip()
        if not result["payor"]:
            m = re.search(r"^([^\r\n]+?)\s+(?:Sent|initiated) a payment of", body_text, re.I | re.MULTILINE)
            if m:
                result["payor"]      = m.group(1).strip()
                result["payorShort"] = m.group(1).strip()
        m2 = re.search(r"(?:initiated|Sent) a payment of[\r\n\s]*\$?\s*([\d,]+\.?\d*)", body_text, re.I)
        if not m2:
            m2 = re.search(r"\$\s*([\d,]+\.\d{2})", body_text)
        if m2:
            result["amount"] = m2.group(1).replace(",", "")
        m3 = re.search(r"Arriving[:\s]+([^\r\n]+)", body_text, re.I)
        if not m3:
            m3 = re.search(r"Deposit date[:\s]+([^\r\n]+)", body_text, re.I)
        if m3:
            result["paymentDate"] = m3.group(1).strip()
        if result["amount"] and result["payorShort"]:
            result["confidence"] = "high"
        return result

    # ── Generic fallback ──────────────────────────────────────────────────────
    m = re.search(r"\$\s*([\d,]+\.?\d*)", body_text + " " + subject)
    if m:
        result["amount"] = m.group(1).replace(",", "")
    return result


def _map_body_payor(raw: str) -> str:
    raw_l = raw.lower()
    for key, short in BODY_PAYOR_MAP.items():
        if key in raw_l:
            return short
    return raw.strip()


# ── Ariba body extraction ─────────────────────────────────────────────────────

def extract_ariba_meta(body_text: str) -> dict:
    result = {"payor": "", "payorShort": "", "adviceNum": "", "url": "", "invoices": []}
    m = re.search(r"Customer:\s*([^\n]+)", body_text, re.I)
    if m:
        result["payor"]      = m.group(1).strip()
        result["payorShort"] = m.group(1).strip()
    m = re.search(r"Remittance Advice #:\s*([^\n]+)", body_text, re.I)
    if m:
        result["adviceNum"] = m.group(1).strip()
    m = re.search(r"(https://service\.ariba\.com/Supplier\.aw/ad/documentDetail[^\s]+)", body_text)
    if m:
        result["url"] = m.group(1).strip()
    return result


# ── Track B extraction (PDF bytes via pdfplumber) ─────────────────────────────

def extract_track_b(pdf_bytes: bytes, sender: str) -> Optional[dict]:
    try:
        import pdfplumber, io
        text = ""
        with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf:
            for page in pdf.pages:
                text += (page.extract_text() or "") + "\n"
    except Exception:
        return None

    sender_l = sender.lower()
    result = {
        "payor": "", "payorShort": "", "amount": "",
        "currency": "USD", "invoices": [], "paymentDate": "",
        "rawText": text[:2000], "confidence": "low",
    }

    result["invoices"] = extract_invoices(text)

    if "£" in text or "GBP" in text:
        result["currency"] = "GBP"
    elif "€" in text or "EUR" in text:
        result["currency"] = "EUR"

    for key, (short, _) in SENDER_MAP.items():
        if key in sender_l:
            result["payorShort"] = short
            result["payor"]      = short
            break

    if "erppayables@gilead.com" in sender_l:
        m = re.search(r"Payer Name[:\s]+([^\n]+)", text, re.I)
        if m:
            result["payor"] = m.group(1).strip()
        amounts = re.findall(r"[\$£]?\s*([\d,]+\.\d{2})", text)
        if amounts:
            result["amount"] = amounts[-1].replace(",", "")
        m = re.search(r"Payment Date[:\s]+([\d/\-]+)", text, re.I)
        if m:
            result["paymentDate"] = m.group(1)

    elif "gsk.com" in sender_l or "bio.finance" in sender_l:
        amounts = re.findall(r"[\$£]?\s*([\d,]+\.\d{2})", text)
        if amounts:
            try:
                result["amount"] = max(amounts, key=lambda x: float(x.replace(",", ""))).replace(",", "")
            except Exception:
                pass

    elif "bms.com" in sender_l:
        amounts = re.findall(r"[\$£]?\s*([\d,]+\.\d{2})", text)
        if amounts:
            try:
                result["amount"] = max(amounts, key=lambda x: float(x.replace(",", ""))).replace(",", "")
            except Exception:
                pass

    elif "smb.vendor.query" in sender_l:
        m = re.search(r"Total[:\s]+[\$£]?\s*([\d,]+\.\d{2})", text, re.I)
        if m:
            result["amount"] = m.group(1).replace(",", "")
        else:
            amounts = re.findall(r"[\$£]?\s*([\d,]+\.\d{2})", text)
            if amounts:
                result["amount"] = amounts[-1].replace(",", "")

    elif "vrtx.com" in sender_l:
        m = re.search(r"From Payer[:\s]+([^\n]+)", text, re.I)
        if m:
            raw = m.group(1).strip()
            result["payor"]      = raw
            result["payorShort"] = _map_body_payor(raw)
        amounts = re.findall(r"[\$£]?\s*([\d,]+\.\d{2})", text)
        if amounts:
            result["amount"] = amounts[-1].replace(",", "")

    else:
        amounts = re.findall(r"[\$£]?\s*([\d,]+\.\d{2})", text)
        if amounts:
            try:
                result["amount"] = max(amounts, key=lambda x: float(x.replace(",", ""))).replace(",", "")
            except Exception:
                pass

    if result["amount"]:
        try:
            amt = float(result["amount"])
            if AMOUNT_MIN <= amt <= AMOUNT_MAX:
                result["confidence"] = "high" if result["payorShort"] else "medium"
        except ValueError:
            pass

    return result


# ── Filename builder ──────────────────────────────────────────────────────────

def build_filename(data: dict) -> str:
    try:
        amt = float(str(data.get("amount", "0")).replace(",", ""))
        amt_str = f"${amt:,.2f}"
    except (ValueError, TypeError):
        amt_str = "$0.00"
    payor    = data.get("payorShort") or data.get("payor") or "Unknown"
    currency = data.get("currency", "USD")
    if currency != "USD":
        return f"{amt_str} {payor} {currency}.pdf"
    return f"{amt_str} {payor}.pdf"


def safe_filename(name: str) -> str:
    return re.sub(r'[<>:"/\\|?*]', '', name)


def dedupe_filename(filename: str, staging_path: str, existing_invoices: list) -> tuple:
    base, ext = os.path.splitext(filename)
    candidate = filename
    n = 2
    meta_dir = os.path.join(staging_path, ".meta")
    while os.path.exists(os.path.join(staging_path, candidate)):
        meta_path = os.path.join(meta_dir, candidate + ".meta.json")
        if os.path.exists(meta_path):
            try:
                with open(meta_path) as f:
                    meta = json.load(f)
                existing_inv = set(meta.get("invoices", []))
                new_inv      = set(existing_invoices)
                if existing_inv and new_inv and existing_inv == new_inv:
                    return candidate, True
            except Exception:
                pass
        candidate = f"{base}_{n}{ext}"
        n += 1
    return candidate, False


# ── PDF generation (Track A body-only) ───────────────────────────────────────

def generate_pdf(output_path: str, data: dict, email: dict) -> str:
    from reportlab.lib.pagesizes import letter
    from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
    from reportlab.lib.units import inch
    from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, HRFlowable
    from reportlab.lib import colors
    from reportlab.lib.enums import TA_CENTER

    doc = SimpleDocTemplate(output_path, pagesize=letter,
        rightMargin=0.75*inch, leftMargin=0.75*inch,
        topMargin=0.75*inch, bottomMargin=0.75*inch)
    styles = getSampleStyleSheet()
    h1  = ParagraphStyle('H1',  parent=styles['Normal'], fontSize=18, fontName='Helvetica-Bold', spaceAfter=4)
    sub = ParagraphStyle('Sub', parent=styles['Normal'], fontSize=10, textColor=colors.HexColor('#666666'), spaceAfter=16)
    lbl = ParagraphStyle('Lbl', parent=styles['Normal'], fontSize=9,  fontName='Helvetica-Bold', textColor=colors.HexColor('#444444'))
    val = ParagraphStyle('Val', parent=styles['Normal'], fontSize=11, spaceAfter=10)
    amt = ParagraphStyle('Amt', parent=styles['Normal'], fontSize=22, fontName='Helvetica-Bold', spaceAfter=4)
    inv = ParagraphStyle('Inv', parent=styles['Normal'], fontSize=10, fontName='Courier')
    ftr = ParagraphStyle('Ftr', parent=styles['Normal'], fontSize=8,  textColor=colors.HexColor('#999999'), alignment=TA_CENTER)

    currency = data.get("currency", "USD")
    try:
        raw_amt = float(str(data.get("amount", "0")).replace(",", ""))
        amt_str = f"${raw_amt:,.2f}"
        if currency != "USD":
            amt_str += f" {currency}"
    except (ValueError, TypeError):
        amt_str = "$0.00"

    story = [
        Paragraph("Payment Remittance Advice", h1),
        Paragraph("Science Exchange, Inc. — AR Operations", sub),
        HRFlowable(width="100%", thickness=1, color=colors.HexColor('#e0e0e0')),
        Spacer(1, 16),
        Paragraph("Payment Amount", lbl),
        Paragraph(amt_str, amt),
        HRFlowable(width="100%", thickness=0.5, color=colors.HexColor('#eeeeee')),
        Spacer(1, 12),
    ]
    for label, value in [
        ("Payor",        data.get("payor", "—")),
        ("Short Name",   data.get("payorShort", "—")),
        ("Currency",     currency),
        ("Payment Date", data.get("paymentDate") or "—"),
        ("Source",       email.get("sender", "—")),
        ("Subject",      email.get("subject", "—")),
        ("Thread ID",    email.get("threadId", "—")),
        ("Processed",    datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ")),
    ]:
        story += [Paragraph(label, lbl), Paragraph(str(value), val)]

    invoices = data.get("invoices", [])
    if invoices:
        story += [
            HRFlowable(width="100%", thickness=0.5, color=colors.HexColor('#eeeeee')),
            Spacer(1, 12),
            Paragraph(f"Invoices ({len(invoices)})", lbl),
            Spacer(1, 4),
        ]
        for inv_num in invoices:
            story.append(Paragraph(f"• {inv_num}", inv))
        story.append(Spacer(1, 16))

    story += [
        HRFlowable(width="100%", thickness=1, color=colors.HexColor('#e0e0e0')),
        Spacer(1, 8),
        Paragraph(
            "Generated by SE Remittance Agent · Science Exchange AR Operations · "
            "Not a substitute for the original remittance document",
            ftr
        ),
    ]
    doc.build(story)
    return output_path


def write_meta(staging_path: str, filename: str, data: dict, email: dict):
    meta = {
        "filename":  filename,
        "payor":     data.get("payorShort", ""),
        "amount":    data.get("amount", ""),
        "currency":  data.get("currency", "USD"),
        "invoices":  data.get("invoices", []),
        "sender":    email.get("sender", ""),
        "subject":   email.get("subject", ""),
        "threadId":  email.get("threadId", ""),
        "savedAt":   datetime.utcnow().isoformat() + "Z",
    }
    # Store meta in hidden .meta subfolder so staging only shows PDFs
    meta_dir = os.path.join(staging_path, ".meta")
    os.makedirs(meta_dir, exist_ok=True)
    with open(os.path.join(meta_dir, filename + ".meta.json"), "w") as f:
        json.dump(meta, f, indent=2)
