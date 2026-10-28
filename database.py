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
            manually_complete INTEGER DEFAULT 0,
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
            images TEXT DEFAULT '[]',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP
        )
    ''')
    conn.execute('CREATE INDEX IF NOT EXISTS idx_notes_event ON notes(event_id)')
    # Emoji reactions on notes: one row per (note, person, emoji), so tapping
    # the same emoji again just removes that person's row (see toggle_reaction).
    conn.execute('''
        CREATE TABLE IF NOT EXISTS note_reactions (
            note_id INTEGER NOT NULL,
            author TEXT NOT NULL,
            emoji TEXT NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (note_id, author, emoji)
        )
    ''')
    # Small key/value table for one-time bookkeeping (e.g. migration flags).
    conn.execute('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)')
    _migrate(conn)
    _migrate_notes(conn)
    _migrate_assistant_notes(conn)
    conn.commit()
    conn.close()


def _migrate_notes(conn):
    """Add columns that may be missing from the notes table in older databases."""
    cols = {row[1] for row in conn.execute("PRAGMA table_info(notes)").fetchall()}
    if "images" not in cols:
        conn.execute("ALTER TABLE notes ADD COLUMN images TEXT DEFAULT '[]'")


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
        ("manually_complete", "ALTER TABLE events ADD COLUMN manually_complete INTEGER DEFAULT 0"),
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
    Upsert events matched by (date, start_time, end_time, room, service_type).

    Returns (new_count, updated_count, cancelled_count, skipped_count).

    - new:       event did not exist → inserted
    - updated:   event existed but content/status changed → updated in place
    - cancelled: events explicitly cancelled in the PDF + previously-active events
                 that no longer appear in the PDF, but ONLY within the date range
                 the PDF spans (omission cancellation — see below)
    - skipped:   event existed and is byte-for-byte identical → no DB write
    """
    conn = get_connection()
    new_count       = 0
    updated_count   = 0
    cancelled_count = 0
    skipped_count   = 0

    # Track which (date, start_time, end_time, room, service_type) keys appear in the new PDF
    seen_keys: set[tuple] = set()
    # Track every date the new PDF carries an event on, so we can derive the
    # date window it covers for omission cancellation.
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

    # ── Omission cancellation (scoped to the uploaded PDF's date range) ────────
    # An event that was on the schedule but is absent from the new PDF is treated
    # as cancelled — but ONLY within the date window this PDF actually spans
    # (min…max of the dates it lists). A report covering Sept 2–5 must never
    # touch events on Sept 1 or Sept 6+, which were simply out of its scope.
    # Reconciling only inside [range_start, range_end] keeps a short/partial-range
    # upload from wiping events outside its window. If the PDF parsed to zero
    # events, covered_dates is empty and we cancel nothing (guards a bad parse).
    if covered_dates:
        range_start, range_end = min(covered_dates), max(covered_dates)
        db_events = conn.execute(
            "SELECT * FROM events WHERE date >= ? AND date <= ? "
            "AND status != 'cancelled'",
            (range_start, range_end),
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

def _json_list(value) -> list:
    """A JSON-encoded list column → list; anything unreadable → []."""
    try:
        v = json.loads(value or '[]')
    except (json.JSONDecodeError, TypeError):
        return []
    return v if isinstance(v, list) else []


def _decode_event(row) -> dict:
    """Events row → dict with its JSON list columns parsed."""
    e = dict(row)
    e['setup_items'] = _json_list(e.get('setup_items'))
    e['checked_items'] = _json_list(e.get('checked_items'))
    e['manually_complete'] = bool(e.get('manually_complete', 0))
    _decode_layout_images(e)
    return e


def _decode_layout_images(e: dict) -> None:
    """Parse the layout_images JSON list and reconcile it with the legacy
    single `layout_image` column, so rows written before multi-diagram support
    (which only have `layout_image`) still surface their diagram as a list."""
    imgs = _json_list(e.get('layout_images'))
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
        # FullCalendar's `end` is exclusive (the day after the last one shown).
        query += ' WHERE date >= ? AND date < ?'
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
        e = _decode_event(row)
        e['note_count'] = note_counts.get(e['id'], 0)
        result.append(e)
    return result


def get_event_by_id(event_id: int) -> dict | None:
    conn = get_connection()
    row = conn.execute('SELECT * FROM events WHERE id = ?', (event_id,)).fetchone()
    conn.close()
    return _decode_event(row) if row else None


def delete_event(event_id: int):
    conn = get_connection()
    conn.execute('DELETE FROM events WHERE id = ?', (event_id,))
    conn.execute('DELETE FROM notes WHERE event_id = ?', (event_id,))
    _prune_reactions(conn)
    conn.commit()
    conn.close()


def delete_events(event_ids: list[int]) -> tuple[int, list[str]]:
    """Delete several events with their notes and reactions in one go.

    Returns (events deleted, image filenames of the deleted notes) so the
    caller can remove the photo files too.
    """
    if not event_ids:
        return 0, []
    placeholders = ','.join('?' * len(event_ids))
    conn = get_connection()
    images = []
    for row in conn.execute(
        f"SELECT images FROM notes WHERE event_id IN ({placeholders})", event_ids
    ).fetchall():
        images.extend(_json_list(row['images']))
    conn.execute(f'DELETE FROM notes WHERE event_id IN ({placeholders})', event_ids)
    _prune_reactions(conn)
    cur = conn.execute(f'DELETE FROM events WHERE id IN ({placeholders})', event_ids)
    count = cur.rowcount
    conn.commit()
    conn.close()
    return count, images


def set_event_progress(event_id: int, checked_items=None, assistant_note=None,
                       manually_complete=None) -> bool:
    """Save an assistant's per-event progress (ticked setup items, a note, and/or
    an explicit "mark complete" flag).

    Only the arguments that are not None are written, so each can be updated
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
    if manually_complete is not None:
        sets.append('manually_complete=?')
        params.append(1 if manually_complete else 0)

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

_NOTE_COLS = "id, event_id, author, text, images, created_at, updated_at"


def _decode_note(row) -> dict:
    """Row → dict with `images` parsed from its JSON list."""
    n = dict(row)
    n['images'] = _json_list(n.get('images'))
    return n


def get_notes(event_id: int) -> list[dict]:
    """All notes for an event, oldest first, each with its `reactions`."""
    conn = get_connection()
    rows = conn.execute(
        f"SELECT {_NOTE_COLS} FROM notes WHERE event_id=? ORDER BY created_at, id",
        (event_id,),
    ).fetchall()
    notes = [_decode_note(r) for r in rows]
    reactions = _reactions_for(conn, [n['id'] for n in notes])
    conn.close()
    for n in notes:
        n['reactions'] = reactions.get(n['id'], [])
    return notes


def get_comments_report(start: str = None, end: str = None) -> list[dict]:
    """Every event that has comments (optionally limited to event dates in
    [start, end], both inclusive), each with its `comments` oldest first.
    Events are ordered by date/time, so the list reads like the schedule."""
    conn = get_connection()
    query = (
        'SELECT e.id AS e_id, e.date, e.start_time, e.end_time, e.room, '
        'e.event_name, e.event_number, e.department, e.service_type, '
        'e.onsite_contact, '
        'e.mecs_contact, e.attendance, e.status, '
        'n.id, n.author, n.text, n.images, n.created_at, n.updated_at '
        'FROM notes n JOIN events e ON e.id = n.event_id'
    )
    where, params = [], []
    if start:
        where.append('e.date >= ?'); params.append(start[:10])
    if end:
        where.append('e.date <= ?'); params.append(end[:10])
    if where:
        query += ' WHERE ' + ' AND '.join(where)
    query += ' ORDER BY e.date, e.start_time, e.room, e.id, n.created_at, n.id'
    rows = conn.execute(query, params).fetchall()
    reactions = _reactions_for(conn, [r['id'] for r in rows])
    conn.close()

    events: dict = {}
    for r in rows:
        ev = events.get(r['e_id'])
        if ev is None:
            ev = events[r['e_id']] = {
                k: r[k] for k in ('date', 'start_time', 'end_time', 'room',
                                  'event_name', 'event_number', 'department',
                                  'service_type',
                                  'onsite_contact', 'mecs_contact',
                                  'attendance', 'status')
            }
            ev['id'] = r['e_id']
            ev['comments'] = []
        note = _decode_note({k: r[k] for k in ('id', 'author', 'text', 'images',
                                               'created_at', 'updated_at')})
        note['reactions'] = reactions.get(note['id'], [])
        ev['comments'].append(note)
    return list(events.values())


def _prune_reactions(conn):
    """Drop reactions whose note no longer exists (after any note delete)."""
    conn.execute(
        "DELETE FROM note_reactions WHERE note_id NOT IN (SELECT id FROM notes)"
    )


def _reactions_for(conn, note_ids) -> dict:
    """note_id → [{emoji, authors}], emojis in the order they were first used."""
    if not note_ids:
        return {}
    placeholders = ','.join('?' * len(note_ids))
    rows = conn.execute(
        f"SELECT note_id, emoji, author FROM note_reactions "
        f"WHERE note_id IN ({placeholders}) ORDER BY created_at, rowid",
        note_ids,
    ).fetchall()
    out: dict = {}
    for r in rows:
        groups = out.setdefault(r['note_id'], [])
        group = next((g for g in groups if g['emoji'] == r['emoji']), None)
        if group is None:
            group = {'emoji': r['emoji'], 'authors': []}
            groups.append(group)
        group['authors'].append(r['author'])
    return out


def toggle_reaction(note_id: int, author: str, emoji: str) -> list | None:
    """Add `author`'s `emoji` reaction to a note, or remove it if already there.

    Returns the note's updated reaction list, or None if the note doesn't exist.
    """
    conn = get_connection()
    if not conn.execute("SELECT 1 FROM notes WHERE id=?", (note_id,)).fetchone():
        conn.close()
        return None
    cur = conn.execute(
        "DELETE FROM note_reactions WHERE note_id=? AND author=? AND emoji=?",
        (note_id, author, emoji),
    )
    if cur.rowcount == 0:
        conn.execute(
            "INSERT INTO note_reactions (note_id, author, emoji) VALUES (?, ?, ?)",
            (note_id, author, emoji),
        )
    conn.commit()
    reactions = _reactions_for(conn, [note_id]).get(note_id, [])
    conn.close()
    return reactions


def get_unread_notes(seen: dict, floor: int, me: str, limit: int = 200) -> dict:
    """Notes the caller hasn't seen yet, across every event, newest first.

    A note is unread when its id is above the caller's last-seen note id for
    that event (`seen`, keyed by event id as a string) — or above `floor` for
    events they have never opened — and someone other than `me` wrote it.
    Note ids only ever increase, so a last-seen id is enough to know which
    ones are new.

    Returns {"max_id": highest note id overall, "notes": [...]}; each note
    carries the event fields the inbox needs to show and open it.
    """
    conn = get_connection()
    max_id = conn.execute("SELECT COALESCE(MAX(id), 0) FROM notes").fetchone()[0]
    rows = conn.execute(
        "SELECT n.id, n.event_id, n.author, n.text, n.images, n.created_at, "
        "       e.event_name, e.room, e.service_type, e.date, e.start_time, "
        "       e.status, e.hidden "
        "FROM notes n JOIN events e ON e.id = n.event_id "
        "WHERE n.id > ? AND n.author != ? "
        "ORDER BY n.id DESC",
        (floor, me),
    ).fetchall()
    conn.close()

    notes = []
    for r in rows:
        if r['id'] <= seen.get(str(r['event_id']), 0):
            continue
        n = _decode_note(r)
        n['hidden'] = bool(n['hidden'])
        notes.append(n)
        if len(notes) >= limit:
            break
    return {'max_id': max_id, 'notes': notes}


def add_note(event_id: int, author: str, text: str, images=None) -> dict:
    """Append a new note (optionally with attached image filenames) and return it."""
    conn = get_connection()
    cur = conn.execute(
        "INSERT INTO notes (event_id, author, text, images) VALUES (?, ?, ?, ?)",
        (event_id, author, text, json.dumps(images or [])),
    )
    row = conn.execute(
        f"SELECT {_NOTE_COLS} FROM notes WHERE id=?", (cur.lastrowid,)
    ).fetchone()
    conn.commit()
    conn.close()
    return _decode_note(row)


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
    return _decode_note(row) if row else None


def delete_note(note_id: int, author: str) -> list | None:
    """Delete a note, but only if `author` matches.

    Returns the deleted note's list of image filenames (so the caller can remove
    the files), or None if it didn't exist or wasn't the author's to delete.
    """
    conn = get_connection()
    row = conn.execute(
        "SELECT images FROM notes WHERE id=? AND author=?", (note_id, author)
    ).fetchone()
    if row is None:
        conn.close()
        return None
    images = _json_list(row['images'])
    conn.execute("DELETE FROM notes WHERE id=? AND author=?", (note_id, author))
    _prune_reactions(conn)
    conn.commit()
    conn.close()
    return images


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
    _prune_reactions(conn)
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
    conn.execute('DELETE FROM note_reactions')
    conn.commit()
    conn.close()


def count_events() -> int:
    conn = get_connection()
    total = conn.execute("SELECT COUNT(*) FROM events").fetchone()[0]
    conn.close()
    return total


def _normalize_time(t: str) -> str:
    if not t or ':' not in t:
        return t
    parts = t.strip().split(':')
    try:
        return f"{int(parts[0]):02d}:{parts[1]}"
    except (ValueError, IndexError):
        return t
