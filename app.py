"""
Hygd — event & room schedule. Flask application.

Start locally:   python app.py
Production:      gunicorn -w 2 -b 0.0.0.0:5000 app:app
"""

import os
import re
from datetime import datetime

from dotenv import load_dotenv
from flask import Flask, jsonify, render_template, request, send_from_directory

load_dotenv()

from analytics import build_analytics
from analytics import dept_category as _dept_category
from database import (add_note, count_events_in_range, delete_all_events,
                      delete_event, delete_events_in_range, delete_note,
                      get_event_by_id, get_events, get_notes, get_stats,
                      init_db, save_events, set_event_hidden,
                      set_events_hidden, set_event_progress, update_note)
from parser import extract_and_parse_pdf

app = Flask(__name__)
app.config["UPLOAD_FOLDER"] = "uploads"
app.config["MAX_CONTENT_LENGTH"] = 50 * 1024 * 1024  # 50 MB

os.makedirs(app.config["UPLOAD_FOLDER"], exist_ok=True)
init_db()


# ── Pages ────────────────────────────────────────────────────────────────────

@app.route("/")
def index():
    return render_template("index.html")


@app.route("/analytics")
def analytics_page():
    return render_template("analytics.html")


@app.route("/layouts/<path:filename>")
def layout_image(filename):
    """Serve an extracted room-layout diagram image."""
    layout_dir = os.path.join(app.config["UPLOAD_FOLDER"], "layouts")
    return send_from_directory(layout_dir, filename)


# ── Upload ───────────────────────────────────────────────────────────────────

@app.route("/upload", methods=["POST"])
def upload():
    if "file" not in request.files:
        return jsonify({"error": "No file provided"}), 400

    file = request.files["file"]
    if not file.filename:
        return jsonify({"error": "Empty filename"}), 400
    if not file.filename.lower().endswith(".pdf"):
        return jsonify({"error": "Only PDF files are supported"}), 400

    dest = os.path.join(app.config["UPLOAD_FOLDER"], file.filename)
    file.save(dest)

    try:
        events = extract_and_parse_pdf(dest, file.filename)
        new_count, updated_count, cancelled_count, skipped_count = save_events(events)

        # Nothing changed — all events are byte-for-byte identical to what's stored
        if new_count == 0 and updated_count == 0 and cancelled_count == 0:
            return jsonify({
                "success": True,
                "no_changes": True,
                "message": (
                    f"No changes — all {skipped_count} event"
                    f"{'s' if skipped_count != 1 else ''} in this PDF are already up to date."
                ),
            })

        # Build a human-readable summary
        parts = []
        if new_count:
            parts.append(f"{new_count} new event{'s' if new_count != 1 else ''} added")
        if updated_count:
            parts.append(f"{updated_count} event{'s' if updated_count != 1 else ''} updated")
        if cancelled_count:
            parts.append(f"{cancelled_count} marked as cancelled")
        if skipped_count:
            parts.append(f"{skipped_count} already up to date")

        return jsonify({
            "success": True,
            "new":       new_count,
            "updated":   updated_count,
            "cancelled": cancelled_count,
            "skipped":   skipped_count,
            "message":   " · ".join(parts),
        })
    except Exception as exc:
        return jsonify({"error": f"Parsing failed: {exc}"}), 500


# ── Events API ────────────────────────────────────────────────────────────────

@app.route("/api/events")
def api_events():
    start = request.args.get("start")
    end = request.args.get("end")
    raw = get_events(start, end)
    past_map = _group_past_map()

    fc_events = []
    for e in raw:
        start_iso = _iso(e["date"], e.get("start_time", ""))
        end_iso = _iso(e["date"], e.get("end_time", ""))
        group_key = _group_key(e)
        fc_events.append({
            "id": str(e["id"]),
            "title": e.get("event_name") or f"{e.get('room', '')} – {e.get('service_type', '')}",
            "start": start_iso,
            "end": end_iso or None,
            "extendedProps": {
                "event_number":   e.get("event_number", ""),
                "room":           e.get("room", ""),
                "service_type":   e.get("service_type", ""),
                "onsite_contact": e.get("onsite_contact", ""),
                "mecs_contact":   e.get("mecs_contact", ""),
                "setup_items":    e.get("setup_items", []),
                "notes":          e.get("notes", ""),
                "pdf_source":     e.get("pdf_source", ""),
                "attendance":     e.get("attendance", ""),
                "department":     e.get("department", ""),
                "dept_category":  _dept_category(e.get("department", ""), e.get("service_type", "")),
                "layout_image":   e.get("layout_image", ""),
                "layout_images":  e.get("layout_images", []),
                "checked_items":  e.get("checked_items", []),
                "assistant_note": e.get("assistant_note", ""),
                "group_key":      group_key,
                "status":         e.get("status", "active"),
                "updated_at":     e.get("updated_at", ""),
                "note_count":     e.get("note_count", 0),
                "hidden":         bool(e.get("hidden", 0)),
                "group_past":     past_map.get(group_key, False),
            },
        })

    return jsonify(fc_events)


@app.route("/api/events/<int:event_id>")
def api_event_detail(event_id):
    event = get_event_by_id(event_id)
    if event:
        return jsonify(event)
    return jsonify({"error": "Not found"}), 404


@app.route("/api/events/<int:event_id>", methods=["DELETE"])
def api_delete_event(event_id):
    delete_event(event_id)
    return jsonify({"success": True})


@app.route("/api/events/<int:event_id>/progress", methods=["POST"])
def api_event_progress(event_id):
    """Save an event assistant's checklist ticks and/or free-text note."""
    data = request.get_json(silent=True) or {}

    checked = data.get("checked_items")
    if checked is not None:
        if not isinstance(checked, list):
            return jsonify({"error": "checked_items must be a list"}), 400
        checked = sorted({int(i) for i in checked
                          if isinstance(i, (int, float)) and int(i) >= 0})

    note = data.get("assistant_note")
    if note is not None:
        note = str(note)[:5000]

    if checked is None and note is None:
        return jsonify({"error": "nothing to update"}), 400

    if not set_event_progress(event_id, checked, note):
        return jsonify({"error": "event not found"}), 404
    return jsonify({"success": True})


# ── Notes API (append-only, attributed, edit/delete limited to author) ─────────

_MAX_AUTHOR = 60
_MAX_NOTE   = 5000


def _author(data: dict) -> str:
    return str(data.get("author", "")).strip()[:_MAX_AUTHOR]


@app.route("/api/events/<int:event_id>/notes")
def api_get_notes(event_id):
    return jsonify(get_notes(event_id))


@app.route("/api/events/<int:event_id>/notes", methods=["POST"])
def api_add_note(event_id):
    if not get_event_by_id(event_id):
        return jsonify({"error": "event not found"}), 404
    data   = request.get_json(silent=True) or {}
    author = _author(data)
    text   = str(data.get("text", "")).strip()[:_MAX_NOTE]
    if not author:
        return jsonify({"error": "author required"}), 400
    if not text:
        return jsonify({"error": "text required"}), 400
    return jsonify(add_note(event_id, author, text)), 201


@app.route("/api/notes/<int:note_id>", methods=["PATCH"])
def api_update_note(note_id):
    data   = request.get_json(silent=True) or {}
    author = _author(data)
    text   = str(data.get("text", "")).strip()[:_MAX_NOTE]
    if not author or not text:
        return jsonify({"error": "author and text required"}), 400
    note = update_note(note_id, author, text)
    if note is None:
        return jsonify({"error": "note not found or not yours to edit"}), 403
    return jsonify(note)


@app.route("/api/notes/<int:note_id>", methods=["DELETE"])
def api_delete_note(note_id):
    data   = request.get_json(silent=True) or {}
    author = _author(data)
    if not author:
        return jsonify({"error": "author required"}), 400
    if not delete_note(note_id, author):
        return jsonify({"error": "note not found or not yours to delete"}), 403
    return jsonify({"success": True})


@app.route("/api/events/<int:event_id>/hidden", methods=["POST"])
def api_event_hidden(event_id):
    """Hide or unhide an event for all users."""
    data   = request.get_json(silent=True) or {}
    hidden = bool(data.get("hidden"))
    if not set_event_hidden(event_id, hidden):
        return jsonify({"error": "event not found"}), 404
    return jsonify({"success": True, "hidden": hidden})


@app.route("/api/events/hidden", methods=["POST"])
def api_events_hidden_bulk():
    """Hide or unhide many events at once (e.g. a whole grouped booking)."""
    data   = request.get_json(silent=True) or {}
    ids    = data.get("ids")
    hidden = bool(data.get("hidden"))
    if not isinstance(ids, list) or not ids:
        return jsonify({"error": "ids (non-empty list) required"}), 400
    try:
        ids = [int(i) for i in ids]
    except (ValueError, TypeError):
        return jsonify({"error": "ids must be integers"}), 400
    n = set_events_hidden(ids, hidden)
    return jsonify({"success": True, "hidden": hidden, "updated": n})


@app.route("/api/events/clear", methods=["POST"])
def api_clear():
    data  = request.get_json(silent=True) or {}
    start = data.get("start")
    end   = data.get("end")
    if start and end:
        count = delete_events_in_range(start, end)
        return jsonify({"success": True, "count": count,
                        "message": f"Cleared {count} event{'s' if count != 1 else ''}"})
    # Fallback: clear everything (used by the "Clear all" option in the modal)
    delete_all_events()
    return jsonify({"success": True, "message": "All events cleared"})


@app.route("/api/events/count")
def api_count_range():
    start = request.args.get("start")
    end   = request.args.get("end")
    if not start or not end:
        return jsonify({"error": "start and end required"}), 400
    return jsonify({"count": count_events_in_range(start, end)})


@app.route("/api/stats")
def api_stats():
    return jsonify(get_stats())


@app.route("/api/analytics")
def api_analytics():
    """Aggregated event analytics, bucketed into an 'All' view and per SFU
    semester (Fall/Spring/Summer). See analytics.build_analytics."""
    return jsonify(build_analytics(get_events()))


# ── Helpers ───────────────────────────────────────────────────────────────────

def _group_key(e: dict) -> str:
    """
    Stable colour-grouping key for an event.
    Priority:
      1. event_name  — groups all rooms of the same named event
      2. booking #   — extracted from onsite_contact e.g. "Devan #189848"
      3. room + date — unique fallback so unnamed/numberless events still render
    """
    name = (e.get("event_name") or "").strip()
    if name:
        return name

    contact = (e.get("onsite_contact") or "").strip()
    m = re.search(r"#(\d+)", contact)
    if m:
        return f"#{m.group(1)}"

    return f"{e.get('room', 'unknown')}|{e.get('date', '')}"


def _iso(date: str, time: str) -> str:
    if not date:
        return ""
    if time and ":" in time:
        return f"{date}T{time}:00"
    return date


def _event_end_dt(e: dict):
    """A single event's end as a datetime (end_time, else start_time, else end
    of day for date-only rows so an all-day event isn't 'past' mid-day)."""
    date = (e.get("date") or "")[:10]
    if not date:
        return None
    t = e.get("end_time") or e.get("start_time") or ""
    try:
        if t and ":" in t:
            return datetime.strptime(f"{date} {t[:5]}", "%Y-%m-%d %H:%M")
        return datetime.strptime(f"{date} 23:59", "%Y-%m-%d %H:%M")
    except ValueError:
        return None


def _group_past_map() -> dict:
    """group_key → True when the group's LAST instance is already in the past.

    Computed across every event in the DB (not just the requested range) so a
    booking that continues outside the loaded window isn't wrongly 'past'.
    """
    now = datetime.now()
    last: dict = {}
    for e in get_events():
        key = _group_key(e)
        dt = _event_end_dt(e)
        if dt is None:
            continue
        if key not in last or dt > last[key]:
            last[key] = dt
    return {k: (v < now) for k, v in last.items()}


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "5000"))
    app.run(host="0.0.0.0", port=port, debug=True)
