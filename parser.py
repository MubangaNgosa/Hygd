"""
PDF extraction and event parsing for MECS resource reports.
Pure regex/rule-based — no external API required.

Supports three PDF formats (auto-detected):
  1. "Daily Resources by Setup Time"       — date-grouped layout
  2. "Services by Function Date"            — event-grouped layout (one function per page)
  3. "Daily Resources by Space - All Functions" — space-grouped layout with
     fixed-width columns and embedded Room Set Diagram (layout) images
"""

import os
import re

import pdfplumber

# ── Lines to discard (prefix-match — no trailing $ so partial lines are caught) ─
_SKIP_RE = re.compile(
    r'^(?:'
    r'\w{3}-\d{2}-\d{2}\s+\d{2}:\d{2}'   # timestamp  "Apr-29-26 13:58"
    r'|Daily Resources'                    # "Daily Resources by Setup Time …"
    r'|April \d+, \d{4} -'                # date-range "April 30, 2026 - May …"
    r'|Burnaby Campus'
    r'|Audio/Visual Services'
    r'|Event Services'
    r'|Attend\s*/'
    r'|Start\s+End\s+Space'               # column header row
    r'|[a-f0-9]{8}-[a-f0-9]{4}.*\.rpt'   # UUID footer
    r'|Page \d+ of \d+'
    r')'
)

_MONTHS = {
    'January': 1, 'February': 2, 'March': 3, 'April': 4,
    'May': 5, 'June': 6, 'July': 7, 'August': 8,
    'September': 9, 'October': 10, 'November': 11, 'December': 12,
}

_MONTHS_ABBR = {
    'Jan': 1, 'Feb': 2, 'Mar': 3, 'Apr': 4,
    'May': 5, 'Jun': 6, 'Jul': 7, 'Aug': 8,
    'Sep': 9, 'Oct': 10, 'Nov': 11, 'Dec': 12,
}

# ── Boilerplate text that appears inside every "Rooms Built-in Equipment" item.
# Detected by first-word match so we don't hard-code full sentences.
_BOILERPLATE_STARTS = (
    'All Theatres', 'All Classrooms', 'An adapter', 'There are fees',
    'connections for', 'projectors', 'connection', 'one', 'need one',
)

# ── Regex patterns ─────────────────────────────────────────────────────────────
_DATE_RE    = re.compile(
    r'^(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),\s+'
    r'(\w+)\s+(\d+),\s+(\d{4})$'
)
_EVENT_RE   = re.compile(r'^(\d{1,2}:\d{2})\s+(\d{1,2}:\d{2})\s+(.+)$')
_ONSITE_RE  = re.compile(r'^Onsite:\s+(\S+)\s+#(\d+)\s+(.+)$')
_NOONSITE_RE= re.compile(r'^#(\d+)\s+(.+)$')
_ITEM_RE    = re.compile(r'^(\d+(?:\.\d+)?)\s+(EA|HR)\s+(.+)$')
_ATT_RE     = re.compile(r'\s+(\d+)\s+PPL\s*$')
_SVC_RE     = re.compile(r'\s+(Audio\s+Visual|AV)\b')
_CANCEL_RE  = re.compile(r'\bCANCEL(?:LED|ED)?\b', re.IGNORECASE)

# ── Regex patterns — format 2 (Services by Function Date) ─────────────────────
_FD_EVENT_RE = re.compile(
    r'^Event:\s+#\s*(\d+)\s*(.+?)\s+'
    r'([A-Z][a-z]{2}-\d+-\d+)\s+-\s+([A-Z][a-z]{2}-\d+-\d+)\s*$'
)
_FD_FN_HEADER_RE    = re.compile(r'^Function Start Date\s+Start')
_FD_ORDER_HEADER_RE = re.compile(r'^Order#\s+Res Time')
_FD_FN_ROW_RE = re.compile(
    r'^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+'
    r'([A-Z][a-z]{2})-(\d+)-(\d+)\s+'
    r'(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})\s+(.+)$'
)
_FD_FOOTER_RE    = re.compile(r'^[a-f0-9]{8}-[a-f0-9]{4}.*\.rpt')
_FD_PAGE_RE      = re.compile(r'^Page\s+\d+\s+of\s+\d+')
_FD_TOTAL_RE     = re.compile(r'^Total for\b')
_FD_QTY_RE       = re.compile(r'\b(\d+(?:\.\d+)?)\s*(EA|HR)\b')
_FD_SVC_SPLIT_RE = re.compile(r'\b(?:Audio\s*V[iI]sual|AV)\b')
_FD_DATE_STAMP_RE = re.compile(r'\b\d{1,2}-[A-Z][a-z]{2}-\d{2}\b')
_FD_TIMERANGE_RE = re.compile(r'\d{1,2}:\d{2}\s*-\s*\d{1,2}:\d{2}')


def _split_room_service(rest: str) -> tuple[str, str, str]:
    """
    Given the text after the two timestamps on an event line, return
    (room, service_type, attendance).  e.g.
      'SWH 10081 Audio Visual 300 PPL' → ('SWH 10081', 'Audio Visual', '300 PPL')
      'HAL 114 AV - Hal 114 24 PPL'   → ('HAL 114', 'AV - Hal 114', '24 PPL')
    """
    m = _SVC_RE.search(rest)
    if not m:
        return rest.strip(), '', ''

    room    = rest[:m.start()].strip()
    svc_raw = rest[m.start():].strip()

    att_m = _ATT_RE.search(svc_raw)
    if att_m:
        attendance  = svc_raw[att_m.start():].strip()
        service     = svc_raw[:att_m.start()].strip()
    else:
        attendance  = ''
        service     = svc_raw

    return room, service, attendance


def _pad_time(t: str) -> str:
    h, m = t.split(':')
    return f"{int(h):02d}:{m}"


def _is_boilerplate(line: str) -> bool:
    return any(line.startswith(s) for s in _BOILERPLATE_STARTS)


def _parse_lines(lines: list[str]) -> list[dict]:
    events:       list[dict] = []
    current_date: str | None = None
    current_ev:   dict | None = None
    in_note:      bool = False

    def _save():
        if current_ev:
            events.append(current_ev)

    for raw in lines:
        line = raw.strip()
        if not line:
            continue
        if _SKIP_RE.match(line):
            continue

        # ── Date header ───────────────────────────────────────────────────────
        dm = _DATE_RE.match(line)
        if dm:
            month_name, day, year = dm.group(1), dm.group(2), dm.group(3)
            new_date = f"{year}-{_MONTHS.get(month_name, 1):02d}-{int(day):02d}"
            if new_date != current_date:
                _save()
                current_ev = None
                in_note = False
            current_date = new_date
            continue

        # ── Event line: "HH:MM  HH:MM  ROOM  SERVICE …" ──────────────────────
        em = _EVENT_RE.match(line)
        if em and current_date:
            _save()
            in_note = False
            room, service, attendance = _split_room_service(em.group(3))
            current_ev = {
                'date':           current_date,
                'start_time':     _pad_time(em.group(1)),
                'end_time':       _pad_time(em.group(2)),
                'room':           room,
                'service_type':   service,
                'attendance':     attendance,
                'event_name':     '',
                'event_number':   '',
                'onsite_contact': '',
                'mecs_contact':   '',
                'setup_items':    [],
                'notes':          '',
                'cancelled':      False,
            }
            continue

        if current_ev is None:
            continue

        # ── Onsite / contact line (only before event_name is set) ─────────────
        if not current_ev['event_name']:
            om = _ONSITE_RE.match(line)
            if om:
                firstname, eid, rest = om.group(1), om.group(2), om.group(3).strip()
                parts = rest.rsplit(None, 1)
                current_ev['event_number']   = eid
                current_ev['onsite_contact'] = f"{firstname} #{eid}"
                current_ev['event_name']     = parts[0].strip() if len(parts) > 1 else rest
                current_ev['mecs_contact']   = parts[1] if len(parts) > 1 else ''
                current_ev['cancelled']      = bool(_CANCEL_RE.search(current_ev['event_name']))
                continue

            nm = _NOONSITE_RE.match(line)
            if nm:
                eid, rest = nm.group(1), nm.group(2).strip()
                parts = rest.rsplit(None, 1)
                current_ev['event_number']   = eid
                current_ev['onsite_contact'] = f"#{eid}"
                current_ev['event_name']     = parts[0].strip() if len(parts) > 1 else rest
                current_ev['mecs_contact']   = parts[1] if len(parts) > 1 else ''
                current_ev['cancelled']      = bool(_CANCEL_RE.search(current_ev['event_name']))
                continue

        # ── Item line: "1.0 EA Something" ─────────────────────────────────────
        im = _ITEM_RE.match(line)
        if im:
            qty, unit, name = im.group(1), im.group(2), im.group(3).strip()
            if name.startswith('AV Note'):
                in_note = True
            else:
                in_note = False
                # Strip any trailing garbage character (e.g. replacement char from PDF)
                name = name.rstrip('�').strip()
                current_ev['setup_items'].append({
                    'qty':  f"{qty} {unit}",
                    'item': name,
                })
            continue

        # ── Notes continuation ────────────────────────────────────────────────
        if in_note:
            sep = '\n' if current_ev['notes'] else ''
            current_ev['notes'] += sep + line
            # A note that explicitly says the event is cancelled
            if _CANCEL_RE.search(line):
                current_ev['cancelled'] = True
            continue

        # ── Item description continuation (multi-line items) ──────────────────
        if current_ev['setup_items'] and not _is_boilerplate(line):
            last_item = current_ev['setup_items'][-1]['item']
            # Don't append boilerplate HDMI description into the Built-in Equipment item
            if 'Rooms Built-in Equipment' not in last_item:
                current_ev['setup_items'][-1]['item'] += ' ' + line

    _save()
    return events


# ── Format 2: Services by Function Date ───────────────────────────────────────

def _is_services_by_function_format(text: str) -> bool:
    """Detect the second PDF format by its title or its event-header line."""
    if 'Services by Function Date' in text:
        return True
    if re.search(r'^Event:\s+#\s*\d+', text, re.MULTILINE):
        return True
    return False


def _split_fd_room_service(text: str) -> tuple[str, str, str]:
    """Split 'DAC Dining Room Audio Visual 50 PPL' → (room, service, attendance).

    Attendance is optional; service starts at the first word-bounded
    'Audio Visual' / 'AV' token.
    """
    att = ''
    m = _ATT_RE.search(text)
    if m:
        att = text[m.start():].strip()
        text = text[:m.start()].rstrip()

    svc_m = _FD_SVC_SPLIT_RE.search(text)
    if svc_m:
        room    = text[:svc_m.start()].strip()
        service = text[svc_m.start():].strip()
    else:
        room    = text.strip()
        service = ''
    return room, service, att


def _clean_fd_desc(text: str) -> str:
    """Strip order#, time range, and 'dd-Mon-yy' stamp from a description fragment."""
    text = re.sub(r'^\d{6,}\s+', '', text)
    text = _FD_TIMERANGE_RE.sub('', text)
    text = _FD_DATE_STAMP_RE.sub('', text)
    return text.strip()


def _parse_fd_items(item_lines: list[str]) -> tuple[list[dict], str]:
    """Parse rows between the Order# header and 'Total for' / page footer.

    Returns (setup_items, notes) where notes is the free-form AV Note text.
    """
    items: list[dict] = []
    notes_lines: list[str] = []
    desc_buffer: list[str] = []
    in_avnote = False
    just_appended = False  # last loop iteration created an item

    def _is_subcontent(s: str) -> bool:
        return (
            not s
            or s.startswith(('·', '•', '�'))
            or _is_boilerplate(s)
            or bool(re.match(r'^\d+\.\w', s))      # "1.Data Projector"
            or bool(re.match(r'^\d+x\s', s))       # "70x Microphones"
            or s.startswith('Event Details')
            or s.startswith('<DIV')
            or s.startswith('For spaces with')
            or s == 'Technician time is included'
        )

    for raw in item_lines:
        line = raw.strip()
        was_appended = just_appended
        just_appended = False

        if not line:
            continue

        # AV Note row marks start of free-form notes (also clears any wrap buffer)
        if line.startswith('AV Note'):
            in_avnote = True
            desc_buffer = []
            continue

        qty_m = _FD_QTY_RE.search(line)
        if qty_m:
            head = line[:qty_m.start()].strip()
            cleaned_head = _clean_fd_desc(head)
            # If this line carries its own description, that wins — discard any
            # buffered text (which belonged to the previous item's sub-bullets).
            if cleaned_head:
                desc = cleaned_head
            elif desc_buffer:
                desc = ' '.join(desc_buffer)
            else:
                desc = ''
            desc_buffer = []
            in_avnote = False

            # pdfplumber sometimes renders the em-dash as U+FFFD for this PDF's font.
            # Keep the trailing dash if present — it's a wrap marker for continuation.
            desc = desc.replace('�', '–').strip()
            if desc:
                items.append({
                    'qty':  f"{qty_m.group(1)} {qty_m.group(2)}",
                    'item': desc,
                })
                just_appended = True
            continue

        # No qty token: in-progress note, a continuation of the previous item, or
        # a fragment for the *next* item.
        if in_avnote:
            notes_lines.append(line)
            continue

        # Continuation when the prior item description wrapped after a comma/dash
        if items and items[-1]['item'].endswith((',', '–', '-')):
            items[-1]['item'] = items[-1]['item'].rstrip() + ' ' + line
            just_appended = True
            continue

        candidate = re.sub(r'^\d{6,}\s+', '', line).strip()

        # Short-word wrap right after an item-bearing line (e.g. "Package",
        # "Classroom", "Delivered" that wrapped to its own line)
        if (was_appended and items and not _is_subcontent(candidate)
                and len(candidate.split()) <= 2):
            items[-1]['item'] = items[-1]['item'] + ' ' + candidate
            just_appended = True
            continue

        # Description fragment for the upcoming item
        if _is_subcontent(candidate):
            continue
        desc_buffer.append(candidate)

    return items, '\n'.join(notes_lines).strip()


def _parse_function_date_page(text: str, prev_meta: dict | None) -> list[dict]:
    """Parse a single page of a 'Services by Function Date' PDF. Returns 0 or 1 event."""
    lines = text.splitlines()

    # Carry-forward defaults in case a page omits the Event:/Status: header
    event_name   = prev_meta['event_name']   if prev_meta else ''
    event_number = prev_meta['event_number'] if prev_meta else ''
    status       = prev_meta['status']       if prev_meta else ''
    onsite       = prev_meta['onsite']       if prev_meta else ''
    mecs         = prev_meta['mecs']         if prev_meta else ''

    fn_row_idx       = None
    order_header_idx = None

    for i, raw in enumerate(lines):
        line = raw.strip()

        em = _FD_EVENT_RE.match(line)
        if em:
            event_number = em.group(1).strip()
            event_name   = em.group(2).strip()
            continue

        if line.startswith('Status:'):
            rest = line[len('Status:'):].strip()
            if 'MECS Contact:' in rest:
                rest, mecs_part = rest.split('MECS Contact:', 1)
                mecs = mecs_part.strip()
            if 'On-site Contact:' in rest:
                rest, onsite_part = rest.split('On-site Contact:', 1)
                onsite = onsite_part.strip()
            status = rest.strip()
            continue

        if _FD_FN_HEADER_RE.match(line) and fn_row_idx is None:
            fn_row_idx = i + 1
            continue

        if _FD_ORDER_HEADER_RE.match(line):
            order_header_idx = i
            continue

    if fn_row_idx is None or fn_row_idx >= len(lines):
        return []

    fnm = _FD_FN_ROW_RE.match(lines[fn_row_idx].strip())
    if not fnm:
        return []

    mon_abbr = fnm.group(2)
    day      = int(fnm.group(3))
    yr2      = int(fnm.group(4))
    start_t  = fnm.group(5)
    end_t    = fnm.group(6)
    rest     = fnm.group(7)

    month = _MONTHS_ABBR.get(mon_abbr, 1)
    year  = 2000 + yr2
    date_iso = f"{year}-{month:02d}-{day:02d}"

    room, service, attendance = _split_fd_room_service(rest)

    setup_items: list[dict] = []
    notes: str = ''
    if order_header_idx is not None:
        item_lines: list[str] = []
        for j in range(order_header_idx + 1, len(lines)):
            l = lines[j].strip()
            if _FD_FOOTER_RE.match(l) or _FD_PAGE_RE.match(l) or _FD_TOTAL_RE.match(l):
                break
            item_lines.append(l)
        setup_items, notes = _parse_fd_items(item_lines)

    ev = {
        'date':           date_iso,
        'start_time':     _pad_time(start_t),
        'end_time':       _pad_time(end_t),
        'room':           room,
        'service_type':   service,
        'attendance':     attendance,
        'event_name':     event_name,
        'event_number':   event_number,
        'onsite_contact': onsite,
        'mecs_contact':   mecs,
        'setup_items':    setup_items,
        'notes':          notes,
        'cancelled':      bool(_CANCEL_RE.search(event_name) or _CANCEL_RE.search(status)),
    }
    ev['_meta'] = {
        'event_name':   event_name,
        'event_number': event_number,
        'status':       status,
        'onsite':       onsite,
        'mecs':         mecs,
    }
    return [ev]


def _parse_services_by_function_date(pages: list[str]) -> list[dict]:
    """Parse all pages of a 'Services by Function Date' PDF."""
    events: list[dict] = []
    last_meta: dict | None = None

    for page_text in pages:
        for ev in _parse_function_date_page(page_text, last_meta):
            last_meta = ev.pop('_meta', last_meta)
            events.append(ev)
    return events


# ── Format 3: Daily Resources by Space - All Functions ────────────────────────
#
# This report lays events out in fixed-width columns:
#   Space | Start | End | Function/Event | Attend | Contact
# The Function/Event column is truncated to fit, so a trailing Contact name
# cannot be told apart from the event text by words alone.  We therefore parse
# positionally, using each word's x-coordinate to assign it to a column.
# Column x-boundaries (points) are stable across the whole report:
_BS_ROOM_MAX_X    = 125    # Space column ends before ~125
_BS_TIME_MAX_X    = 200    # Start/End (time range) sits between ROOM_MAX and here
_BS_CONTACT_MIN_X = 531    # Contact column begins at ~537

_BS_HEADER_RE  = re.compile(r'^Space\s+Start\s+End\s+Function')
_BS_BOOKING_RE = re.compile(r'^#(\d+)$')
_BS_TIME_RE    = re.compile(r'(\d{1,2}:\d{2})\D+(\d{1,2}:\d{2})')
_BS_ATT_RE     = re.compile(r'^\(?(\d+)\s*PPL\)?$', re.IGNORECASE)
_BS_ONSITE_RE  = re.compile(r'^(.*?)Onsite:\s*(.*)$')
# Item rows carry a quantity and a price before the unit, e.g.
#   "1.0 0.00 EA Room Set Diagram" · "13.0 40.00 /HR Technician" · "1.0 (350.00)EA Discount"
_BS_ITEM_RE    = re.compile(
    r'^(\d+(?:\.\d+)?)\s+\(?[\d,]+\.\d{2}\)?\s*(/?(?:EA|HR|PRS))\b\s*(.*)$'
)


def _is_by_space_format(text: str) -> bool:
    """Detect the third PDF format by its title or its column-header row."""
    if 'Daily Resources by Space' in text:
        return True
    return bool(_BS_HEADER_RE.search(text))


def _cluster_words(words: list[dict], tol: float = 3.0) -> list[list[dict]]:
    """Group extract_words() output into visual lines, each sorted left→right."""
    lines: list[list[dict]] = []
    for w in sorted(words, key=lambda x: (x['top'], x['x0'])):
        for ln in lines:
            if abs(ln[0]['top'] - w['top']) <= tol:
                ln.append(w)
                break
        else:
            lines.append([w])
    return [sorted(ln, key=lambda x: x['x0']) for ln in lines]


def _parse_bs_event_header(words: list[dict]) -> dict | None:
    """Positionally parse a Space/Start/End/... event row → event dict or None."""
    booking = None
    booking_idx = None
    for i, w in enumerate(words):
        m = _BS_BOOKING_RE.match(w['text'])
        if m:
            booking, booking_idx = m.group(1), i
            break
    if booking is None:
        return None

    time_txt = ' '.join(
        w['text'] for w in words if _BS_ROOM_MAX_X <= w['x0'] < _BS_TIME_MAX_X
    )
    tm = _BS_TIME_RE.search(time_txt)
    if not tm:
        return None  # no time range → not a real event header

    room = ' '.join(w['text'] for w in words if w['x0'] < _BS_ROOM_MAX_X).strip()

    attend = ''
    contact_words: list[str] = []
    func_words: list[str] = []
    for w in words[booking_idx + 1:]:
        if w['x0'] >= _BS_CONTACT_MIN_X:
            contact_words.append(w['text'])
            continue
        am = _BS_ATT_RE.match(w['text'])
        if am:
            attend = f"{am.group(1)} PPL"
            continue
        func_words.append(w['text'])

    function = ' '.join(func_words).strip()
    # The Function/Event column is "Event Name: Function Type"
    if ':' in function:
        name, _, ftype = function.partition(':')
        event_name, service_type = name.strip(), ftype.strip()
    else:
        event_name, service_type = function, ''

    return {
        'date':           '',            # filled in by the caller
        'start_time':     _pad_time(tm.group(1)),
        'end_time':       _pad_time(tm.group(2)),
        'room':           room,
        'service_type':   service_type,
        'attendance':     attend,
        'event_name':     event_name,
        'event_number':   booking,
        'onsite_contact': '',
        'mecs_contact':   ' '.join(contact_words).strip(),
        'department':     '',
        'setup_items':    [],
        'notes':          '',
        'layout_image':   '',
        'layout_images':  [],
        'cancelled':      bool(_CANCEL_RE.search(function)),
        'booking':        booking,
    }


def _doc_pos(page_number: int, top: float) -> int:
    """A single monotonically-increasing coordinate for an item's position in the
    document (page first, then vertical offset), used to match diagrams to events."""
    return page_number * 100_000 + int(top)


def _extract_bs_layout(page, img: dict, event: dict, layout_dir: str) -> None:
    """Render an embedded Room Set Diagram to a clean PNG and attach it.

    A single function can carry several diagrams (one per continuation page), so
    images are appended to ``layout_images``; ``layout_image`` keeps the first for
    backward compatibility with older data and single-image UI checks.
    """
    bbox = (
        max(img['x0'], 0), max(img['top'], 0),
        min(img['x1'], page.width), min(img['bottom'], page.height),
    )
    try:
        os.makedirs(layout_dir, exist_ok=True)
        pil = page.crop(bbox).to_image(resolution=150).original
        room_slug = re.sub(r'[^A-Za-z0-9]+', '', event['room']) or 'room'
        fname = f"layout_{event['booking']}_{room_slug}_p{page.page_number}.png"
        pil.save(os.path.join(layout_dir, fname))
        imgs = event.setdefault('layout_images', [])
        if fname not in imgs:
            imgs.append(fname)
        if not event.get('layout_image'):
            event['layout_image'] = fname
    except Exception as exc:  # rendering is best-effort — never fail the upload
        print(f"[parser] layout render failed on page {page.page_number}: {exc}")


def _parse_by_space_pdf(pdf_path: str) -> list[dict]:
    """Parse a 'Daily Resources by Space - All Functions' PDF."""
    events: list[dict] = []
    current_date = ''
    current_ev: dict | None = None
    layout_dir = os.path.join(os.path.dirname(os.path.abspath(pdf_path)), 'layouts')

    # Each embedded diagram belongs to exactly one event, but the two can't be
    # paired by count/order alone: some room-set events carry no image while a
    # diagram can overflow onto a later page. Instead we record the document
    # position (page + vertical offset) of every event header and every image,
    # then attach each image to the event whose header most recently began at or
    # before it.
    event_positions: list[tuple[int, dict]] = []       # (doc_pos, event)
    page_images: list[tuple[int, object, dict]] = []   # (doc_pos, page, img)

    with pdfplumber.open(pdf_path) as pdf:
        for page in pdf.pages:
            if page.images:
                largest = max(page.images, key=lambda im: im['width'] * im['height'])
                page_images.append((_doc_pos(page.page_number, largest['top']), page, largest))

            for line in _cluster_words(page.extract_words()):
                text = ' '.join(w['text'] for w in line).strip()
                if not text:
                    continue

                # Date header — "Friday, July 24, 2026"
                dm = _DATE_RE.match(text)
                if dm:
                    current_date = (
                        f"{dm.group(3)}-{_MONTHS.get(dm.group(1), 1):02d}-{int(dm.group(2)):02d}"
                    )
                    continue

                # Page chrome
                if (_BS_HEADER_RE.match(text)
                        or text.startswith('Daily Resources')
                        or text in ('Burnaby', 'All Departments', 'MECS')
                        or _FD_FOOTER_RE.match(text)
                        or _FD_PAGE_RE.search(text)):
                    continue

                # Event header row?
                header = _parse_bs_event_header(line)
                if header is not None:
                    header['date'] = current_date
                    current_ev = header
                    events.append(current_ev)
                    event_positions.append(
                        (_doc_pos(page.page_number, min(w['top'] for w in line)), current_ev)
                    )
                    continue

                if current_ev is None:
                    continue

                # Service / Onsite / Status line, e.g.
                #   "Facilities Services: Onsite: Chris"  ·  "Onsite: Curtis"
                #   "Event Status: Tentative Onsite: Alicia"
                om = _BS_ONSITE_RE.match(text)
                if om:
                    prefix, onsite = om.group(1).strip(), om.group(2).strip()
                    current_ev['onsite_contact'] = onsite
                    if 'Event Status:' in prefix:
                        status = prefix.split('Event Status:', 1)[1].strip()
                        if _CANCEL_RE.search(status):
                            current_ev['cancelled'] = True
                    elif prefix:
                        # The prefix names the department/service provider
                        current_ev['department'] = prefix.rstrip(':').strip()
                    continue

                # Item row — "1.0 0.00 EA Room Set Diagram"
                im = _BS_ITEM_RE.match(text)
                if im:
                    qty, unit, name = im.group(1), im.group(2), im.group(3).strip()
                    name = name.replace('�', '-').strip()
                    current_ev['setup_items'].append({
                        'qty':  f"{qty} {unit}",
                        'item': name,
                    })
                    continue

                # Continuation of the previous item (skip HDMI boilerplate)
                if current_ev['setup_items'] and not _is_boilerplate(text):
                    last = current_ev['setup_items'][-1]
                    if 'Rooms Built-in Equipment' not in last['item']:
                        last['item'] += '\n' + text
                    continue

        # Attach each embedded diagram to its owning event by document position:
        # the event whose header most recently began at or before the image.
        event_positions.sort(key=lambda ep: ep[0])
        for img_pos, page, img in page_images:
            owner = None
            for ep_pos, ev in event_positions:
                if ep_pos <= img_pos:
                    owner = ev
                else:
                    break
            if owner is not None:
                _extract_bs_layout(page, img, owner, layout_dir)

    for ev in events:
        ev.pop('booking', None)
    return events


def extract_pages(pdf_path: str) -> list[str]:
    pages = []
    with pdfplumber.open(pdf_path) as pdf:
        for page in pdf.pages:
            pages.append(page.extract_text() or '')
    return pages


def _dedupe_events(events: list[dict]) -> list[dict]:
    """Merge events that share (date, start, end, room, service_type).

    The "by Space" report can list the same function twice — once with full
    facilities detail (setup items + layout diagram) and once as a bare line.
    Collapse those into a single event, keeping the richest value of each field.
    """
    merged: dict[tuple, dict] = {}
    order: list[tuple] = []
    for e in events:
        key = (e.get('date', ''), e.get('start_time', ''), e.get('end_time', ''),
               e.get('room', ''), e.get('service_type', ''))
        if key not in merged:
            merged[key] = e
            order.append(key)
            continue
        m = merged[key]
        if len(e.get('setup_items', [])) > len(m.get('setup_items', [])):
            m['setup_items'] = e['setup_items']
        # A function that spans several continuation pages is emitted as one
        # duplicate per page, each carrying its own diagram — union them so every
        # page's Room Set Diagram is kept, not just the first.
        m_imgs = m.setdefault('layout_images', [])
        for img in e.get('layout_images', []) or []:
            if img not in m_imgs:
                m_imgs.append(img)
        if not m.get('layout_image') and m_imgs:
            m['layout_image'] = m_imgs[0]
        for f in ('event_name', 'event_number', 'onsite_contact', 'mecs_contact',
                  'attendance', 'notes', 'department'):
            if not m.get(f) and e.get(f):
                m[f] = e[f]
        m['cancelled'] = m.get('cancelled') or e.get('cancelled')
    return [merged[k] for k in order]


def extract_and_parse_pdf(pdf_path: str, pdf_source: str = '') -> list[dict]:
    """
    Extract text from every page and parse events with regex. Auto-detects which
    of the two MECS PDF formats is in use. No API key required.
    """
    pages = extract_pages(pdf_path)
    full_text = '\n'.join(pages)

    if _is_by_space_format(full_text):
        events = _parse_by_space_pdf(pdf_path)
        fmt = 'Daily Resources by Space'
    elif _is_services_by_function_format(full_text):
        events = _parse_services_by_function_date(pages)
        fmt = 'Services by Function Date'
    else:
        all_lines: list[str] = []
        for page_text in pages:
            all_lines.extend(page_text.splitlines())
        events = _parse_lines(all_lines)
        fmt = 'Daily Resources by Setup Time'

    events = _dedupe_events(events)

    label = pdf_source or os.path.basename(pdf_path)
    for ev in events:
        ev['pdf_source'] = label
        ev.setdefault('layout_image', '')
        ev.setdefault('layout_images', [])
        ev.setdefault('department', '')

    print(f"[parser] Parsed {len(events)} events from {len(pages)} pages [{fmt}].")
    return events
