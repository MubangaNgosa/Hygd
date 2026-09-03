import sqlite3
import json
import os

DB_PATH = os.environ.get('DB_PATH', 'events.db')


def get_connection():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    conn = get_connection()
    conn.execute('''
        CREATE TABLE IF NOT EXISTS events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            date TEXT NOT NULL,
            start_time TEXT DEFAULT '',
            end_time TEXT DEFAULT '',
            room TEXT DEFAULT '',
            event_name TEXT DEFAULT '',
            event_number TEXT DEFAULT '',
            service_type TEXT DEFAULT '',
            onsite_contact TEXT DEFAULT '',
            mecs_contact TEXT DEFAULT '',
            setup_items TEXT DEFAULT '[]',
            notes TEXT DEFAULT '',
            attendance TEXT DEFAULT '',
            department TEXT DEFAULT '',
            layout_image TEXT DEFAULT '',
            layout_images TEXT DEFAULT '[]',
            checked_items TEXT DEFAULT '[]',
            assistant_note TEXT DEFAULT '',
            pdf_source TEXT DEFAULT '',
            status TEXT DEFAULT 'active',
            hidden INTEGER DEFAULT 0,
            updated_at TIMESTAMP,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    ''')
    # Append-only, attributed notes: each person adds their own entry so
    # simultaneous editors never clobber each other (see get_notes/add_note).
    conn.execute('''
        CREATE TABLE IF NOT EXISTS notes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            event_id INTEGER NOT NULL,
            author TEXT NOT NULL DEFAULT '',
            text TEXT NOT NULL DEFAULT '',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP
        )
    ''')
    conn.execute('CREATE INDEX IF NOT EXISTS idx_notes_event ON notes(event_id)')
    # Small key/value table for one-time bookkeeping (e.g. migration flags).
    conn.execute('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)')
    _migrate(conn)
    _migrate_assistant_notes(conn)
    conn.commit()
    conn.close()


def _migrate(conn):
    """Add columns that may be missing from older database files."""
    cols = {row[1] for row in conn.execute("PRAGMA table_info(events)").fetchall()}
    migrations = [
        ("event_number", "ALTER TABLE events ADD COLUMN event_number TEXT DEFAULT ''"),
        ("attendance",   "ALTER TABLE events ADD COLUMN attendance TEXT DEFAULT ''"),
        ("department",     "ALTER TABLE events ADD COLUMN department TEXT DEFAULT ''"),
        ("layout_image",   "ALTER TABLE events ADD COLUMN layout_image TEXT DEFAULT ''"),
        ("layout_images",  "ALTER TABLE events ADD COLUMN layout_images TEXT DEFAULT '[]'"),
        ("checked_items",  "ALTER TABLE events ADD COLUMN checked_items TEXT DEFAULT '[]'"),
        ("assistant_note", "ALTER TABLE events ADD COLUMN assistant_note TEXT DEFAULT ''"),
        ("status",         "ALTER TABLE events ADD COLUMN status TEXT DEFAULT 'active'"),
        ("hidden",         "ALTER TABLE events ADD COLUMN hidden INTEGER DEFAULT 0"),
        ("updated_at",     "ALTER TABLE events ADD COLUMN updated_at TIMESTAMP"),
    ]
    for col, sql in migrations:
        if col not in cols:
            conn.execute(sql)


def _migrate_assistant_notes(conn):
    """One-time copy of the legacy single `assistant_note` field into the new
    append-only notes thread, so no existing note text is lost when we switch
    the UI to attributed entries. Guarded by a meta flag so it runs only once."""
    done = conn.execute(
        "SELECT value FROM meta WHERE key='notes_migrated'"
    ).fetchone()
    if done:
        return
    rows = conn.execute(
        "SELECT id, assistant_note FROM events "
        "WHERE assistant_note IS NOT NULL AND assistant_note != ''"
    ).fetchall()
    for row in rows:
        conn.execute(
            "INSERT INTO notes (event_id, author, text) VALUES (?, ?, ?)",
            (row['id'], 'Assistant', row['assistant_note']),
        )
    conn.execute(
        "INSERT OR REPLACE INTO meta (key, value) VALUES ('notes_migrated', '1')"
    )


# ── Content comparison ────────────────────────────────────────────────────────

def _content_changed(existing: dict, new: dict, setup_json: str,
                     layout_images_json: str, new_status: str) -> bool:
    """Return True if any meaningful field in the existing row differs from the incoming event."""
    text_fields = [
        'event_name', 'event_number', 'service_type', 'onsite_contact',
        'mecs_contact', 'notes', 'attendance', 'department', 'layout_image',
    ]
    for f in text_fields:
        if (existing.get(f) or '') != (new.get(f) or ''):
            return True
    # Compare setup_items as JSON string
    if (existing.get('setup_items') or '[]') != setup_json:
        return True
    # Compare the full list of layout diagrams as JSON string
    if (existing.get('layout_images') or '[]') != layout_images_json:
        return True
    # Status change (e.g. active → cancelled)
    if (existing.get('status') or 'active') != new_status:
        return True
    return False


# ── Save / upsert ─────────────────────────────────────────────────────────────

def save_events(events: list[dict]) -> tuple[int, int, int, int]:
    """
    Upsert events matched by (date, start_time, end_time, room).

    Returns (new_count, updated_count, cancelled_count, skipped_count).

    - new:       event did not exist → inserted
    - updated:   event existed but content/status changed → updated in place
    - cancelled: events explicitly cancelled in the PDF + previously-active events
                 that no longer appear in the PDF for a covered date (omission cancellation)
    - skipped:   event existed and is byte-for-byte identical → no DB write
    """
    conn = get_connection()
    new_count       = 0
    updated_count   = 0
    cancelled_count = 0
    skipped_count   = 0

    # Track which (date, start_time, end_time, room) tuples appear in the new PDF
    seen_keys: set[tuple] = set()
    # Track which dates are covered by the new PDF
    covered_dates: set[str] = set()

    for e in events:
        start  = _normalize_time(e.get('start_time', ''))
        end    = _normalize_time(e.get('end_time', ''))
        date   = e.get('date', '')
        room   = e.get('room', '')
        service = e.get('service_type', '')
        is_cancelled = e.get('cancelled', False)
        status = 'cancelled' if is_cancelled else 'active'
        setup_json = json.dumps(e.get('setup_items', []))
        layout_images_json = json.dumps(e.get('layout_images', []))

        # A single space can host several functions at the same time (e.g. a
        # Room Set, an Audio Visual and a Ceremony), so service_type is part of
        # the identity key — otherwise siblings overwrite each other.
        seen_keys.add((date, start, end, room, service))
        if date:
            covered_dates.add(date)

        existing = conn.execute(
            'SELECT * FROM events WHERE date=? AND start_time=? AND end_time=? '
            'AND room=? AND service_type=?',
            (date, start, end, room, service),
        ).fetchone()

        if existing is None:
            # ── Brand new event ───────────────────────────────────────────────
            conn.execute(
                '''INSERT INTO events
                   (date, start_time, end_time, room, event_name, event_number,
                    service_type, onsite_contact, mecs_contact, setup_items, notes,
                    attendance, department, layout_image, layout_images,
                    pdf_source, status)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)''',
                (
                    date, start, end, room,
                    e.get('event_name', ''),
                    e.get('event_number', ''),
                    e.get('service_type', ''),
                    e.get('onsite_contact', ''),
                    e.get('mecs_contact', ''),
                    setup_json,
                    e.get('notes', ''),
                    e.get('attendance', ''),
                    e.get('department', ''),
                    e.get('layout_image', ''),
                    layout_images_json,
                    e.get('pdf_source', ''),
                    status,
                )
            )
            new_count += 1
            if is_cancelled:
                cancelled_count += 1

        else:
            existing_dict = dict(existing)
            if _content_changed(existing_dict, e, setup_json, layout_images_json, status):
                # ── Existing event with changes → update ──────────────────────
                conn.execute(
                    '''UPDATE events SET
                       event_name=?, event_number=?, service_type=?, onsite_contact=?,
                       mecs_contact=?, setup_items=?, notes=?, attendance=?, department=?,
                       layout_image=?, layout_images=?, pdf_source=?, status=?,
                       updated_at=CURRENT_TIMESTAMP
                       WHERE id=?''',
                    (
                        e.get('event_name', ''),
                        e.get('event_number', ''),
                        e.get('service_type', ''),
                        e.get('onsite_contact', ''),
                        e.get('mecs_contact', ''),
                        setup_json,
                        e.get('notes', ''),
                        e.get('attendance', ''),
                        e.get('department', ''),
                        e.get('layout_image', ''),
                        layout_images_json,
                        e.get('pdf_source', ''),
                        status,
                        existing_dict['id'],
                    )
                )
                updated_count += 1
                if is_cancelled:
                    cancelled_count += 1
            else:
                # ── Identical — nothing to do ─────────────────────────────────
                skipped_count += 1

    # ── Omission cancellation ─────────────────────────────────────────────────
    # For every date the PDF covers, mark active events that are no longer listed
    # as cancelled (they were removed from the PDF, implying cancellation).
    for date in covered_dates:
        db_events = conn.execute(
            "SELECT * FROM events WHERE date=? AND status != 'cancelled'",
            (date,),
        ).fetchall()
        for row in db_events:
            key = (row['date'], row['start_time'], row['end_time'],
                   row['room'], row['service_type'])
            if key not in seen_keys:
                conn.execute(
                    '''UPDATE events SET status='cancelled', updated_at=CURRENT_TIMESTAMP
                       WHERE id=?''',
                    (row['id'],),
                )
                cancelled_count += 1

    conn.commit()
    conn.close()
    return new_count, updated_count, cancelled_count, skipped_count


# ── Queries ───────────────────────────────────────────────────────────────────

def _decode_layout_images(e: dict) -> None:
    """Parse the layout_images JSON list and reconcile it with the legacy
    single `layout_image` column, so rows written before multi-diagram support
    (which only have `layout_image`) still surface their diagram as a list."""
    try:
        imgs = json.loads(e.get('layout_images') or '[]')
        if not isinstance(imgs, list):
            imgs = []
    except (json.JSONDecodeError, TypeError):
        imgs = []
    primary = (e.get('layout_image') or '').strip()
    if not imgs and primary:
        imgs = [primary]
    if imgs and not primary:
        e['layout_image'] = imgs[0]
    e['layout_images'] = imgs


def get_events(start: str = None, end: str = None) -> list[dict]:
    conn = get_connection()
    query = 'SELECT * FROM events'
    params = []
    if start and end:
        query += ' WHERE date >= ? AND date <= ?'
        params = [start[:10], end[:10]]
    elif start:
        query += ' WHERE date >= ?'
        params = [start[:10]]
    query += ' ORDER BY date, start_time'

    rows = conn.execute(query, params).fetchall()
    # How many notes each event has, so the UI can flag events that carry notes
    note_counts = dict(conn.execute(
        'SELECT event_id, COUNT(*) FROM notes GROUP BY event_id'
    ).fetchall())
    conn.close()

    result = []
    for row in rows:
        e = dict(row)
        try:
            e['setup_items'] = json.loads(e.get('setup_items') or '[]')
        except (json.JSONDecodeError, TypeError):
            e['setup_items'] = []
        try:
            e['checked_items'] = json.loads(e.get('checked_items') or '[]')
        except (json.JSONDecodeError, TypeError):
            e['checked_items'] = []
        _decode_layout_images(e)
        e['note_count'] = note_counts.get(e['id'], 0)
        result.append(e)
    return result


def get_event_by_id(event_id: int) -> dict | None:
    conn = get_connection()
    row = conn.execute('SELECT * FROM events WHERE id = ?', (event_id,)).fetchone()
    conn.close()
    if row:
        e = dict(row)
        try:
            e['setup_items'] = json.loads(e.get('setup_items') or '[]')
        except (json.JSONDecodeError, TypeError):
            e['setup_items'] = []
        try:
            e['checked_items'] = json.loads(e.get('checked_items') or '[]')
        except (json.JSONDecodeError, TypeError):
            e['checked_items'] = []
        _decode_layout_images(e)
        return e
    return None


def delete_event(event_id: int):
    conn = get_connection()
    conn.execute('DELETE FROM events WHERE id = ?', (event_id,))
    conn.execute('DELETE FROM notes WHERE event_id = ?', (event_id,))
    conn.commit()
    conn.close()


def set_event_progress(event_id: int, checked_items=None, assistant_note=None) -> bool:
    """Save an assistant's per-event progress (ticked setup items and/or a note).

    Only the arguments that are not None are written, so the two can be updated
    independently. These fields are never touched by PDF re-uploads.
    Returns True if the event exists.
    """
    conn = get_connection()
    sets, params = [], []
    if checked_items is not None:
        sets.append('checked_items=?')
        params.append(json.dumps(checked_items))
    if assistant_note is not None:
        sets.append('assistant_note=?')
        params.append(assistant_note)

    ok = True
    if sets:
        params.append(event_id)
        cur = conn.execute(f'UPDATE events SET {", ".join(sets)} WHERE id=?', params)
        ok = cur.rowcount > 0
        conn.commit()
    conn.close()
    return ok


def set_event_hidden(event_id: int, hidden: bool) -> bool:
    """Hide or unhide an event for everyone (shared, stored on the row).

    Hidden is a per-event user setting that PDF re-uploads never touch.
    Returns True if the event exists.
    """
    conn = get_connection()
    cur = conn.execute(
        'UPDATE events SET hidden=? WHERE id=?', (1 if hidden else 0, event_id)
    )
    ok = cur.rowcount > 0
    conn.commit()
    conn.close()
    return ok


def set_events_hidden(event_ids: list[int], hidden: bool) -> int:
    """Hide or unhide many events at once (e.g. a whole grouped booking).

    Returns the number of rows updated.
    """
    if not event_ids:
        return 0
    conn = get_connection()
    placeholders = ','.join('?' * len(event_ids))
    cur = conn.execute(
        f'UPDATE events SET hidden=? WHERE id IN ({placeholders})',
        [1 if hidden else 0, *event_ids],
    )
    n = cur.rowcount
    conn.commit()
    conn.close()
    return n


# ── Notes (append-only, attributed) ────────────────────────────────────────────

_NOTE_COLS = "id, event_id, author, text, created_at, updated_at"


def get_notes(event_id: int) -> list[dict]:
    """All notes for an event, oldest first."""
    conn = get_connection()
    rows = conn.execute(
        f"SELECT {_NOTE_COLS} FROM notes WHERE event_id=? ORDER BY created_at, id",
        (event_id,),
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def add_note(event_id: int, author: str, text: str) -> dict:
    """Append a new note and return the created row."""
    conn = get_connection()
    cur = conn.execute(
        "INSERT INTO notes (event_id, author, text) VALUES (?, ?, ?)",
        (event_id, author, text),
    )
    row = conn.execute(
        f"SELECT {_NOTE_COLS} FROM notes WHERE id=?", (cur.lastrowid,)
    ).fetchone()
    conn.commit()
    conn.close()
    return dict(row)


def update_note(note_id: int, author: str, text: str) -> dict | None:
    """Edit a note, but only if `author` matches the note's author.

    Returns the updated row, or None if it doesn't exist or isn't the author's.
    """
    conn = get_connection()
    cur = conn.execute(
        "UPDATE notes SET text=?, updated_at=CURRENT_TIMESTAMP "
        "WHERE id=? AND author=?",
        (text, note_id, author),
    )
    row = None
    if cur.rowcount > 0:
        row = conn.execute(
            f"SELECT {_NOTE_COLS} FROM notes WHERE id=?", (note_id,)
        ).fetchone()
    conn.commit()
    conn.close()
    return dict(row) if row else None


def delete_note(note_id: int, author: str) -> bool:
    """Delete a note, but only if `author` matches. Returns True on success."""
    conn = get_connection()
    cur = conn.execute(
        "DELETE FROM notes WHERE id=? AND author=?", (note_id, author)
    )
    ok = cur.rowcount > 0
    conn.commit()
    conn.close()
    return ok


def delete_events_in_range(start_date: str, end_date: str) -> int:
    """Delete all events between start_date and end_date (inclusive). Returns deleted count."""
    conn = get_connection()
    conn.execute(
        'DELETE FROM notes WHERE event_id IN '
        '(SELECT id FROM events WHERE date >= ? AND date <= ?)',
        (start_date, end_date),
    )
    cur = conn.execute(
        'DELETE FROM events WHERE date >= ? AND date <= ?',
        (start_date, end_date),
    )
    count = cur.rowcount
    conn.commit()
    conn.close()
    return count


def count_events_in_range(start_date: str, end_date: str) -> int:
    conn = get_connection()
    row = conn.execute(
        'SELECT COUNT(*) FROM events WHERE date >= ? AND date <= ?',
        (start_date, end_date),
    ).fetchone()
    conn.close()
    return row[0]


def delete_all_events():
    conn = get_connection()
    conn.execute('DELETE FROM events')
    conn.execute('DELETE FROM notes')
    conn.commit()
    conn.close()


def get_stats() -> dict:
    conn = get_connection()
    total     = conn.execute("SELECT COUNT(*) FROM events").fetchone()[0]
    active    = conn.execute("SELECT COUNT(*) FROM events WHERE status != 'cancelled'").fetchone()[0]
    cancelled = conn.execute("SELECT COUNT(*) FROM events WHERE status = 'cancelled'").fetchone()[0]
    sources   = conn.execute(
        'SELECT pdf_source, COUNT(*) as cnt FROM events GROUP BY pdf_source'
    ).fetchall()
    conn.close()
    return {
        'total':     total,
        'active':    active,
        'cancelled': cancelled,
        'sources':   [{'name': r['pdf_source'], 'count': r['cnt']} for r in sources],
    }


def _normalize_time(t: str) -> str:
    if not t or ':' not in t:
        return t
    parts = t.strip().split(':')
    try:
        return f"{int(parts[0]):02d}:{parts[1]}"
    except (ValueError, IndexError):
        return t
