"""
SE Remittance Agent — Settings
Persistent config stored as JSON. Editable from the Settings panel.
"""

import json
import os

DEFAULT_SETTINGS = {
    "stagingPath":    r"C:\Users\Aron Hasofer\Desktop\Remittance_Agent\staging",
    "livePath":       r"G:\Shared drives\Finance\ACCOUNTING\AR\DAILY CASH RECEIPTS\remits not applied",
    "testMode":       True,
    "version":        "2.2.0",
    "updateCheckUrl": "https://raw.githubusercontent.com/aronhasofer-apps/se-remittance-agent/main/version.json",
    "gmailLabel":     "1. Accounts Receivable/Remittances",
    "agentLabel":     "Remittance Agent",
}


class Settings:
    def __init__(self, base_path: str):
        self.path = os.path.join(base_path, "settings.json")
        self._data = self._load()

    def _load(self) -> dict:
        if os.path.exists(self.path):
            try:
                with open(self.path) as f:
                    saved = json.load(f)
                    merged = dict(DEFAULT_SETTINGS)
                    merged.update(saved)
                    return merged
            except Exception:
                pass
        return dict(DEFAULT_SETTINGS)

    def save(self):
        os.makedirs(os.path.dirname(self.path), exist_ok=True)
        with open(self.path, "w") as f:
            json.dump(self._data, f, indent=2)

    def get(self, key: str, default=None):
        return self._data.get(key, default)

    def set(self, key: str, value):
        self._data[key] = value
        self.save()

    @property
    def staging_path(self) -> str:
        return self._data.get("stagingPath", DEFAULT_SETTINGS["stagingPath"])

    @property
    def live_path(self) -> str:
        return self._data.get("livePath", DEFAULT_SETTINGS["livePath"])

    @property
    def test_mode(self) -> bool:
        return self._data.get("testMode", True)

    @property
    def gmail_label(self) -> str:
        return self._data.get("gmailLabel", DEFAULT_SETTINGS["gmailLabel"])

    @property
    def agent_label(self) -> str:
        return self._data.get("agentLabel", DEFAULT_SETTINGS["agentLabel"])

    @property
    def current_version(self) -> str:
        return self._data.get("version", "2.1.0")

    @property
    def update_check_url(self) -> str:
        return self._data.get("updateCheckUrl", DEFAULT_SETTINGS["updateCheckUrl"])
