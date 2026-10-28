"""'Past' is judged in venue time, not the server's UTC clock.

Run:  python -m pytest tests
"""
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import app as app_module


def _frozen_at(utc: datetime):
    class FrozenDatetime(datetime):
        @classmethod
        def now(cls, tz=None):
            return utc.astimezone(tz) if tz else utc.replace(tzinfo=None)
    return FrozenDatetime


def _past_map(monkeypatch, utc_now, events):
    monkeypatch.setattr(app_module, "datetime", _frozen_at(utc_now))
    monkeypatch.setattr(app_module, "get_events", lambda *a: events)
    return app_module._group_past_map()


def test_event_later_today_is_not_past_on_a_utc_server(monkeypatch):
    # 16:00 UTC = 09:00 in Vancouver (PDT); the event ends at 14:20 local.
    events = [{"event_number": "195400", "date": "2026-10-28",
               "start_time": "12:00", "end_time": "14:20"}]
    past = _past_map(monkeypatch, datetime(2026, 10, 28, 16, 0, tzinfo=timezone.utc), events)
    assert past == {"#195400": False}


def test_event_is_past_once_it_ends_in_venue_time(monkeypatch):
    # 21:30 UTC = 14:30 in Vancouver, ten minutes after it ended.
    events = [{"event_number": "195400", "date": "2026-10-28",
               "start_time": "12:00", "end_time": "14:20"}]
    past = _past_map(monkeypatch, datetime(2026, 10, 28, 21, 30, tzinfo=timezone.utc), events)
    assert past == {"#195400": True}
