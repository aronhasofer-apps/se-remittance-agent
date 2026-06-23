"""
SE Remittance Agent — History & Queue Management
Run log, review queue, duplicate protection across runs.
"""

import json
import os
from datetime import datetime
from typing import Optional


class RunHistory:
    """Persistent log of every processing run."""

    def __init__(self, base_path: str):
        self.path = os.path.join(base_path, "run_history.json")
        self._data = self._load()

    def _load(self) -> list:
        if os.path.exists(self.path):
            try:
                with open(self.path) as f:
                    return json.load(f)
            except Exception:
                return []
        return []

    def _save(self):
        with open(self.path, "w") as f:
            json.dump(self._data, f, indent=2)

    def start_run(self) -> str:
        """Start a new run. Returns run_id."""
        run_id = datetime.utcnow().strftime("run_%Y%m%d_%H%M%S")
        run = {
            "runId": run_id,
            "startedAt": datetime.utcnow().isoformat() + "Z",
            "completedAt": None,
            "status": "running",
            "saved": [],
            "skipped": [],
            "flagged": [],
            "errors": [],
            "durationSeconds": None,
            "testMode": True,
        }
        self._data.insert(0, run)
        self._save()
        return run_id

    def update_run(self, run_id: str, **kwargs):
        for run in self._data:
            if run["runId"] == run_id:
                run.update(kwargs)
                break
        self._save()

    def finish_run(self, run_id: str, saved: list, skipped: list, flagged: list, errors: list):
        started = None
        for run in self._data:
            if run["runId"] == run_id:
                started = run.get("startedAt")
                break
        duration = None
        if started:
            try:
                s = datetime.fromisoformat(started.replace("Z", "+00:00"))
                duration = round((datetime.utcnow() - s.replace(tzinfo=None)).total_seconds(), 1)
            except Exception:
                pass
        self.update_run(
            run_id,
            completedAt=datetime.utcnow().isoformat() + "Z",
            status="complete",
            saved=saved,
            skipped=skipped,
            flagged=flagged,
            errors=errors,
            durationSeconds=duration,
        )

    def get_all_processed_thread_ids(self) -> set:
        """Return all threadIds processed successfully in past runs."""
        ids = set()
        for run in self._data:
            for item in run.get("saved", []):
                if isinstance(item, dict) and item.get("threadId"):
                    ids.add(item["threadId"])
        return ids

    def get_recent(self, n: int = 10) -> list:
        return self._data[:n]

    def get_last_run_summary(self) -> Optional[dict]:
        for run in self._data:
            if run.get("status") == "complete":
                return run
        return None


class ReviewQueue:
    """Flagged and low-confidence items waiting for manual review."""

    def __init__(self, base_path: str):
        self.path = os.path.join(base_path, "review_queue.json")
        self._data = self._load()

    def _load(self) -> list:
        if os.path.exists(self.path):
            try:
                with open(self.path) as f:
                    return json.load(f)
            except Exception:
                return []
        return []

    def _save(self):
        with open(self.path, "w") as f:
            json.dump(self._data, f, indent=2)

    def add(self, item: dict):
        item["addedAt"] = datetime.utcnow().isoformat() + "Z"
        item["resolved"] = False
        self._data.insert(0, item)
        self._save()

    def resolve(self, index: int):
        if 0 <= index < len(self._data):
            self._data[index]["resolved"] = True
            self._data[index]["resolvedAt"] = datetime.utcnow().isoformat() + "Z"
            self._save()

    def get_unresolved(self) -> list:
        return [i for i in self._data if not i.get("resolved")]

    def get_all(self) -> list:
        return self._data

    def count_unresolved(self) -> int:
        return sum(1 for i in self._data if not i.get("resolved"))
