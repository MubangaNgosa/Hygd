"""
Hygd — event & room schedule. Flask application.

Start locally:   python app.py
Production:      gunicorn -w 2 -b 0.0.0.0:5000 app:app
"""

import csv
import io
import os
import re
import secrets
import time
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

from dotenv import load_dotenv
from flask import (Flask, Response, jsonify, render_template, request,
                   send_from_directory)
from werkzeug.utils import secure_filename

load_dotenv()

from analytics import build_analytics
from analytics import dept_category as _dept_category
from database import (add_note, count_events_in_range, delete_all_events,
                      delete_event, delete_events, delete_events_in_range,
                      delete_note, get_comments_report, get_event_by_id, get_events,
                      get_notes,
                      get_stats, get_unread_notes, init_db, save_events,
                      set_event_hidden, set_events_hidden, set_event_progress,
                      toggle_reaction, update_note)
from parser import extract_and_parse_pdf

app = Flask(__name__)
app.config["UPLOAD_FOLDER"] = "uploads"
app.config["MAX_CONTENT_LENGTH"] = 50 * 1024 * 1024  # 50 MB

os.makedirs(app.config["UPLOAD_FOLDER"], exist_ok=True)

# Photos attached to notes live here and are served from /note-images/<file>.
NOTE_IMAGE_DIR = os.path.join(app.config["UPLOAD_FOLDER"], "note_images")
os.makedirs(NOTE_IMAGE_DIR, exist_ok=True)
_ALLOWED_IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".heic", ".heif"}
_MAX_NOTE_IMAGES = 10

init_db()


# ── Security headers ─────────────────────────────────────────────────────────

# Bootstrap, Bootstrap Icons, FullCalendar and Chart.js come from jsDelivr.
# 'unsafe-inline' stays until the templates' onclick=/style= attributes and
# inline <script> move into static/; drop it then for a strict policy. blob: is
# for the note-photo previews shown before upload.
SECURITY_HEADERS = {
    "Content-Security-Policy": ("default-src 'self'; "
                                "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; "
                                "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; "
                                "font-src 'self' data: https://cdn.jsdelivr.net; "
                                "img-src 'self' data: blob:; "
                                "object-src 'none'; base-uri 'none'; frame-ancestors 'none'; "
                                "form-action 'self'"),
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "same-origin",
}


@app.after_request
def _security_headers(resp: Response) -> Response:
    for name, value in SECURITY_HEADERS.items():
        resp.headers.setdefault(name, value)
    if request.path.startswith("/api/") or request.path == "/comments/report":
        # Events carry onsite contact names and phone numbers; keep them out of shared caches.
        resp.headers["Cache-Control"] = "no-store"
    return resp


# ── Pages ────────────────────────────────────────────────────────────────────

@app.route("/")
def index():
    return render_template("index.html")


@app.route("/analytics")
def analytics_page():
    return render_template("analytics.html")


@app.route("/comments/report")
def comments_report():
    """Every comment with its event's details — a printable page, or a CSV
    download with ?format=csv. ?start/&end (YYYY-MM-DD) limit by event date."""
    start = (request.args.get("start") or "").strip()[:10] or None
    end = (request.args.get("end") or "").strip()[:10] or None
    events = get_comments_report(start, end)
    for ev in events:
        ev["dept_category"] = _dept_category(ev.get("department", ""),
                                             ev.get("service_type", ""))
        for c in ev["comments"]:
            c["when"] = _venue_time(c.get("created_at"))
            c["edited"] = _venue_time(c.get("updated_at")) if c.get("updated_at") else ""

    if request.args.get("format") == "csv":
        return _comments_csv(events, start, end)

    comments = [c for ev in events for c in ev["comments"]]
    return render_template(
        "comments_report.html",
        events=events, start=start or "", end=end or "",
        total_comments=len(comments),
        authors=sorted({c["author"] for c in comments if c.get("author")}),
        generated=datetime.now(_venue_tz()).strftime("%Y-%m-%d %H:%M"),
    )


def _comments_csv(events: list, start, end) -> Response:
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["Event date", "Start", "End", "Room", "Event", "Event #",
                "Department", "Onsite contact", "MECS contact", "Attendance",
                "Status", "Comment by", "Commented at", "Edited at",
                "Comment", "Images", "Reactions"])
    for ev in events:
        for c in ev["comments"]:
            reactions = " ".join(f"{r['emoji']}×{len(r['authors'])}"
                                 for r in c.get("reactions", []))
            w.writerow([_csv_safe(v) for v in (
                ev["date"], ev["start_time"], ev["end_time"], ev["room"],
                ev["event_name"], ev["event_number"], ev["dept_category"],
                ev["onsite_contact"], ev["mecs_contact"], ev["attendance"],
                ev["status"], c["author"], c["when"], c["edited"], c["text"],
                len(c.get("images") or []), reactions,
            )])
    span = f"{start or 'all'}_to_{end or 'all'}" if (start or end) else "all"
    # BOM so Excel opens the UTF-8 (accents, emoji) correctly.
    return Response(
        "﻿" + buf.getvalue(), mimetype="text/csv",
        headers={"Content-Disposition":
                 f'attachment; filename="hygd-comments-{span}.csv"'},
    )


def _csv_safe(v):
    """Stop spreadsheet apps from running a cell that starts like a formula."""
    v = "" if v is None else str(v)
    return "'" + v if v[:1] in ("=", "+", "-", "@") else v


def _venue_tz():
    """The venue's timezone. Falls back to a fixed UTC−7 (BC's year-round
    offset) when no tz database is installed (e.g. Windows without `tzdata`)."""
    try:
        from zoneinfo import ZoneInfo
        return ZoneInfo(os.environ.get("VENUE_TZ", "America/Vancouver"))
    except Exception:
        return timezone(timedelta(hours=-7))


def _venue_time(ts) -> str:
    """SQLite UTC 'YYYY-MM-DD HH:MM:SS' → venue-local 'YYYY-MM-DD HH:MM'."""
    if not ts:
        return ""
    try:
        dt = datetime.strptime(str(ts)[:19], "%Y-%m-%d %H:%M:%S")
    except ValueError:
        return str(ts)
    return dt.replace(tzinfo=timezone.utc).astimezone(_venue_tz()).strftime("%Y-%m-%d %H:%M")


@app.route("/layouts/<path:filename>")
def layout_image(filename):
    """Serve an extracted room-layout diagram image."""
    layout_dir = os.path.join(app.config["UPLOAD_FOLDER"], "layouts")
    return send_from_directory(layout_dir, filename)


@app.route("/note-images/<path:filename>")
def note_image(filename):
    """Serve a photo attached to a note."""
    return send_from_directory(NOTE_IMAGE_DIR, filename)


# ── Upload ───────────────────────────────────────────────────────────────────

UPLOAD_MAX_AGE = 90 * 24 * 3600  # events live in the DB; the PDFs are only kept for re-checking a parse


def _prune_uploads() -> None:
    """Delete uploaded PDFs past the retention window. They hold onsite contacts
    the DB already has, so there's no reason to keep them forever. Only the
    top level of uploads/ is touched: note_images/ and layouts/ are still in use."""
    cutoff = time.time() - UPLOAD_MAX_AGE
    for p in Path(app.config["UPLOAD_FOLDER"]).glob("*.pdf"):
        try:
            if p.is_file() and p.stat().st_mtime < cutoff:
                p.unlink()
        except OSError:  # already gone, or in use; the next upload tries again
            pass


@app.route("/upload", methods=["POST"])
def upload():
    if "file" not in request.files:
        return jsonify({"error": "No file provided"}), 400

    file = request.files["file"]
    if not file.filename:
        return jsonify({"error": "Empty filename"}), 400
    if not file.filename.lower().endswith(".pdf"):
        return jsonify({"error": "Only PDF files are supported"}), 400

    if file.stream.read(5) != b"%PDF-":
        return jsonify({"error": "That file isn't a PDF"}), 400
    file.stream.seek(0)

    # Never trust the browser's filename: strip any path parts and prefix it so
    # uploads can't land outside uploads/ or overwrite each other.
    _prune_uploads()
    safe = secure_filename(file.filename) or "upload.pdf"
    dest = os.path.join(app.config["UPLOAD_FOLDER"],
                        f"{datetime.now():%Y%m%d-%H%M%S}-{secrets.token_hex(4)}-{safe}")
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
    except Exception:
        app.logger.exception("Parsing %s failed", dest)
        return jsonify({"error": "Parsing failed. Check that this is a MECS events PDF."}), 500


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
                "manually_complete": bool(e.get("manually_complete", 0)),
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

    manual = data.get("manually_complete")
    if manual is not None:
        manual = bool(manual)

    if checked is None and note is None and manual is None:
        return jsonify({"error": "nothing to update"}), 400

    if not set_event_progress(event_id, checked, note, manual):
        return jsonify({"error": "event not found"}), 404
    return jsonify({"success": True})


# ── Notes API (append-only, attributed, edit/delete limited to author) ─────────

_MAX_AUTHOR = 60
_MAX_NOTE   = 5000


def _author(data: dict) -> str:
    return str(data.get("author", "")).strip()[:_MAX_AUTHOR]


def _save_note_images(files) -> list[str]:
    """Save uploaded note photos to NOTE_IMAGE_DIR and return their stored
    filenames. Non-image files are skipped; capped at _MAX_NOTE_IMAGES."""
    saved: list[str] = []
    for f in files:
        if not f or not f.filename:
            continue
        ext = os.path.splitext(f.filename)[1].lower()
        if ext not in _ALLOWED_IMAGE_EXTS:
            continue
        name = f"{uuid.uuid4().hex}{ext}"
        f.save(os.path.join(NOTE_IMAGE_DIR, name))
        saved.append(name)
        if len(saved) >= _MAX_NOTE_IMAGES:
            break
    return saved


def _delete_note_images(images) -> None:
    """Remove image files backing a deleted note; ignore anything already gone."""
    for name in images or []:
        # Guard against path traversal — only ever touch the note-image dir.
        safe = os.path.basename(str(name))
        try:
            os.remove(os.path.join(NOTE_IMAGE_DIR, safe))
        except OSError:
            pass


@app.route("/api/events/<int:event_id>/notes")
def api_get_notes(event_id):
    return jsonify(get_notes(event_id))


@app.route("/api/events/<int:event_id>/notes", methods=["POST"])
def api_add_note(event_id):
    if not get_event_by_id(event_id):
        return jsonify({"error": "event not found"}), 404

    # Photos arrive as multipart/form-data; a plain text note still comes as JSON.
    if request.files:
        author = str(request.form.get("author", "")).strip()[:_MAX_AUTHOR]
        text   = str(request.form.get("text", "")).strip()[:_MAX_NOTE]
        images = _save_note_images(request.files.getlist("images"))
    else:
        data   = request.get_json(silent=True) or {}
        author = _author(data)
        text   = str(data.get("text", "")).strip()[:_MAX_NOTE]
        images = []

    if not author:
        return jsonify({"error": "author required"}), 400
    if not text and not images:
        return jsonify({"error": "text or image required"}), 400
    return jsonify(add_note(event_id, author, text, images)), 201


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
    images = delete_note(note_id, author)
    if images is None:
        return jsonify({"error": "note not found or not yours to delete"}), 403
    _delete_note_images(images)
    return jsonify({"success": True})


# The fixed set of reactions offered under each note.
REACTION_EMOJIS = ["👍", "❤️", "😂", "😮", "🎉", "👀", "✅", "🙏"]


@app.route("/api/notes/<int:note_id>/reactions", methods=["POST"])
def api_toggle_reaction(note_id):
    """Toggle the caller's emoji reaction on a note; returns its reactions."""
    data   = request.get_json(silent=True) or {}
    author = _author(data)
    emoji  = str(data.get("emoji", ""))
    if not author:
        return jsonify({"error": "author required"}), 400
    if emoji not in REACTION_EMOJIS:
        return jsonify({"error": "unsupported reaction"}), 400
    reactions = toggle_reaction(note_id, author, emoji)
    if reactions is None:
        return jsonify({"error": "note not found"}), 404
    return jsonify(reactions)


@app.route("/api/comments/unread", methods=["POST"])
def api_unread_comments():
    """New comments for the header inbox, across all events (not just the
    calendar's visible range). The browser says what it has already seen:
    `seen` maps event id → last-seen note id, `floor` covers events it has
    never opened, and `me` excludes the caller's own comments."""
    data = request.get_json(silent=True) or {}
    seen = {}
    raw_seen = data.get("seen")
    if isinstance(raw_seen, dict):
        for k, v in raw_seen.items():
            try:
                seen[str(int(k))] = int(v)
            except (TypeError, ValueError):
                pass
    try:
        floor = max(0, int(data.get("floor") or 0))
    except (TypeError, ValueError):
        floor = 0
    me = str(data.get("me", "")).strip()[:_MAX_AUTHOR]
    return jsonify(get_unread_notes(seen, floor, me))


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


@app.route("/api/events/delete", methods=["POST"])
def api_delete_events_bulk():
    """Delete several selected events (and their comments) at once."""
    data = request.get_json(silent=True) or {}
    ids  = data.get("ids")
    if not isinstance(ids, list) or not ids:
        return jsonify({"error": "ids (non-empty list) required"}), 400
    try:
        ids = sorted({int(i) for i in ids})
    except (ValueError, TypeError):
        return jsonify({"error": "ids must be integers"}), 400
    count, images = delete_events(ids)
    _delete_note_images(images)
    return jsonify({"success": True, "deleted": count,
                    "message": f"Deleted {count} event{'s' if count != 1 else ''}"})


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
      1. event_number — one group per booking, so separate bookings that share
                        a (possibly truncated) name stay apart
      2. booking #    — extracted from onsite_contact e.g. "Devan #189848"
      3. event_name   — groups all rooms of the same named event
      4. room + date  — unique fallback so unnamed/numberless events still render
    """
    number = (e.get("event_number") or "").strip().lstrip("#")
    if number:
        return f"#{number}"

    contact = (e.get("onsite_contact") or "").strip()
    m = re.search(r"#(\d+)", contact)
    if m:
        return f"#{m.group(1)}"

    name = (e.get("event_name") or "").strip()
    if name:
        return name

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
    start_t = e.get("start_time") or ""
    t = e.get("end_time") or start_t
    try:
        if t and ":" in t:
            end = datetime.strptime(f"{date} {t[:5]}", "%Y-%m-%d %H:%M")
            # An end earlier than the start (e.g. 22:00–01:00) runs past
            # midnight, so it ends on the following day.
            if start_t and ":" in start_t and t[:5] < start_t[:5]:
                end += timedelta(days=1)
            return end
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
    # The debugger runs any code it's sent, so it's opt-in and local by default.
    # Set HOST=0.0.0.0 to reach the dev server from another machine (never with FLASK_DEBUG).
    port = int(os.environ.get("PORT", "5000"))
    host = os.environ.get("HOST", "127.0.0.1")
    debug = os.environ.get("FLASK_DEBUG", "").lower() in ("1", "true", "yes")
    app.run(host=host, port=port, debug=debug)
