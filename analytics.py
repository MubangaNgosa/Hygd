"""
Analytics aggregation for Hygd events.

Pure functions that turn the flat list of event rows (as returned by
`database.get_events()`) into the summary numbers the analytics page draws.

Events are bucketed into SFU semesters. SFU runs a three-term academic year:
    Fall    — September–December
    Spring  — January–April
    Summer  — May–August
(https://www.sfu.ca/students/calendar/). Because Hygd events are room bookings
that can land on any calendar day — including the weeks before a term's classes
start — semesters are split on calendar-month boundaries rather than the
first/last day of instruction, so every date buckets cleanly and predictably.
"""

import re
from collections import Counter, defaultdict

# ── Semesters ──────────────────────────────────────────────────────────────────

# month (1-12) → (term name, term-order within the year)
_TERM_BY_MONTH = {
    1: ("Spring", 0), 2: ("Spring", 0), 3: ("Spring", 0), 4: ("Spring", 0),
    5: ("Summer", 1), 6: ("Summer", 1), 7: ("Summer", 1), 8: ("Summer", 1),
    9: ("Fall", 2), 10: ("Fall", 2), 11: ("Fall", 2), 12: ("Fall", 2),
}


def semester_of(date_str: str) -> tuple[str, int] | None:
    """'2026-10-14' → ('Fall 2026', sort_key). None if the date is unusable."""
    if not date_str or len(date_str) < 7:
        return None
    try:
        year = int(date_str[0:4])
        month = int(date_str[5:7])
    except ValueError:
        return None
    term = _TERM_BY_MONTH.get(month)
    if not term:
        return None
    name, order = term
    return f"{name} {year}", year * 10 + order


# ── Department bucketing (single source of truth, shared with app.py) ───────────

def dept_category(department: str, service_type: str) -> str:
    """Bucket a raw department/service label into a small filterable set."""
    d = (department or "").lower()
    s = (service_type or "").lower()
    if "facilit" in d:
        return "Facilities"
    if "audio" in d or "a/v" in d or "sfu live" in d or "av" == s.strip():
        return "AV / Production"
    if "security" in d:
        return "Security"
    if "food" in d or "beverage" in d or "cater" in d:
        return "Catering"
    if "parking" in d:
        return "Parking"
    if "event services" in d or "event service" in d:
        return "Event Services"
    if department:
        return department  # keep any other named provider as its own bucket
    return "General"


# ── Small parsing helpers ───────────────────────────────────────────────────────

_PPL_RE = re.compile(r"(\d+)")
_WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
_MONTH_ABBR = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun",
               "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]


def _attendance_int(att: str) -> int | None:
    """'300 PPL' → 300 ; '' → None."""
    if not att:
        return None
    m = _PPL_RE.search(str(att))
    return int(m.group(1)) if m else None


def _building_of(room: str) -> str:
    """First token of a room string is its building code. 'SWH 10081' → 'SWH'."""
    room = (room or "").strip()
    if not room:
        return "—"
    return room.split()[0]


def _duration_minutes(start: str, end: str) -> int | None:
    """Minutes between two 'HH:MM' times, same day. None if unparseable/degenerate."""
    def _mins(t: str) -> int | None:
        if not t or ":" not in t:
            return None
        try:
            h, m = t.split(":")[:2]
            return int(h) * 60 + int(m)
        except ValueError:
            return None
    a, b = _mins(start), _mins(end)
    if a is None or b is None:
        return None
    d = b - a
    return d if d > 0 else None


def _weekday(date_str: str) -> int | None:
    """0=Mon … 6=Sun for a 'YYYY-MM-DD' date (Zeller-free, via datetime)."""
    try:
        from datetime import date
        y, m, d = int(date_str[0:4]), int(date_str[5:7]), int(date_str[8:10])
        return date(y, m, d).weekday()
    except (ValueError, TypeError):
        return None


def _booking_key(e: dict) -> str:
    """Stable key identifying one client booking (mirrors app._group_key):
    event name, else booking number from the onsite contact, else room+date."""
    name = (e.get("event_name") or "").strip()
    if name:
        return name.lower()
    contact = (e.get("onsite_contact") or "").strip()
    m = re.search(r"#(\d+)", contact)
    if m:
        return f"#{m.group(1)}"
    return f"{e.get('room', 'unknown')}|{e.get('date', '')}"


def _norm_item(item: str) -> str:
    """Normalise a setup-item label for grouping: first line, collapsed spaces."""
    first = (item or "").split("\n")[0]
    return re.sub(r"\s+", " ", first).strip()


def _qty_of(qty: str) -> float:
    """'13.0 EA' / '2 HR' → 13.0 / 2.0. Best-effort; 0 on failure."""
    m = re.search(r"[\d.]+", str(qty or ""))
    try:
        return float(m.group(0)) if m else 0.0
    except ValueError:
        return 0.0


def _top(counter: Counter, n: int) -> list[dict]:
    return [{"label": k, "count": v} for k, v in counter.most_common(n)]


# ── Per-semester aggregation ────────────────────────────────────────────────────

def _empty_agg() -> dict:
    return {
        "total": 0, "active": 0, "cancelled": 0,
        "bookings": set(),
        "att_sum": 0, "att_n": 0, "att_peak": 0,
        "dur_sum": 0, "dur_n": 0,
        "with_layout": 0, "with_notes": 0,
        "dept": Counter(), "building": Counter(), "room": Counter(),
        "service": Counter(), "weekday": Counter(), "month": Counter(),
        "hour": Counter(), "coordinator": Counter(), "onsite": Counter(),
        "item_count": Counter(), "item_qty": Counter(),
        "att_by_dept": Counter(), "day_count": Counter(),
        "top_events": [],   # (attendance, name, room, date)
    }


def _accumulate(agg: dict, e: dict) -> None:
    agg["total"] += 1
    cancelled = (e.get("status") or "active") == "cancelled"
    if cancelled:
        agg["cancelled"] += 1
    else:
        agg["active"] += 1

    agg["bookings"].add(_booking_key(e))

    cat = dept_category(e.get("department", ""), e.get("service_type", ""))
    agg["dept"][cat] += 1

    room = (e.get("room") or "").strip()
    if room:
        agg["room"][room] += 1
        agg["building"][_building_of(room)] += 1

    svc = (e.get("service_type") or "").strip()
    if svc:
        agg["service"][svc] += 1

    att = _attendance_int(e.get("attendance", ""))
    if att is not None:
        agg["att_sum"] += att
        agg["att_n"] += 1
        agg["att_peak"] = max(agg["att_peak"], att)
        agg["att_by_dept"][cat] += att
        agg["top_events"].append(
            (att, e.get("event_name") or room or "—", room, e.get("date", ""))
        )

    dur = _duration_minutes(e.get("start_time", ""), e.get("end_time", ""))
    if dur is not None:
        agg["dur_sum"] += dur
        agg["dur_n"] += 1

    date = e.get("date", "")
    wd = _weekday(date)
    if wd is not None:
        agg["weekday"][wd] += 1
    if date:
        agg["day_count"][date] += 1
        try:
            agg["month"][int(date[5:7])] += 1
        except (ValueError, IndexError):
            pass

    start = e.get("start_time", "")
    if start and ":" in start:
        try:
            agg["hour"][int(start.split(":")[0])] += 1
        except ValueError:
            pass

    coord = (e.get("mecs_contact") or "").strip()
    if coord:
        agg["coordinator"][coord] += 1
    onsite = re.sub(r"\s*#\d+", "", (e.get("onsite_contact") or "")).strip()
    if onsite:
        agg["onsite"][onsite] += 1

    if (e.get("layout_image") or "").strip():
        agg["with_layout"] += 1
    if e.get("note_count", 0):
        agg["with_notes"] += 1

    for it in e.get("setup_items", []) or []:
        label = _norm_item(it.get("item", "")) if isinstance(it, dict) else _norm_item(str(it))
        if not label:
            continue
        agg["item_count"][label] += 1
        if isinstance(it, dict):
            agg["item_qty"][label] += _qty_of(it.get("qty", ""))


def _finalize(agg: dict) -> dict:
    total = agg["total"]
    att_n = agg["att_n"]
    dur_n = agg["dur_n"]
    weekday = [{"label": _WEEKDAYS[i], "count": agg["weekday"].get(i, 0)} for i in range(7)]
    months = [
        {"label": _MONTH_ABBR[m], "count": agg["month"].get(m, 0)}
        for m in range(1, 13) if agg["month"].get(m, 0)
    ]
    hours = [{"label": f"{h:02d}:00", "count": agg["hour"].get(h, 0)}
             for h in range(24) if agg["hour"].get(h, 0)]

    top_events = sorted(agg["top_events"], key=lambda t: t[0], reverse=True)[:10]
    busiest = sorted(agg["day_count"].items(), key=lambda kv: kv[1], reverse=True)[:10]

    item_rows = []
    for label, cnt in agg["item_count"].most_common(20):
        item_rows.append({
            "label": label,
            "count": cnt,
            "qty": round(agg["item_qty"].get(label, 0), 1),
        })

    return {
        "kpis": {
            "total": total,
            "active": agg["active"],
            "cancelled": agg["cancelled"],
            "cancel_rate": round(agg["cancelled"] / total * 100, 1) if total else 0,
            "bookings": len(agg["bookings"]),
            "att_total": agg["att_sum"],
            "att_avg": round(agg["att_sum"] / att_n) if att_n else 0,
            "att_peak": agg["att_peak"],
            "rooms": len([r for r in agg["room"]]),
            "buildings": len([b for b in agg["building"]]),
            "dur_avg": round(agg["dur_sum"] / dur_n) if dur_n else 0,
            "with_layout": agg["with_layout"],
            "with_notes": agg["with_notes"],
        },
        "dept": _top(agg["dept"], 12),
        "building": _top(agg["building"], 12),
        "room": _top(agg["room"], 12),
        "service": _top(agg["service"], 10),
        "weekday": weekday,
        "month": months,
        "hour": hours,
        "items": item_rows,
        "att_by_dept": _top(agg["att_by_dept"], 10),
        "coordinators": _top(agg["coordinator"], 10),
        "onsite": _top(agg["onsite"], 10),
        "busiest_days": [{"label": d, "count": c} for d, c in busiest],
        "top_events": [
            {"attendance": a, "name": n, "room": r, "date": d}
            for (a, n, r, d) in top_events
        ],
    }


def build_analytics(events: list[dict]) -> dict:
    """Aggregate every event into an 'All' bucket and one bucket per semester.

    Returns:
        {
          "semesters": [ {"key": "Fall 2026", "count": N}, ... ]  # newest first
          "data": { "All": {...}, "Fall 2026": {...}, ... }
        }
    """
    buckets: dict[str, dict] = defaultdict(_empty_agg)
    sem_sort: dict[str, int] = {}
    all_agg = _empty_agg()

    for e in events:
        _accumulate(all_agg, e)
        sem = semester_of(e.get("date", ""))
        key = sem[0] if sem else "Undated"
        if sem:
            sem_sort[key] = sem[1]
        else:
            sem_sort.setdefault(key, -1)
        _accumulate(buckets[key], e)

    # newest semester first; "Undated" (sort -1) sinks to the bottom
    ordered = sorted(buckets.keys(), key=lambda k: sem_sort.get(k, -1), reverse=True)

    data = {"All": _finalize(all_agg)}
    semesters = [{"key": "All", "count": all_agg["total"]}]
    for key in ordered:
        data[key] = _finalize(buckets[key])
        semesters.append({"key": key, "count": buckets[key]["total"]})

    return {"semesters": semesters, "data": data}
