"""Analytics counts bookings the same way the calendar groups them.

Run:  python -m pytest tests
"""
from analytics import build_analytics


def _ev(number, name, date="2026-10-14"):
    return {"event_number": number, "event_name": name, "date": date,
            "room": "SWH 10081", "start_time": "09:00", "end_time": "10:00"}


def test_same_named_bookings_count_separately():
    # A weekly social booked three times, plus one booking spread over two rooms.
    events = [_ev("195400", "HIVE Social"), _ev("195401", "HIVE Social"),
              _ev("195402", "HIVE Social"),
              _ev("191346", "Convocation"), _ev("191346", "Convocation")]
    kpis = build_analytics(events)["data"]["All"]["kpis"]
    assert kpis["bookings"] == 4
