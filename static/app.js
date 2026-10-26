'use strict';

// ── Soft colour palette (one per unique event name) ───────────────────────
const PALETTE = [
  '#5b8db8', // steel blue
  '#5c9e78', // sage green
  '#c47c5a', // terracotta
  '#8a72b8', // soft purple
  '#3d9dad', // teal
  '#b8607a', // dusty rose
  '#5d9e6e', // forest green
  '#b07840', // warm amber
  '#5a7fb0', // slate blue
  '#7a9e50', // olive green
  '#9468a0', // mauve
  '#c2983a', // gold
  '#3d8a92', // dark teal
  '#7070b8', // periwinkle
  '#a06850', // sienna
];

const _colorCache = {};
function eventColor(name) {
  if (_colorCache[name]) return _colorCache[name];
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (Math.imul(31, h) + name.charCodeAt(i)) | 0;
  const color = PALETTE[Math.abs(h) % PALETTE.length];
  _colorCache[name] = color;
  return color;
}

// ── Track which event is open in the detail modal ────────────────────────
let _currentEventId = null;

// ── Identity (username in localStorage, no accounts) ──────────────────────
const USERNAME_KEY = 'hygd_username';

function getUsername() {
  return (localStorage.getItem(USERNAME_KEY) || '').trim();
}

function setUsername(name) {
  name = (name || '').trim().slice(0, 60);
  if (name) localStorage.setItem(USERNAME_KEY, name);
  renderIdentity();
  return name;
}

// Prompt once on first visit; a blank/cancelled prompt is allowed — we ask
// again when they first try to post a note.
function ensureUsername() {
  if (!getUsername()) {
    const name = (prompt('Enter your name (shown on notes you add):') || '').trim();
    if (name) setUsername(name);
  }
  renderIdentity();
}

function renderIdentity() {
  const el = document.getElementById('identity');
  if (!el) return;
  const name = getUsername();
  el.innerHTML = name
    ? `Signed in as <strong>${escHtml(name)}</strong> · <a href="#" onclick="App.changeName();return false;">change</a>`
    : `<a href="#" onclick="App.changeName();return false;">Set your name</a>`;
}

// ── Unread comment tracking (per-browser, no accounts) ─────────────────────
// Remembers the newest note id we've seen on each event. Note ids only ever
// increase, so anything above it, written by someone else, is unread. Events
// never opened in this browser fall back to a "floor" id set on first visit,
// so a new browser doesn't flag every comment ever posted.
const SEEN_NOTES_KEY  = 'hygd_seen_note_ids';  // { eventId: lastSeenNoteId }
const SEEN_FLOOR_KEY  = 'hygd_seen_floor';
const LEGACY_SEEN_KEY = 'hygd_seen_notes';     // old per-event *count* map

let _unread = [];         // unread notes across all events, newest first
let _unreadByEvent = {};  // eventId (string) → unread count

function _seenIdMap() {
  try { return JSON.parse(localStorage.getItem(SEEN_NOTES_KEY) || '{}'); } catch (_) { return {}; }
}

function _saveSeenIdMap(map) {
  try { localStorage.setItem(SEEN_NOTES_KEY, JSON.stringify(map)); } catch (_) {}
}

// null until the first unread fetch has set it
function _seenFloor() {
  let v = NaN;
  try { v = parseInt(localStorage.getItem(SEEN_FLOOR_KEY), 10); } catch (_) {}
  return isNaN(v) ? null : v;
}

// Newest note id on this event we count as already seen.
function lastSeenNoteId(id) {
  const floor = _seenFloor();
  // Before the floor exists we can't tell what's new, so treat it all as seen.
  if (floor == null) return Number.MAX_SAFE_INTEGER;
  return Math.max(floor, _seenIdMap()[id] || 0);
}

// Records that we've viewed every note in `notes` on this event, and drops the
// event from the unread list. Flags the view as dirty when that clears unread
// comments, so the calendar / grouped panel refresh their indicators on close.
function markNotesSeen(id, notes) {
  id = String(id);
  const maxId = notes.reduce((m, n) => Math.max(m, n.id), 0);
  const map = _seenIdMap();
  if (maxId > (map[id] || 0)) { map[id] = maxId; _saveSeenIdMap(map); }
  if (_unreadByEvent[id]) {
    _unread = _unread.filter(n => String(n.event_id) !== id || n.id > maxId);
    _indexUnread();
    _notesTouched = true;
    updateUnseenBadge();
  }
}

// How many of an event's comments haven't been viewed in this browser yet.
function unseenNoteCount(id) {
  return _unreadByEvent[String(id)] || 0;
}

function _indexUnread() {
  _unreadByEvent = {};
  for (const n of _unread) {
    const k = String(n.event_id);
    _unreadByEvent[k] = (_unreadByEvent[k] || 0) + 1;
  }
}

// Ask the server which comments are new for us — across every event, not just
// the calendar's visible range — and refresh the header inbox.
async function refreshUnread() {
  const floor = _seenFloor();
  try {
    const res = await fetch('/api/comments/unread', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ seen: _seenIdMap(), floor: floor ?? 0, me: getUsername() }),
    });
    if (!res.ok) return;
    const data = await res.json();
    if (floor == null) {
      // First visit with id-based tracking: start from now.
      try {
        localStorage.setItem(SEEN_FLOOR_KEY, String(data.max_id || 0));
        localStorage.removeItem(LEGACY_SEEN_KEY);
      } catch (_) {}
      _unread = [];
    } else {
      _unread = data.notes || [];
    }
    _indexUnread();
    updateUnseenBadge();
  } catch (_) {}
}

// ── Notes thread (append-only, attributed, 4s polling while modal open) ────
let _notesPollTimer = null;
let _currentNotes   = [];
let _noteImages     = [];      // File objects staged for the next note post
const _MAX_NOTE_IMAGES = 10;
let _notesTouched   = false;   // note count changed while modal open → refresh line indicators on close
let _checklistTouched = false; // setup checkboxes changed → refresh complete-state styling on close
let _newAfterId     = Number.MAX_SAFE_INTEGER; // notes above this id get the "New" divider
let _scrollToNew    = false;   // scroll the divider into view on the next render

// The fixed reaction set (mirrors REACTION_EMOJIS in app.py)
const REACTIONS = ['👍', '❤️', '😂', '😮', '🎉', '👀', '✅', '🙏'];

async function loadNotes(eventId) {
  try {
    const res = await fetch(`/api/events/${eventId}/notes`);
    if (!res.ok) return;
    _currentNotes = await res.json();
    renderNotes(_currentNotes);
    syncNoteCount(eventId, _currentNotes.length);
    markNotesSeen(eventId, _currentNotes);
  } catch (_) {}
}

// Keep the cached note count in step with the thread so the ★ line indicator
// stays correct. Flags the view as dirty when it changes so we can refresh the
// calendar / grouped panel once the modal closes.
function syncNoteCount(id, count) {
  const raw  = _eventsById[id];
  const prev = raw ? (raw.extendedProps.note_count || 0) : count;
  if (raw) raw.extendedProps.note_count = count;
  const fcEv = calendar.getEventById(String(id));
  if (fcEv) fcEv.setExtendedProp('note_count', count);
  if (prev !== count) _notesTouched = true;
}

function renderNotes(notes) {
  const list = document.getElementById('notes-list');
  if (!list) return;
  // Don't stomp on an inline edit or an open reaction picker (e.g. a poll tick)
  if (list.querySelector('.note-item.editing, .reaction-picker')) return;

  const syncEl = document.getElementById('notes-sync');
  if (syncEl) syncEl.textContent = notes.length
    ? `${notes.length} comment${notes.length !== 1 ? 's' : ''}` : '';

  if (!notes.length) {
    list.innerHTML = '<div class="notes-empty text-muted small">No notes yet — add the first one below.</div>';
    return;
  }

  const me = getUsername();
  const firstNew = notes.find(n => n.id > _newAfterId && n.author !== me);
  list.innerHTML = notes.map(n => {
    const mine  = !!me && n.author === me;
    const stamp = fmtNoteTime(n.created_at) + (n.updated_at ? ' · edited' : '');
    const actions = `
        <span class="note-actions">
          <button class="note-action reaction-add" title="Add reaction" onclick="App.toggleReactionPicker(${n.id})"><i class="bi bi-emoji-smile"></i></button>
          ${mine ? `
          <button class="note-action" title="Edit" onclick="App.editNote(${n.id})"><i class="bi bi-pencil"></i></button>
          <button class="note-action" title="Delete" onclick="App.deleteNote(${n.id})"><i class="bi bi-trash3"></i></button>` : ''}
        </span>`;
    const imgs = (n.images || []).length
      ? `<div class="note-images">${n.images.map(fn => `
           <a href="/note-images/${encodeURIComponent(fn)}" target="_blank" rel="noopener"
              title="Open full-size photo">
             <img class="note-image-thumb" src="/note-images/${encodeURIComponent(fn)}"
                  alt="Photo attached by ${escHtml(n.author)}" loading="lazy">
           </a>`).join('')}</div>`
      : '';
    const divider = n === firstNew
      ? '<div class="notes-new-divider" id="notes-new-divider"><span>New</span></div>' : '';
    return `${divider}<div class="note-item${mine ? ' mine' : ''}" data-note-id="${n.id}">
        <div class="note-head">
          <span class="note-author">${escHtml(n.author)}</span>
          <span class="note-time">${escHtml(stamp)}</span>
          ${actions}
        </div>
        ${n.text ? `<div class="note-text">${escHtml(n.text).replace(/\n/g, '<br>')}</div>` : ''}
        ${imgs}
        ${reactionChips(n, me)}
      </div>`;
  }).join('');

  if (_scrollToNew) {
    _scrollToNew = false;
    const div = document.getElementById('notes-new-divider');
    if (div) div.scrollIntoView({ block: 'center' });
  }
}

// Existing reactions under a note: one chip per emoji with its count, tinted
// when it includes yours; tapping a chip toggles your own reaction.
function reactionChips(n, me) {
  const rs = n.reactions || [];
  if (!rs.length) return '';
  return `<div class="note-reactions">${rs.map(r => {
    const idx = REACTIONS.indexOf(r.emoji);
    if (idx < 0) return '';
    const mine = !!me && r.authors.includes(me);
    return `<button type="button" class="reaction-chip${mine ? ' mine' : ''}"
              title="${escHtml(r.authors.join(', '))}"
              onclick="App.react(${n.id}, ${idx})">${r.emoji}<span>${r.authors.length}</span></button>`;
  }).join('')}</div>`;
}

function closeReactionPicker() {
  const picker = document.querySelector('.reaction-picker');
  if (picker) picker.remove();
}

// Show staged (not-yet-posted) photo thumbnails with a remove button each.
function renderNoteImagePreview() {
  const box = document.getElementById('note-image-preview');
  if (!box) return;
  box.innerHTML = _noteImages.map((f, i) => `
    <span class="note-image-chip">
      <img src="${URL.createObjectURL(f)}" alt="${escHtml(f.name)}">
      <button type="button" class="note-image-remove" title="Remove"
              onclick="App.removeNoteImage(${i})">&times;</button>
    </span>`).join('');
}

function startNotesPoll(eventId) {
  stopNotesPoll();
  _notesPollTimer = setInterval(() => loadNotes(eventId), 4000);
}

function stopNotesPoll() {
  if (_notesPollTimer) { clearInterval(_notesPollTimer); _notesPollTimer = null; }
}

// "2026-07-28 14:03:12" (SQLite UTC) → localized short date + time
function fmtNoteTime(ts) {
  if (!ts) return '';
  const d = new Date(ts.replace(' ', 'T') + 'Z');
  if (isNaN(d)) return ts;
  return d.toLocaleString('en-CA', {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
  });
}

// ── Filtering (for Event Assistants) ──────────────────────────────────────
// ALL_EVENTS holds every event in the current calendar range; the toolbar and
// filters are derived from it, and the calendar renders only the matching subset.
let ALL_EVENTS = [];
let _eventsById = {};
let groupedMode = false;
let showHidden  = false;   // reveal events that users have hidden
// Past events are shown by default (greyed + badged, never auto-hidden). The
// "past" detection currently mis-flags some events that haven't started yet
// (suspected server-vs-venue timezone mismatch in group_past), so auto-hiding is
// disabled until that's fixed — the toggle can still collapse them manually.
let showPast    = true;    // reveal events whose group's last instance has passed
const FILTERS = { depts: new Set(), q: '', cancelledOnly: false };
let _searchTimer = null;   // debounce handle for the search box

// ── Saved filters (per-browser) ───────────────────────────────────────────
// Department chips, search text and the cancelled toggle survive a reload, so
// e.g. Security staff land straight on their own events each visit.
const FILTERS_KEY = 'hygd_filters';

function saveFilters() {
  const search = document.getElementById('event-search');
  const saved = {
    depts: [...FILTERS.depts],
    q: search ? search.value : FILTERS.q,
    cancelledOnly: FILTERS.cancelledOnly,
  };
  try { localStorage.setItem(FILTERS_KEY, JSON.stringify(saved)); } catch (_) {}
}

function loadFilters() {
  let saved;
  try { saved = JSON.parse(localStorage.getItem(FILTERS_KEY) || 'null'); } catch (_) { return; }
  if (!saved || typeof saved !== 'object') return;
  if (Array.isArray(saved.depts)) {
    saved.depts.forEach(d => { if (typeof d === 'string') FILTERS.depts.add(d); });
  }
  if (typeof saved.q === 'string') {
    FILTERS.q = saved.q.trim().toLowerCase();
    const search = document.getElementById('event-search');
    if (search) search.value = saved.q;
  }
  FILTERS.cancelledOnly = saved.cancelledOnly === true;
}

// ── Multi-select (bulk delete) ────────────────────────────────────────────
// In select mode, clicking an event ticks it instead of opening it. The
// selection survives date navigation, so you can gather events across days.
let selectMode = false;
const SELECTED = new Map();   // event id (string) → label used in the confirm

function selectionLabel(raw) {
  const d = parseLocalISO(raw.start);
  const when = d ? d.toLocaleDateString('en-CA', { month: 'short', day: 'numeric' }) : '';
  const room = raw.extendedProps.room ? ` · ${raw.extendedProps.room}` : '';
  return `${raw.title}${when ? ` (${when}${room})` : ''}`;
}

function setSelected(id, on) {
  id = String(id);
  const raw = _eventsById[id];
  if (on && raw) SELECTED.set(id, selectionLabel(raw));
  else           SELECTED.delete(id);
  document.querySelectorAll(`[data-event-id="${id}"]`)
    .forEach(el => el.classList.toggle('event-selected', SELECTED.has(id)));
}

function updateSelectBar() {
  const bar = document.getElementById('select-bar');
  if (!bar) return;
  bar.classList.toggle('d-none', !selectMode);
  document.body.classList.toggle('selecting', selectMode);
  document.getElementById('calendar-wrap').classList.toggle('select-mode', selectMode);
  const btn = document.getElementById('select-btn');
  if (btn) btn.classList.toggle('active', selectMode);

  const n = SELECTED.size;
  const shown = new Set(applyFilters(ALL_EVENTS).map(e => e.id));
  const offscreen = [...SELECTED.keys()].filter(id => !shown.has(id)).length;
  document.getElementById('select-count').textContent = n
    ? `${n} selected${offscreen ? ` (${offscreen} not shown)` : ''}`
    : 'Tap events to select them';
  const del = document.getElementById('select-delete-btn');
  del.disabled = n === 0;
  del.querySelector('.select-delete-label').textContent =
    n ? `Delete ${n}` : 'Delete';
}

// ── FullCalendar ──────────────────────────────────────────────────────────
let calendar;

document.addEventListener('DOMContentLoaded', () => {
  loadFilters();   // before the first fetch, so it renders already filtered
  const el = document.getElementById('calendar');

  calendar = new FullCalendar.Calendar(el, {
    initialView: 'listDay',
    headerToolbar: toolbarFor(isMobile()),
    buttonText: {
      today:    'Today',
      listDay:  'Day',
      listWeek: 'Week',
      dayGridMonth: 'Month',
    },
    // "Jump to a date" button sitting next to the title — opens the native
    // date picker and navigates the calendar there (mirrors the grouped view).
    customButtons: {
      datePicker: {
        text: '📅',
        hint: 'Jump to a date',
        click: () => openDatePicker(document.querySelector('.fc-datePicker-button')),
      },
    },
    noEventsContent: 'No events match the current filters',
    events: fetchEvents,
    datesSet() {
      // Keep the grouped toolbar's range title / active button in sync with
      // whatever range the calendar is showing (grouped mode navigates via it).
      updateGroupedToolbar();
    },
    eventClick(info) {
      if (selectMode) { App.toggleSelect(info.event.id); return; }
      showEventModal(info.event);
    },
    eventDidMount(info) {
      const props  = info.event.extendedProps;
      const key    = props.group_key || info.event.title;

      const isList = info.view.type.startsWith('list');
      const color  = props.status === 'cancelled' ? '#9e9e9e' : eventColor(key);

      if (isList) {
        // List view: colour the leading dot, not the whole row
        const dot = info.el.querySelector('.fc-list-event-dot');
        if (dot) dot.style.borderColor = color;
      } else {
        info.el.style.backgroundColor = color;
        info.el.style.borderColor     = color;
      }

      if (props.status === 'cancelled') {
        info.el.style.opacity        = '0.6';
        info.el.style.textDecoration = 'line-through';
        info.el.title = '⚠ CANCELLED — ' + info.event.title;
      }
      if (props.hidden) {
        info.el.classList.add('event-hidden');
      }
      info.el.dataset.eventId = info.event.id;
      if (SELECTED.has(String(info.event.id))) info.el.classList.add('event-selected');
      if (eventIsComplete(props)) info.el.classList.add('event-complete');
      if (eventIsPast(props)) info.el.classList.add('event-past');
      decorateEvent(info, isList);
    },
    loading(isLoading) {
      if (!isLoading) refreshBadge();
    },
    height: '100%',
    slotMinTime: '07:00:00',
    slotMaxTime: '22:00:00',
    nowIndicator: true,
    eventMaxStack: 4,
  });

  calendar.render();
  refreshBadge();

  // Background refresh so a comment someone else adds shows up as a live
  // notification (unseen badge / ★ flag) without needing a manual reload.
  // Skipped while an event's notes are already open — that thread has its
  // own 4s poll — and while the tab is in the background.
  setInterval(() => {
    if (document.hidden || _currentEventId != null) return;
    calendar.refetchEvents();
  }, 60000);

  // Swap the calendar toolbar for a compact one when crossing the mobile
  // breakpoint. Driven off window resize so it also fires on orientation change.
  let _wasMobile = isMobile();
  window.addEventListener('resize', () => {
    const nowMobile = isMobile();
    if (nowMobile !== _wasMobile) { _wasMobile = nowMobile; applyResponsiveToolbar(); }
  });

  // Stop polling this event's notes once the modal closes; if the note count
  // changed while it was open, refresh the line indicators (★) behind it.
  document.getElementById('eventModal').addEventListener('hide.bs.modal', () => {
    stopNotesPoll();
    _currentEventId = null;
    _noteImages = [];          // discard any photos staged but not posted
    if (_notesTouched || _checklistTouched) {
      _notesTouched = false;
      _checklistTouched = false;
      updateUnseenBadge();
      if (groupedMode) renderGrouped(applyFilters(ALL_EVENTS));
      else             calendar.refetchEvents();
    }
  });

  // Close the comment inbox / reaction picker when clicking anywhere else
  document.addEventListener('click', (e) => {
    if (inboxIsOpen() && !e.target.closest('#comment-inbox, #unseen-badge')) closeInbox();
    if (!e.target.closest('.reaction-picker, .reaction-add')) closeReactionPicker();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (inboxIsOpen()) closeInbox();
    else if (selectMode && !document.querySelector('.modal.show')) App.toggleSelectMode();
  });

  // Ask for a display name once (used to attribute notes), show it in the header
  ensureUsername();

  // Wire up the file input and drag-and-drop once the upload modal opens
  document.getElementById('uploadModal').addEventListener('show.bs.modal', initDropZone, { once: false });

  // Live event count when date range changes in the clear modal
  ['clear-start', 'clear-end'].forEach(id => {
    document.getElementById(id).addEventListener('change', updateClearCount);
  });
});

// ── Responsive calendar toolbar ────────────────────────────────────────────
function isMobile() {
  return window.matchMedia('(max-width: 576px)').matches;
}

function toolbarFor(mobile) {
  return mobile
    ? { left: 'prev,next today', center: 'title datePicker', right: 'listDay,dayGridMonth' }
    : { left: 'prev,next today', center: 'title datePicker', right: 'listDay,listWeek,dayGridMonth' };
}

function applyResponsiveToolbar() {
  const mobile = isMobile();
  calendar.setOption('headerToolbar', toolbarFor(mobile));
  calendar.setOption('titleFormat',
    mobile ? { month: 'short', day: 'numeric' } : undefined);
}

// ── Badge ─────────────────────────────────────────────────────────────────
async function refreshBadge() {
  try {
    const res  = await fetch('/api/stats');
    const data = await res.json();
    document.getElementById('event-count-badge').textContent =
      `${data.total} event${data.total !== 1 ? 's' : ''}`;
  } catch (_) {}
}

// Reflect how many events are hidden + whether they're currently revealed
function updateHiddenButton() {
  const btn = document.getElementById('hidden-btn');
  if (!btn) return;
  const count = ALL_EVENTS.filter(e => e.extendedProps.hidden).length;
  const icon  = btn.querySelector('i');
  const label = btn.querySelector('.btn-label');
  btn.classList.toggle('active', showHidden);
  if (icon)  icon.className = (showHidden ? 'bi bi-eye' : 'bi bi-eye-slash') + ' me-1';
  if (label) label.textContent =
    (showHidden ? 'Showing hidden' : 'Show hidden') + (count ? ` (${count})` : '');
}

// Reflect how many events are past + whether they're currently revealed
function updatePastButton() {
  const btn = document.getElementById('past-btn');
  if (!btn) return;
  const count = ALL_EVENTS.filter(e => e.extendedProps.group_past).length;
  const icon  = btn.querySelector('i');
  const label = btn.querySelector('.btn-label');
  btn.classList.toggle('active', showPast);
  if (icon)  icon.className = (showPast ? 'bi bi-clock' : 'bi bi-clock-history') + ' me-1';
  if (label) label.textContent =
    (showPast ? 'Showing past' : 'Show past') + (count ? ` (${count})` : '');
}

// Header pill: total unread comments across all events. Clicking it opens the
// inbox, which lists them by event so you can jump straight to each thread.
function updateUnseenBadge() {
  const badge = document.getElementById('unseen-badge');
  if (!badge) return;
  const total  = _unread.length;
  const events = Object.keys(_unreadByEvent).length;
  badge.classList.toggle('d-none', total === 0);
  if (total > 0) {
    badge.innerHTML = `<i class="bi bi-chat-dots-fill me-1"></i>${total}<span class="unseen-label"> new comment${total !== 1 ? 's' : ''}</span>`;
    badge.title = `${events} event${events !== 1 ? 's' : ''} with new comments — click to view`;
  } else {
    closeInbox();
  }
  if (inboxIsOpen()) renderInbox();
}

function inboxIsOpen() {
  const box = document.getElementById('comment-inbox');
  return !!box && !box.classList.contains('d-none');
}

function closeInbox() {
  const box = document.getElementById('comment-inbox');
  if (box) box.classList.add('d-none');
  const badge = document.getElementById('unseen-badge');
  if (badge) badge.setAttribute('aria-expanded', 'false');
}

// One row per event with unread comments, most recently active first.
function renderInbox() {
  const list = document.getElementById('comment-inbox-list');
  if (!list) return;
  const groups = [];
  const byEvent = {};
  for (const n of _unread) {           // _unread is newest first
    const k = String(n.event_id);
    if (!byEvent[k]) { byEvent[k] = { latest: n, count: 0 }; groups.push(byEvent[k]); }
    byEvent[k].count++;
  }
  const count = document.getElementById('comment-inbox-count');
  if (count) count.textContent = _unread.length;

  list.innerHTML = groups.map(({ latest: n, count }) => {
    const raw   = _eventsById[String(n.event_id)];
    const title = n.event_name || `${n.room || ''} – ${n.service_type || ''}`;
    const color = n.status === 'cancelled' ? '#9e9e9e'
      : eventColor((raw && raw.extendedProps.group_key) || title);
    const when  = fmtInboxDate(n.date, n.start_time);
    const body  = n.text
      ? escHtml(n.text.length > 140 ? n.text.slice(0, 140) + '…' : n.text)
      : '<i class="bi bi-image me-1"></i>Photo';
    const tags  = (n.status === 'cancelled' ? '<span class="inbox-tag">Cancelled</span>' : '')
      + (n.hidden ? '<span class="inbox-tag"><i class="bi bi-eye-slash"></i> Hidden</span>' : '');
    return `<button type="button" class="inbox-row" onclick="App.openFromInbox(${n.event_id})">
        <span class="inbox-dot" style="background:${color}"></span>
        <span class="inbox-main">
          <span class="inbox-event">${escHtml(title)}${tags}</span>
          <span class="inbox-when">${escHtml(when)}${n.room ? ` · ${escHtml(n.room)}` : ''}</span>
          <span class="inbox-snippet"><strong>${escHtml(n.author)}:</strong> ${body}</span>
          <span class="inbox-meta">${escHtml(fmtRelative(n.created_at))}${count > 1 ? ` · +${count - 1} more` : ''}</span>
        </span>
        <span class="inbox-count" title="${count} new">${count}</span>
      </button>`;
  }).join('');
}

// "2026-10-18", "14:00" → "Sat, Oct 18 · 14:00"
function fmtInboxDate(date, time) {
  if (!date) return '';
  const d = new Date(date + 'T00:00:00');
  const day = isNaN(d) ? date
    : d.toLocaleDateString('en-CA', { weekday: 'short', month: 'short', day: 'numeric' });
  return time ? `${day} · ${time}` : day;
}

// SQLite UTC timestamp → "just now" / "5m ago" / "3h ago" / "2d ago" / date
function fmtRelative(ts) {
  if (!ts) return '';
  const d = new Date(ts.replace(' ', 'T') + 'Z');
  if (isNaN(d)) return ts;
  const mins = Math.round((Date.now() - d) / 60000);
  if (mins < 1)  return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24)  return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  if (days < 7)  return `${days}d ago`;
  return fmtNoteTime(ts);
}

// ── Event fetching + filtering ────────────────────────────────────────────
async function fetchEvents(info, success, failure) {
  try {
    const qs  = info.startStr && info.endStr
      ? `?start=${info.startStr}&end=${info.endStr}` : '';
    // Unread comments are fetched alongside, so the comment chips drawn for
    // these events reflect the latest state.
    const [res] = await Promise.all([fetch(`/api/events${qs}`), refreshUnread()]);
    ALL_EVENTS = await res.json();
    _eventsById = {};
    for (const e of ALL_EVENTS) _eventsById[e.id] = e;
    buildFilterBar(ALL_EVENTS);
    buildLegend(ALL_EVENTS);
    updateHiddenButton();
    updatePastButton();
    updateUnseenBadge();
    if (selectMode) updateSelectBar();
    if (groupedMode) renderGrouped(applyFilters(ALL_EVENTS));
    success(applyFilters(ALL_EVENTS));
  } catch (err) {
    failure(err);
  }
}

function applyFilters(list) {
  return list.filter(e => {
    const p = e.extendedProps || {};
    if (!showHidden && p.hidden) return false;
    if (!showPast && p.group_past) return false;
    if (FILTERS.cancelledOnly && p.status !== 'cancelled') return false;
    if (FILTERS.depts.size && !FILTERS.depts.has(p.dept_category)) return false;
    if (FILTERS.q) {
      // Free-text search across event number, room/location, and event name
      const hay = `${p.event_number || ''} ${p.room || ''} ${e.title || ''}`.toLowerCase();
      if (!hay.includes(FILTERS.q)) return false;
    }
    return true;
  });
}

function buildFilterBar(list) {
  // Department chips (with counts), sorted by frequency
  const counts = {};
  for (const e of list) {
    const cat = e.extendedProps.dept_category || 'General';
    counts[cat] = (counts[cat] || 0) + 1;
  }
  // A saved/active department with nothing in this range still gets a chip,
  // so whatever is filtering the view stays visible and can be switched off.
  for (const cat of FILTERS.depts) if (!(cat in counts)) counts[cat] = 0;

  const chipWrap = document.getElementById('dept-filters');
  const cats = Object.keys(counts).sort((a, b) => counts[b] - counts[a] || a.localeCompare(b));
  const deptChips = cats.map(cat => {
    const active = FILTERS.depts.has(cat);
    return `<button class="dept-chip${active ? ' active' : ''}"
              onclick="App.toggleDept('${cat.replace(/'/g, "\\'")}')">
              ${escHtml(cat)} <span class="dept-chip-count">${counts[cat]}</span>
            </button>`;
  }).join('');

  // Status filter: show only cancelled events (sits alongside the dept chips)
  const cancelledCount = list.filter(e => e.extendedProps.status === 'cancelled').length;
  const cancelledChip = cancelledCount
    ? `<button class="dept-chip cancelled-chip${FILTERS.cancelledOnly ? ' active' : ''}"
              onclick="App.toggleCancelled()" title="Show only cancelled events">
         <i class="bi bi-x-octagon"></i>Cancelled
         <span class="dept-chip-count">${cancelledCount}</span>
       </button>`
    : '';

  chipWrap.innerHTML = (deptChips + cancelledChip)
    || '<span class="filter-empty">No events loaded</span>';

  updateFilterMeta(list.length);
}

function updateFilterMeta(total) {
  const shown  = applyFilters(ALL_EVENTS).length;
  const active = FILTERS.depts.size > 0 || !!FILTERS.q || FILTERS.cancelledOnly;
  const meta   = document.getElementById('filter-count');
  const clear  = document.getElementById('clear-filters');
  meta.textContent = active ? `Showing ${shown} of ${total}` : `${total} event${total !== 1 ? 's' : ''}`;
  clear.classList.toggle('d-none', !active);
}

// An event is "complete" when it's been explicitly marked done, OR (for events
// that carry setup items) once every item has been checked off. The manual flag
// is the only path for events with no tickable items.
function eventIsComplete(p) {
  if (p.manually_complete) return true;
  const total = (p.setup_items || []).length;
  if (!total) return false;
  const checked = (p.checked_items || []).filter(i => i < total).length;
  return checked >= total;
}

// An event is "past" once its group's LAST instance has passed. Computed
// server-side (across the whole schedule) and delivered as `group_past`.
function eventIsPast(p) {
  return !!(p && p.group_past);
}

// Label for the setup-progress badge — turns into a "✓ Complete" state.
function progressLabel(done, total) {
  return total > 0 && done >= total ? `✓ Complete (${done}/${total})` : `${done}/${total} done`;
}

// Add a layout marker + department tag to a rendered event
function decorateEvent(info, isList) {
  const p = info.event.extendedProps;
  const titleEl = info.el.querySelector('.fc-list-event-title')
               || info.el.querySelector('.fc-event-title');
  if (!titleEl) return;

  if (!titleEl.querySelector('.sel-box')) {
    const s = document.createElement('span');
    s.className = 'sel-box';
    s.innerHTML = '<i class="bi bi-square"></i><i class="bi bi-check-square-fill"></i>';
    titleEl.prepend(s);
  }
  // Event number — leading badge, mirrors how it reads on the source PDF (#191346 …)
  if (p.event_number && !titleEl.querySelector('.ev-number')) {
    const s = document.createElement('span');
    s.className = 'ev-number';
    s.textContent = `#${p.event_number}`;
    s.title = 'Event number';
    titleEl.prepend(s);
  }
  // Room / location — chip after the title, so it's visible without opening the event
  if (isList && p.room && !titleEl.querySelector('.ev-room')) {
    const s = document.createElement('span');
    s.className = 'ev-room';
    s.innerHTML = '<i class="bi bi-geo-alt-fill"></i> ';
    s.appendChild(document.createTextNode(p.room));
    s.title = 'Room / location';
    titleEl.appendChild(s);
  }

  if (p.layout_image && !titleEl.querySelector('.ev-flag')) {
    const s = document.createElement('span');
    s.className = 'ev-flag';
    s.textContent = ' 🗺';
    s.title = 'Room layout available';
    titleEl.appendChild(s);
  }
  if (p.note_count > 0 && !titleEl.querySelector('.note-flag')) {
    const unseen = unseenNoteCount(info.event.id);
    const s = document.createElement('span');
    s.className = 'note-flag' + (unseen > 0 ? ' has-unseen' : '');
    s.innerHTML = `<i class="bi bi-chat-dots-fill"></i> ${p.note_count}`;
    s.title = unseen > 0
      ? `${p.note_count} comment${p.note_count !== 1 ? 's' : ''} — ${unseen} new`
      : `${p.note_count} comment${p.note_count !== 1 ? 's' : ''}`;
    titleEl.appendChild(s);
  }
  if (p.hidden && !titleEl.querySelector('.hidden-flag')) {
    const s = document.createElement('span');
    s.className = 'hidden-flag';
    s.innerHTML = ' <i class="bi bi-eye-slash"></i>';
    s.title = 'Hidden event';
    titleEl.appendChild(s);
  }
  if (isList && p.dept_category && p.dept_category !== 'General'
      && !titleEl.querySelector('.dept-tag')) {
    const d = document.createElement('span');
    d.className = 'dept-tag';
    d.textContent = p.dept_category;
    titleEl.appendChild(d);
  }
  if (isList && eventIsComplete(p) && !titleEl.querySelector('.status-badge.complete')) {
    const b = document.createElement('span');
    b.className = 'status-badge complete';
    b.innerHTML = '<i class="bi bi-check-circle-fill me-1"></i>Complete';
    titleEl.appendChild(b);
  }
  if (isList && eventIsPast(p)
      && !titleEl.querySelector('.status-badge.past')) {
    const b = document.createElement('span');
    b.className = 'status-badge past';
    b.textContent = 'Past';
    titleEl.appendChild(b);
  }
}

// ── Grouped view (functions nested under each client booking) ──────────────
function enterGrouped() {
  groupedMode = true;
  document.getElementById('calendar').classList.add('d-none');
  document.getElementById('grouped-panel').classList.remove('d-none');
  const btn = document.getElementById('grouped-btn');
  btn.classList.add('active');
  btn.querySelector('.btn-label').textContent = 'Calendar';
  btn.querySelector('i').className = 'bi bi-calendar2-week me-1';
  document.getElementById('grouped-toolbar').classList.remove('d-none');
  updateGroupedToolbar();
  renderGrouped(applyFilters(ALL_EVENTS));
}

function exitGrouped() {
  groupedMode = false;
  document.getElementById('grouped-panel').classList.add('d-none');
  document.getElementById('grouped-toolbar').classList.add('d-none');
  document.getElementById('calendar').classList.remove('d-none');
  const btn = document.getElementById('grouped-btn');
  btn.classList.remove('active');
  btn.querySelector('.btn-label').textContent = 'Grouped';
  btn.querySelector('i').className = 'bi bi-diagram-3 me-1';
  calendar.updateSize();   // recompute now that the calendar is visible again
}

// Sync the grouped toolbar's range title + active range button to the calendar
function updateGroupedToolbar() {
  if (!calendar) return;
  const titleEl = document.getElementById('grouped-title');
  if (titleEl) titleEl.textContent = calendar.view.title;
  const view = calendar.view.type;
  document.querySelectorAll('#grouped-toolbar .gt-views .gt-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.range === view);
  });
}

// Keep only events whose start falls within the calendar's *principal* period
// (the actual day/week/month), not the padded grid range used for fetching. A
// month view loads spillover days from the adjacent months to fill the grid;
// grouped mode should ignore those and show only what happens in the period.
function withinCurrentPeriod(list) {
  if (!calendar) return list;
  const view    = calendar.view;
  const startMs = view.currentStart.getTime();
  const endMs   = view.currentEnd.getTime();   // exclusive
  return list.filter(e => {
    const s = parseLocalISO(e.start);
    if (!s) return false;
    const t = s.getTime();
    return t >= startMs && t < endMs;
  });
}

// A group's display name: the event title plus its booking number, so two
// bookings with the same name (e.g. weekly "HIVE Social") can be told apart.
function groupLabel(e, key) {
  const title = (e && e.title) || '';
  if (!key || !key.startsWith('#')) return title || key;
  return title && title !== key ? `${title} · ${key}` : key;
}

function renderGrouped(list) {
  const panel = document.getElementById('grouped-panel');

  // Restrict to events that actually start within the selected period.
  list = withinCurrentPeriod(list);

  // Bucket events by their colour-group key (client / event name)
  const groups = {};
  for (const e of list) {
    const key = e.extendedProps.group_key || e.title;
    (groups[key] ||= []).push(e);
  }

  const entries = Object.entries(groups).map(([key, evs]) => {
    evs.sort((a, b) => (a.start || '').localeCompare(b.start || ''));
    const starts = evs.map(e => e.start).filter(Boolean);
    const ends   = evs.map(e => e.end).filter(Boolean);
    // Distinct calendar dates the booking spans (start ISO → YYYY-MM-DD)
    const dates  = [...new Set(evs.map(e => (e.start || '').slice(0, 10)).filter(Boolean))].sort();
    return {
      key,
      name:   groupLabel(evs.find(e => e.title) || evs[0], key),
      color:  eventColor(key),
      events: evs,
      rooms:  new Set(evs.map(e => e.extendedProps.room).filter(Boolean)).size,
      layouts: evs.filter(e => e.extendedProps.layout_image).length,
      contact: evs.map(e => e.extendedProps.mecs_contact).find(Boolean) || '',
      minStart: starts.length ? starts.slice().sort()[0] : '',
      maxEnd:   ends.length ? ends.slice().sort().at(-1) : '',
      dateMin:  dates[0] || '',
      dateMax:  dates.at(-1) || '',
    };
  });

  // Chronological by first function of the day
  entries.sort((a, b) => (a.minStart || '').localeCompare(b.minStart || ''));

  if (!entries.length) {
    panel.innerHTML = '<div class="grouped-empty">No events match the current filters</div>';
    return;
  }

  panel.innerHTML = entries.map(g => {
    const span = g.minStart
      ? `${fmtTimeISO(g.minStart)}${g.maxEnd ? ' – ' + fmtTimeISO(g.maxEnd) : ''}`
      : '';
    const rows = g.events.map(e => {
      const p = e.extendedProps;
      const cancelled = p.status === 'cancelled';
      const deptTag = p.dept_category && p.dept_category !== 'General'
        ? `<span class="dept-tag">${escHtml(p.dept_category)}</span>` : '';
      const flag = p.layout_image ? '<span class="ev-flag" title="Room layout available">🗺</span>' : '';
      const unseen = unseenNoteCount(e.id);
      const noteFlag = p.note_count > 0
        ? `<span class="note-flag${unseen > 0 ? ' has-unseen' : ''}" title="${p.note_count} comment${p.note_count !== 1 ? 's' : ''}${unseen > 0 ? ` — ${unseen} new` : ''}"><i class="bi bi-chat-dots-fill"></i> ${p.note_count}</span>` : '';
      const hiddenFlag = p.hidden
        ? '<span class="hidden-flag" title="Hidden event"><i class="bi bi-eye-slash"></i></span>' : '';
      const complete = eventIsComplete(p);
      const past = eventIsPast(p);
      const completeBadge = complete
        ? '<span class="status-badge complete"><i class="bi bi-check-circle-fill me-1"></i>Complete</span>' : '';
      const pastBadge = past ? '<span class="status-badge past">Past</span>' : '';
      const selected = SELECTED.has(String(e.id));
      return `<button class="group-row${cancelled ? ' cancelled' : ''}${p.hidden ? ' hidden' : ''}${complete ? ' complete' : ''}${past ? ' past' : ''}${selected ? ' event-selected' : ''}"
                data-event-id="${e.id}" onclick="App.rowClick('${e.id}')">
          <span class="sel-box"><i class="bi bi-square"></i><i class="bi bi-check-square-fill"></i></span>
          <span class="group-row-time">${escHtml(fmtTimeISO(e.start))}${e.end ? '–' + escHtml(fmtTimeISO(e.end)) : ''}</span>
          <span class="group-row-room">${escHtml(p.room || '—')}</span>
          <span class="group-row-fn">${escHtml(p.service_type || e.title)}${flag}${noteFlag}${hiddenFlag}${deptTag}${completeBadge}${pastBadge}</span>
        </button>`;
    }).join('');

    // Mass hide/unhide for the whole booking. "Unhide all" only when every
    // shown event in the group is already hidden.
    const groupIds  = g.events.map(e => e.id).join(',');
    const allHidden = g.events.every(e => e.extendedProps.hidden);
    const hideGroupBtn = `<button class="group-hide-btn" data-ids="${groupIds}" data-hide="${allHidden ? '0' : '1'}"
            title="${allHidden ? 'Unhide all events in this group' : 'Hide all events in this group'}"
            onclick="event.preventDefault();event.stopPropagation();App.hideGroup(this)">
            <i class="bi bi-eye${allHidden ? '' : '-slash'} me-1"></i>${allHidden ? 'Unhide all' : 'Hide all'}
          </button>`;

    // Select / deselect the whole booking (select mode only)
    const allSelected = g.events.every(e => SELECTED.has(String(e.id)));
    const selectGroupBtn = `<button class="group-select-btn${allSelected ? ' on' : ''}" data-ids="${groupIds}"
            onclick="event.preventDefault();event.stopPropagation();App.selectGroup(this)">
            <i class="bi ${allSelected ? 'bi-check-square-fill' : 'bi-square'} me-1"></i>${allSelected ? 'Deselect group' : 'Select group'}
          </button>`;

    return `<details class="group-card${allHidden ? ' all-hidden' : ''}" open>
        <summary class="group-summary">
          <span class="group-dot" style="background:${g.color}"></span>
          <span class="group-name">${escHtml(g.name)}</span>
          ${g.dateMin ? `<span class="group-date"><i class="bi bi-calendar-event me-1"></i>${escHtml(fmtDateRange(g.dateMin, g.dateMax))}</span>` : ''}
          <span class="group-meta">
            ${g.events.length} function${g.events.length !== 1 ? 's' : ''}
            · ${g.rooms} room${g.rooms !== 1 ? 's' : ''}
            ${span ? '· ' + escHtml(span) : ''}
            ${g.layouts ? '· 🗺 ' + g.layouts : ''}
            ${g.contact ? '· ' + escHtml(g.contact) : ''}
          </span>
          ${selectGroupBtn}
          ${hideGroupBtn}
        </summary>
        <div class="group-rows">${rows}</div>
      </details>`;
  }).join('');
}

// Parse an ISO value from the API as LOCAL time. A bare "YYYY-MM-DD" (an event
// with no time) would otherwise be read as UTC midnight by `new Date`, drifting
// a day in the viewer's timezone — the calendar view avoids this because
// FullCalendar parses dates timezone-safely. Appending a midnight time forces
// local parsing so grouped view matches.
function parseLocalISO(iso) {
  if (!iso) return null;
  return new Date(iso.length === 10 ? iso + 'T00:00:00' : iso);
}

function fmtTimeISO(iso) {
  // A date-only value has no clock time — show nothing rather than a bogus
  // timezone-shifted time (e.g. "17:00" for an all-day event).
  if (!iso || iso.length === 10) return '';
  return fmtTime(new Date(iso));
}

// Open the detail modal from a raw /api/events object (normalise start/end to Date)
function openEventRaw(raw) {
  showEventModal({
    id:    raw.id,
    title: raw.title,
    start: parseLocalISO(raw.start),
    end:   parseLocalISO(raw.end),
    extendedProps: raw.extendedProps,
  });
}

// ── Event detail modal ────────────────────────────────────────────────────
function showEventModal(event) {
  _currentEventId = event.id;
  const props = event.extendedProps;

  const isCancelled = props.status === 'cancelled';

  // Header — tint red for normal, grey for cancelled
  const hdr = document.getElementById('event-modal-header');
  hdr.style.background = isCancelled
    ? 'linear-gradient(135deg, #555, #777)'
    : 'linear-gradient(135deg, #4f46e5, #7c3aed)';

  document.getElementById('eventModalLabel').textContent =
    props.event_number ? `#${props.event_number}  ${event.title}` : event.title;
  document.getElementById('event-modal-sub').textContent =
    props.room ? `Room: ${props.room}  ·  ${props.service_type || ''}` : props.service_type || '';

  // Dates / times
  const dateStr = event.start
    ? event.start.toLocaleDateString('en-CA', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })
    : '—';
  const timeStr = event.start
    ? (fmtTime(event.start) + (event.end ? ` – ${fmtTime(event.end)}` : ''))
    : '—';

  // Setup items — each is a checkbox an assistant ticks off as completed
  const items = props.setup_items || [];
  const checkedSet = new Set(props.checked_items || []);
  const doneCount = items.reduce((n, _, i) => n + (checkedSet.has(i) ? 1 : 0), 0);
  const setupComplete = items.length > 0 && doneCount >= items.length;
  const setupHtml = items.length
    ? `<div class="setup-section mb-3">
         <h6>Setup Requirements
           <span class="setup-progress${setupComplete ? ' complete' : ''}" id="setup-progress">${progressLabel(doneCount, items.length)}</span>
         </h6>
         <ul class="setup-list checklist">
           ${items.map((it, i) => `
             <li class="${checkedSet.has(i) ? 'completed' : ''}">
               <input type="checkbox" class="item-check" id="chk-${i}" data-idx="${i}"
                      ${checkedSet.has(i) ? 'checked' : ''}>
               <label class="item-check-label" for="chk-${i}">
                 <span class="setup-qty">${escHtml(it.qty)}</span>
                 <span class="setup-item-name">${boldAfterNote(it.item)}</span>
               </label>
             </li>`).join('')}
         </ul>
       </div>`
    : '';

  // Explicit "mark complete" control. Always shown — it's the only way to
  // complete an event that has no tickable items, and an override for one where
  // some items don't apply. When all items are already ticked the event is
  // complete regardless; the toggle then just reflects that state.
  const manualComplete = !!props.manually_complete;
  // The "manual override" hint only makes sense when there ARE items and they
  // aren't all ticked. For a no-item event the toggle is the normal path, so no
  // hint is shown.
  const showHint = manualComplete && items.length > 0 && !setupComplete;
  const completeHtml = `
    <div class="complete-section mb-3">
      <label class="complete-toggle${manualComplete ? ' on' : ''}">
        <input type="checkbox" id="mark-complete" ${manualComplete ? 'checked' : ''}>
        <i class="bi ${manualComplete ? 'bi-check-circle-fill' : 'bi-circle'} me-2"></i>
        <span>${manualComplete ? 'Marked complete' : 'Mark this event complete'}</span>
      </label>
      <p class="complete-hint${showHint ? '' : ' d-none'}" id="complete-hint">
        <i class="bi bi-info-circle me-1"></i>Completed manually — not every item is ticked.
      </p>
    </div>`;

  // Notes — append-only, attributed thread. Everyone adds their own entry, so
  // simultaneous editors never overwrite each other. Rendered by loadNotes().
  const assistHtml = `
    <div class="notes-thread-section mb-2">
      <h6>Notes <span class="notes-sync" id="notes-sync"></span></h6>
      <div id="notes-list" class="notes-list">
        <div class="notes-loading text-muted small">Loading…</div>
      </div>
      <div class="notes-add mt-2">
        <textarea id="note-input" class="form-control" rows="2"
                  placeholder="Add a note as ${escHtml(getUsername() || 'you')}…"></textarea>
        <div class="note-image-preview" id="note-image-preview"></div>
        <input type="file" id="note-image-input" accept="image/*" multiple hidden
               onchange="App.onNoteImagesPicked()">
        <div class="notes-add-actions mt-2">
          <button class="btn btn-outline-secondary btn-sm" id="note-photo-btn"
                  onclick="document.getElementById('note-image-input').click()">
            <i class="bi bi-image me-1"></i>Add photo
          </button>
          <button class="btn btn-primary btn-sm" id="note-add-btn" onclick="App.postNote()">
            <i class="bi bi-send me-1"></i>Add note
          </button>
        </div>
      </div>
    </div>`;

  // Room layout diagrams (auto-extracted screenshots). A single function can
  // carry several diagrams across continuation pages, so render them as a gallery.
  const layoutImgs = (props.layout_images && props.layout_images.length)
    ? props.layout_images
    : (props.layout_image ? [props.layout_image] : []);
  const layoutHtml = layoutImgs.length
    ? `<div class="layout-section mb-3">
         <h6>Room Layout${layoutImgs.length > 1
              ? ` <span class="layout-count">${layoutImgs.length}</span>` : ''}</h6>
         <div class="layout-gallery">
           ${layoutImgs.map((fn, i) => `
             <a href="/layouts/${encodeURIComponent(fn)}" target="_blank" rel="noopener"
                title="Click to open full-size layout ${i + 1} of ${layoutImgs.length}">
               <img class="layout-img" src="/layouts/${encodeURIComponent(fn)}"
                    alt="Room layout diagram ${i + 1} for ${escHtml(props.room || '')}" loading="lazy">
             </a>`).join('')}
         </div>
       </div>`
    : '';

  // Notes
  const notesHtml = props.notes
    ? `<div class="mb-3">
         <h6 class="setup-section" style="font-weight:700;text-transform:uppercase;font-size:.75rem;letter-spacing:.06em;color:#6c757d;margin-bottom:.6rem;">Notes</h6>
         <div class="notes-block">${boldAfterNote(props.notes)}</div>
       </div>`
    : '';

  // Source
  const sourceHtml = props.pdf_source
    ? `<p class="source-tag mt-3"><i class="bi bi-file-earmark-pdf me-1"></i>${escHtml(props.pdf_source)}</p>`
    : '';

  // Cancelled banner
  const cancelledBanner = isCancelled
    ? `<div class="cancelled-banner mb-3">
         <i class="bi bi-x-octagon-fill me-2"></i>
         This event has been <strong>CANCELLED</strong>
       </div>`
    : '';

  // Hidden banner
  const hiddenBanner = props.hidden
    ? `<div class="hidden-banner mb-3">
         <i class="bi bi-eye-slash-fill me-2"></i>
         This event is <strong>hidden</strong> from the calendar for everyone.
       </div>`
    : '';

  // "Last updated" notice (only shown when the record was ever modified)
  const updatedHtml = props.updated_at
    ? `<p class="updated-notice mt-3 mb-0">
         <i class="bi bi-pencil-square me-1"></i>
         Last updated: ${escHtml(props.updated_at.slice(0, 16).replace('T', ' '))}
       </p>`
    : '';

  document.getElementById('event-modal-body').innerHTML = `
    ${cancelledBanner}
    ${hiddenBanner}
    <div class="detail-grid mb-3">
      <span class="detail-label">Date</span>
      <span class="detail-value">${dateStr}</span>

      <span class="detail-label">Time</span>
      <span class="detail-value">${timeStr}</span>

      <span class="detail-label">Room</span>
      <span class="detail-value"><span class="room-badge">${escHtml(props.room || '—')}</span></span>

      <span class="detail-label">Service</span>
      <span class="detail-value">${escHtml(props.service_type || '—')}</span>

      <span class="detail-label">Department</span>
      <span class="detail-value">${props.department
          ? escHtml(props.department)
          : `<span class="text-muted">${escHtml(props.dept_category || '—')}</span>`}</span>

      <span class="detail-label">Onsite</span>
      <span class="detail-value">${escHtml(props.onsite_contact || '—')}</span>

      <span class="detail-label">Contact</span>
      <span class="detail-value"><strong>${escHtml(props.mecs_contact || '—')}</strong></span>
    </div>
    <hr>
    ${layoutHtml}
    ${setupHtml}
    ${completeHtml}
    ${notesHtml}
    ${assistHtml}
    ${sourceHtml}
    ${updatedHtml}
  `;

  const hideBtn = document.getElementById('hide-btn');
  if (hideBtn) {
    hideBtn.innerHTML = props.hidden
      ? '<i class="bi bi-eye me-1"></i>Unhide'
      : '<i class="bi bi-eye-slash me-1"></i>Hide';
  }

  wireProgressControls(event.id);
  closeReactionPicker();
  _newAfterId  = lastSeenNoteId(String(event.id));
  _scrollToNew = unseenNoteCount(event.id) > 0;
  loadNotes(event.id);
  startNotesPoll(event.id);
  bootstrap.Modal.getOrCreateInstance(document.getElementById('eventModal')).show();
}

// ── Assistant progress: checkboxes + note (persisted per event) ────────────
function wireProgressControls(id) {
  const body = document.getElementById('event-modal-body');

  body.querySelectorAll('.item-check').forEach(cb => {
    cb.addEventListener('change', () => {
      cb.closest('li').classList.toggle('completed', cb.checked);
      saveProgress(id);
    });
  });

  const mark = document.getElementById('mark-complete');
  if (mark) mark.addEventListener('change', () => saveManualComplete(id, mark.checked));
}

async function saveManualComplete(id, complete) {
  const body = document.getElementById('event-modal-body');

  // Reflect the new state in the toggle's label/icon and the manual hint.
  const toggle = body.querySelector('.complete-toggle');
  if (toggle) {
    toggle.classList.toggle('on', complete);
    const icon = toggle.querySelector('i.bi');
    if (icon) icon.className = `bi ${complete ? 'bi-check-circle-fill' : 'bi-circle'} me-2`;
    const txt = toggle.querySelector('span');
    if (txt) txt.textContent = complete ? 'Marked complete' : 'Mark this event complete';
  }
  const hint  = document.getElementById('complete-hint');
  const total = body.querySelectorAll('.item-check').length;
  const done  = body.querySelectorAll('.item-check:checked').length;
  if (hint) hint.classList.toggle('d-none', !(complete && total > 0 && done < total));

  updateManualCompleteCache(id, complete);   // optimistic
  _checklistTouched = true;                   // refresh line styling on close

  try {
    const res = await fetch(`/api/events/${id}/progress`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ manually_complete: complete }),
    });
    if (!res.ok) throw new Error('save failed');
  } catch (_) {}
}

async function saveProgress(id) {
  const body    = document.getElementById('event-modal-body');
  const checked = [...body.querySelectorAll('.item-check:checked')].map(c => +c.dataset.idx);
  const total   = body.querySelectorAll('.item-check').length;

  const prog = document.getElementById('setup-progress');
  if (prog) {
    prog.textContent = progressLabel(checked.length, total);
    prog.classList.toggle('complete', total > 0 && checked.length >= total);
  }

  // Keep the "completed manually" hint accurate as items are ticked/unticked.
  const mark = document.getElementById('mark-complete');
  const hint = document.getElementById('complete-hint');
  if (hint) {
    const overriding = mark && mark.checked && total > 0 && checked.length < total;
    hint.classList.toggle('d-none', !overriding);
  }

  updateProgressCache(id, checked);   // optimistic — keeps this session in sync
  _checklistTouched = true;           // refresh line styling (complete state) on modal close

  try {
    const res = await fetch(`/api/events/${id}/progress`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ checked_items: checked }),
    });
    if (!res.ok) throw new Error('save failed');
  } catch (_) {}
}

// Mirror saved progress into the in-memory caches so reopening shows it
function updateProgressCache(id, checked) {
  const raw = _eventsById[id];
  if (raw) raw.extendedProps.checked_items = checked;
  const fcEv = calendar.getEventById(String(id));
  if (fcEv) fcEv.setExtendedProp('checked_items', checked);
}

// Mirror the manual "mark complete" flag into the in-memory caches
function updateManualCompleteCache(id, complete) {
  const raw = _eventsById[id];
  if (raw) raw.extendedProps.manually_complete = complete;
  const fcEv = calendar.getEventById(String(id));
  if (fcEv) fcEv.setExtendedProp('manually_complete', complete);
}

// ── Upload ────────────────────────────────────────────────────────────────
function initDropZone() {
  const zone  = document.getElementById('drop-zone');
  const input = document.getElementById('file-input');

  // Re-attach handlers (modal may reopen)
  const newZone = zone.cloneNode(true);
  zone.parentNode.replaceChild(newZone, zone);
  const newInput = document.getElementById('file-input');

  newZone.addEventListener('click', () => newInput.click());

  newZone.addEventListener('dragover', e => {
    e.preventDefault();
    newZone.classList.add('drag-over');
  });
  newZone.addEventListener('dragleave', () => newZone.classList.remove('drag-over'));
  newZone.addEventListener('drop', e => {
    e.preventDefault();
    newZone.classList.remove('drag-over');
    const file = e.dataTransfer.files[0];
    if (file) doUpload(file);
  });

  newInput.addEventListener('change', () => {
    if (newInput.files[0]) doUpload(newInput.files[0]);
  });

  // Reset state every time modal opens
  resetUploadUI();
}

function resetUploadUI() {
  document.getElementById('upload-alert').innerHTML = '';
  document.getElementById('upload-progress').classList.add('d-none');
  const zone = document.getElementById('drop-zone');
  if (zone) zone.classList.remove('d-none');
}

async function doUpload(file) {
  const zone     = document.getElementById('drop-zone');
  const progress = document.getElementById('upload-progress');
  const alert    = document.getElementById('upload-alert');

  zone.classList.add('d-none');
  progress.classList.remove('d-none');
  alert.innerHTML = '';

  const formData = new FormData();
  formData.append('file', file);

  try {
    const res  = await fetch('/upload', { method: 'POST', body: formData });

    // A server/proxy error (413, 502, 504…) often returns an HTML page, not
    // JSON, so check the status before parsing — otherwise res.json() throws a
    // cryptic "unexpected character" error that hides the real cause. When the
    // app itself returns a JSON error (e.g. a 500 "Parsing failed: …"), surface
    // that specific message rather than a generic one.
    if (!res.ok) {
      let serverMsg = '';
      try { serverMsg = (JSON.parse(await res.text()) || {}).error || ''; } catch (_) {}
      const msg = serverMsg
        ? serverMsg
        : res.status === 413
        ? 'This file is too large for the server to accept. Ask an admin to raise the upload size limit (nginx client_max_body_size).'
        : (res.status === 502 || res.status === 504)
        ? 'The server timed out processing this report — it may be very large. Ask an admin to raise the request timeout (gunicorn --timeout / nginx proxy_read_timeout).'
        : `Server error (${res.status}). Please try again, or contact an admin if it persists.`;
      alert.innerHTML = errorAlert(msg);
      return;
    }

    const data = await res.json();

    if (data.error) {
      alert.innerHTML = errorAlert(data.error);
    } else if (data.no_changes) {
      alert.innerHTML = noChangesAlert(data.message);
    } else if (data.success) {
      alert.innerHTML = uploadSummaryAlert(data);
      calendar.refetchEvents();
      refreshBadge();
    } else {
      alert.innerHTML = errorAlert(data.error || 'Unknown error');
    }
  } catch (err) {
    alert.innerHTML = errorAlert(`Network error: ${err.message}`);
  } finally {
    progress.classList.add('d-none');
    zone.classList.remove('d-none');
  }
}

// ── Global actions ────────────────────────────────────────────────────────
const App = {
  openUpload() {
    bootstrap.Modal.getOrCreateInstance(document.getElementById('uploadModal')).show();
  },

  async deleteCurrentEvent() {
    if (!_currentEventId) return;
    if (!confirm('Delete this event from the calendar? This cannot be undone.')) return;
    const res  = await fetch(`/api/events/${_currentEventId}`, { method: 'DELETE' });
    const data = await res.json();
    if (data.success) {
      bootstrap.Modal.getInstance(document.getElementById('eventModal')).hide();
      calendar.refetchEvents();
      refreshBadge();
    }
  },

  toggleLegend() {
    const bar = document.getElementById('legend-bar');
    const btn = document.getElementById('legend-btn');
    const hidden = bar.classList.toggle('d-none');
    btn.classList.toggle('active', !hidden);
  },

  toggleDept(cat) {
    if (FILTERS.depts.has(cat)) FILTERS.depts.delete(cat);
    else                        FILTERS.depts.add(cat);
    saveFilters();
    calendar.refetchEvents();
  },

  setSearch(text) {
    FILTERS.q = (text || '').trim().toLowerCase();
    saveFilters();
    // Debounce so we don't re-render on every keystroke
    clearTimeout(_searchTimer);
    _searchTimer = setTimeout(() => {
      if (groupedMode) renderGrouped(applyFilters(ALL_EVENTS));
      else             calendar.refetchEvents();
    }, 160);
  },

  toggleCancelled() {
    FILTERS.cancelledOnly = !FILTERS.cancelledOnly;
    saveFilters();
    calendar.refetchEvents();
  },

  clearFilters() {
    FILTERS.depts.clear();
    FILTERS.q = '';
    FILTERS.cancelledOnly = false;
    const search = document.getElementById('event-search');
    if (search) search.value = '';
    saveFilters();
    calendar.refetchEvents();
  },

  toggleGrouped() {
    if (groupedMode) exitGrouped();
    else             enterGrouped();
  },

  // Grouped-view range controls — drive the calendar's range underneath, which
  // refetches and re-renders the grouped panel (see fetchEvents + datesSet).
  groupedPrev()  { calendar.prev(); },
  groupedNext()  { calendar.next(); },
  groupedToday() { calendar.today(); },
  groupedRange(view) { calendar.changeView(view); },

  // Open the native date picker (used by both the calendar and grouped views),
  // anchored under whichever button triggered it.
  pickDate(anchor) { openDatePicker(anchor); },

  // Jump to the chosen date; gotoDate refetches, re-rendering whichever view
  // (calendar or grouped) is active for the new period.
  jumpToDate(dateStr) {
    if (!dateStr || !calendar) return;
    const [y, m, d] = dateStr.split('-').map(Number);
    calendar.gotoDate(new Date(y, m - 1, d));   // local Date — no UTC drift
  },

  toggleHidden() {
    showHidden = !showHidden;
    updateHiddenButton();
    calendar.refetchEvents();
  },

  togglePast() {
    showPast = !showPast;
    updatePastButton();
    calendar.refetchEvents();
  },

  // Hide / unhide the event open in the detail modal (shared across all users)
  async toggleCurrentHidden() {
    if (_currentEventId == null) return;
    const raw = _eventsById[_currentEventId];
    const newHidden = !(raw && raw.extendedProps.hidden);
    const res = await fetch(`/api/events/${_currentEventId}/hidden`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ hidden: newHidden }),
    });
    if (!res.ok) return;
    if (raw) raw.extendedProps.hidden = newHidden;
    const fcEv = calendar.getEventById(String(_currentEventId));
    if (fcEv) fcEv.setExtendedProp('hidden', newHidden);
    bootstrap.Modal.getInstance(document.getElementById('eventModal')).hide();
    calendar.refetchEvents();
  },

  // Hide / unhide every event in a grouped booking at once
  async hideGroup(btn) {
    const ids = (btn.dataset.ids || '').split(',').filter(Boolean).map(Number);
    const hidden = btn.dataset.hide === '1';
    if (!ids.length) return;
    btn.disabled = true;
    try {
      const res = await fetch('/api/events/hidden', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ ids, hidden }),
      });
      if (!res.ok) return;
      // refetch pulls the persisted state and re-renders the grouped panel
      calendar.refetchEvents();
    } finally {
      btn.disabled = false;
    }
  },

  openEvent(id) {
    const raw = _eventsById[id];
    if (raw) openEventRaw(raw);
  },

  // ── Multi-select / bulk delete ───────────────────────────────────────
  toggleSelectMode() {
    selectMode = !selectMode;
    if (!selectMode) SELECTED.clear();
    document.querySelectorAll('.event-selected').forEach(el => el.classList.remove('event-selected'));
    updateSelectBar();
    if (groupedMode) renderGrouped(applyFilters(ALL_EVENTS));
  },

  toggleSelect(id) {
    setSelected(id, !SELECTED.has(String(id)));
    updateSelectBar();
    if (groupedMode) renderGrouped(applyFilters(ALL_EVENTS));
  },

  // Grouped-view row: tick it in select mode, otherwise open it
  rowClick(id) {
    if (selectMode) App.toggleSelect(id);
    else            App.openEvent(id);
  },

  selectGroup(btn) {
    const ids = (btn.dataset.ids || '').split(',').filter(Boolean);
    const allOn = ids.every(id => SELECTED.has(id));
    ids.forEach(id => setSelected(id, !allOn));
    updateSelectBar();
    renderGrouped(applyFilters(ALL_EVENTS));
  },

  selectAllShown() {
    applyFilters(ALL_EVENTS).forEach(e => setSelected(e.id, true));
    updateSelectBar();
    if (groupedMode) renderGrouped(applyFilters(ALL_EVENTS));
  },

  clearSelection() {
    [...SELECTED.keys()].forEach(id => setSelected(id, false));
    updateSelectBar();
    if (groupedMode) renderGrouped(applyFilters(ALL_EVENTS));
  },

  async deleteSelected() {
    const n = SELECTED.size;
    if (!n) return;
    const labels = [...SELECTED.values()];
    const list = labels.slice(0, 8).map(l => `• ${l}`).join('\n')
      + (labels.length > 8 ? `\n…and ${labels.length - 8} more` : '');
    if (!confirm(`Delete ${n} event${n !== 1 ? 's' : ''}?\n\n${list}\n\n`
        + 'Their comments and photos will be deleted too. This cannot be undone.')) return;

    const btn = document.getElementById('select-delete-btn');
    btn.disabled = true;
    try {
      const res = await fetch('/api/events/delete', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ ids: [...SELECTED.keys()].map(Number) }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        alert(err.error || 'Could not delete the selected events.');
        return;
      }
      SELECTED.clear();
      App.toggleSelectMode();
      calendar.refetchEvents();
      refreshBadge();
    } finally {
      updateSelectBar();
    }
  },

  // ── Comment inbox ────────────────────────────────────────────────────
  toggleInbox() {
    if (inboxIsOpen()) { closeInbox(); return; }
    renderInbox();
    const box = document.getElementById('comment-inbox');
    // On phones it's a full-width sheet pinned just under the (wrapping) header
    box.style.top = isMobile()
      ? `${document.querySelector('.app-header').getBoundingClientRect().bottom + 6}px` : '';
    box.classList.remove('d-none');
    document.getElementById('unseen-badge').setAttribute('aria-expanded', 'true');
  },

  // Open an event's thread from the inbox. Events outside the calendar's
  // loaded range are fetched by their date first.
  async openFromInbox(eventId) {
    closeInbox();
    let raw = _eventsById[String(eventId)];
    if (!raw) {
      const note = _unread.find(n => n.event_id === eventId);
      if (!note) return;
      try {
        const res = await fetch(`/api/events?start=${note.date}&end=${note.date}`);
        raw = (await res.json()).find(e => e.id === String(eventId));
      } catch (_) {}
    }
    if (raw) openEventRaw(raw);
  },

  markAllRead() {
    const map = _seenIdMap();
    for (const n of _unread) {
      const k = String(n.event_id);
      map[k] = Math.max(map[k] || 0, n.id);
    }
    _saveSeenIdMap(map);
    _unread = [];
    _indexUnread();
    updateUnseenBadge();
    if (groupedMode) renderGrouped(applyFilters(ALL_EVENTS));
    else             calendar.refetchEvents();
  },

  openClear() {
    // Reset inputs and feedback
    document.getElementById('clear-start').value = '';
    document.getElementById('clear-end').value   = '';
    document.getElementById('clear-count-msg').className = 'clear-count-msg d-none';
    document.getElementById('clear-range-btn').disabled  = true;
    document.getElementById('clear-range-label').textContent = 'Clear events in range';
    bootstrap.Modal.getOrCreateInstance(document.getElementById('clearModal')).show();
  },

  async clearRange() {
    const start = document.getElementById('clear-start').value;
    const end   = document.getElementById('clear-end').value;
    if (!start || !end) return;

    const fmtStart = fmtDate(start);
    const fmtEnd   = fmtDate(end);
    if (!confirm(`Delete all events from ${fmtStart} to ${fmtEnd}? This cannot be undone.`)) return;

    const res  = await fetch('/api/events/clear', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ start, end }),
    });
    const data = await res.json();
    bootstrap.Modal.getInstance(document.getElementById('clearModal')).hide();
    calendar.refetchEvents();
    refreshBadge();
  },

  async clearAll() {
    if (!confirm('Delete ALL events from the calendar? This cannot be undone.')) return;
    await fetch('/api/events/clear', { method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    bootstrap.Modal.getInstance(document.getElementById('clearModal')).hide();
    calendar.refetchEvents();
    refreshBadge();
  },

  // ── Identity / notes ──────────────────────────────────────────────────
  changeName() {
    const name = (prompt('Enter your name (shown on notes you add):', getUsername()) || '').trim();
    if (name) {
      setUsername(name);
      const input = document.getElementById('note-input');
      if (input) input.placeholder = `Add a note as ${name}…`;
      renderNotes(_currentNotes);   // re-render so ownership controls update
    }
  },

  // Stage newly picked photos (appended, deduped by name+size, capped) and show
  // previews. Clears the input so picking the same file again still fires change.
  onNoteImagesPicked() {
    const input = document.getElementById('note-image-input');
    if (!input) return;
    for (const f of input.files) {
      if (_noteImages.length >= _MAX_NOTE_IMAGES) break;
      if (_noteImages.some(g => g.name === f.name && g.size === f.size)) continue;
      _noteImages.push(f);
    }
    input.value = '';
    renderNoteImagePreview();
  },

  removeNoteImage(idx) {
    _noteImages.splice(idx, 1);
    renderNoteImagePreview();
  },

  async postNote() {
    let name = getUsername();
    if (!name) { App.changeName(); name = getUsername(); if (!name) return; }
    const input = document.getElementById('note-input');
    const text  = (input.value || '').trim();
    if ((!text && !_noteImages.length) || _currentEventId == null) return;

    const btn = document.getElementById('note-add-btn');
    if (btn) btn.disabled = true;
    try {
      let opts;
      if (_noteImages.length) {
        // Photos require multipart/form-data — let the browser set the boundary.
        const fd = new FormData();
        fd.append('author', name);
        fd.append('text', text);
        for (const f of _noteImages) fd.append('images', f);
        opts = { method: 'POST', body: fd };
      } else {
        opts = {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ author: name, text }),
        };
      }
      const res = await fetch(`/api/events/${_currentEventId}/notes`, opts);
      if (res.ok) {
        input.value = '';
        _noteImages = [];
        renderNoteImagePreview();
        await loadNotes(_currentEventId);
      }
    } finally {
      if (btn) btn.disabled = false;
    }
  },

  editNote(id) {
    const item = document.querySelector(`.note-item[data-note-id="${id}"]`);
    const note = _currentNotes.find(n => n.id === id);
    if (!item || !note) return;
    item.classList.add('editing');
    item.querySelector('.note-text').innerHTML = `
      <textarea class="form-control form-control-sm note-edit-input" rows="2"></textarea>
      <div class="mt-1 d-flex gap-2">
        <button class="btn btn-primary btn-sm" onclick="App.saveNote(${id})">Save</button>
        <button class="btn btn-outline-secondary btn-sm" onclick="App.cancelEdit()">Cancel</button>
      </div>`;
    const ta = item.querySelector('.note-edit-input');
    ta.value = note.text;
    ta.focus();
  },

  async saveNote(id) {
    const item = document.querySelector(`.note-item[data-note-id="${id}"]`);
    const ta   = item && item.querySelector('.note-edit-input');
    if (!ta) return;
    const text = (ta.value || '').trim();
    if (!text) return;
    const res = await fetch(`/api/notes/${id}`, {
      method:  'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ author: getUsername(), text }),
    });
    if (res.ok) {
      // Clear the editing flag before re-rendering, otherwise renderNotes'
      // "don't stomp an in-progress edit" guard would skip the refresh and
      // leave this note stuck showing its edit box.
      if (item) item.classList.remove('editing');
      await loadNotes(_currentEventId);
    }
  },

  cancelEdit() {
    const item = document.querySelector('.note-item.editing');
    if (item) item.classList.remove('editing');
    renderNotes(_currentNotes);
  },

  // Small emoji picker anchored to a note's smiley button.
  toggleReactionPicker(noteId) {
    const open = document.querySelector('.reaction-picker');
    const wasThisNote = open && open.dataset.noteId === String(noteId);
    closeReactionPicker();
    if (wasThisNote) return;
    const head = document.querySelector(`.note-item[data-note-id="${noteId}"] .note-head`);
    if (!head) return;
    const picker = document.createElement('div');
    picker.className = 'reaction-picker';
    picker.dataset.noteId = noteId;
    picker.innerHTML = REACTIONS.map((emo, i) =>
      `<button type="button" onclick="App.react(${noteId}, ${i})">${emo}</button>`).join('');
    head.appendChild(picker);
  },

  async react(noteId, idx) {
    let name = getUsername();
    if (!name) { App.changeName(); name = getUsername(); if (!name) return; }
    const emoji = REACTIONS[idx];
    if (!emoji) return;
    closeReactionPicker();
    const res = await fetch(`/api/notes/${noteId}/reactions`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ author: name, emoji }),
    });
    if (!res.ok) return;
    const note = _currentNotes.find(n => n.id === noteId);
    if (note) note.reactions = await res.json();
    renderNotes(_currentNotes);
  },

  async deleteNote(id) {
    if (!confirm('Delete your note? This cannot be undone.')) return;
    const res = await fetch(`/api/notes/${id}`, {
      method:  'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ author: getUsername() }),
    });
    if (res.ok) await loadNotes(_currentEventId);
  },

};

// ── Utilities ─────────────────────────────────────────────────────────────
// ── Legend ────────────────────────────────────────────────────────────────
function buildLegend(fcEvents) {
  // Collect unique groups: key → { label, color, count }
  const groups = {};
  for (const ev of fcEvents) {
    const key   = ev.extendedProps.group_key || ev.title;
    const label = ev.extendedProps.group_key
      ? (ev.title !== `${ev.extendedProps.room} – ${ev.extendedProps.service_type}`
          ? groupLabel(ev, key) : key)
      : key;
    if (!groups[key]) {
      groups[key] = { label, color: eventColor(key), count: 0 };
    }
    groups[key].count++;
  }

  const sorted = Object.values(groups).sort((a, b) => b.count - a.count);
  const bar    = document.getElementById('legend-chips');

  if (sorted.length === 0) {
    bar.innerHTML = '<span class="legend-empty">No events loaded</span>';
    return;
  }

  bar.innerHTML = sorted.map(g => `
    <span class="legend-chip" title="${escHtml(g.label)} — ${g.count} room/date entry${g.count !== 1 ? 'ies' : 'y'}">
      <span class="legend-dot" style="background:${g.color}"></span>
      <span class="legend-label">${escHtml(g.label)}</span>
      <span class="legend-count">${g.count}</span>
    </span>
  `).join('');
}

async function updateClearCount() {
  const start = document.getElementById('clear-start').value;
  const end   = document.getElementById('clear-end').value;
  const msg   = document.getElementById('clear-count-msg');
  const btn   = document.getElementById('clear-range-btn');
  const label = document.getElementById('clear-range-label');

  if (!start || !end) {
    msg.className = 'clear-count-msg d-none';
    btn.disabled  = true;
    label.textContent = 'Clear events in range';
    return;
  }

  if (end < start) {
    msg.className   = 'clear-count-msg has-events';
    msg.textContent = '⚠ End date must be on or after start date.';
    btn.disabled    = true;
    return;
  }

  try {
    const res  = await fetch(`/api/events/count?start=${start}&end=${end}`);
    const data = await res.json();
    const n    = data.count;

    if (n === 0) {
      msg.className   = 'clear-count-msg no-events';
      msg.textContent = `No events found between ${fmtDate(start)} and ${fmtDate(end)}.`;
      btn.disabled    = true;
      label.textContent = 'Clear events in range';
    } else {
      msg.className   = 'clear-count-msg has-events';
      msg.innerHTML   = `<i class="bi bi-exclamation-triangle-fill me-1"></i>
        <strong>${n} event${n !== 1 ? 's' : ''}</strong> will be permanently deleted
        between <strong>${fmtDate(start)}</strong> and <strong>${fmtDate(end)}</strong>.`;
      btn.disabled  = false;
      label.textContent = `Clear ${n} event${n !== 1 ? 's' : ''} in range`;
    }
    msg.classList.remove('d-none');
  } catch (_) {}
}

function fmtDate(iso) {
  // "2026-04-30" → "Apr 30, 2026"
  const [y, m, d] = iso.split('-');
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${months[parseInt(m) - 1]} ${parseInt(d)}, ${y}`;
}

// Compact date range for a booking. Collapses shared year/month:
//   same day      → "Jul 28, 2026"
//   same month    → "Jul 28–30, 2026"
//   same year     → "Jul 28 – Aug 2, 2026"
//   otherwise     → "Dec 31, 2025 – Jan 2, 2026"
function fmtDateRange(minIso, maxIso) {
  if (!minIso) return '';
  if (!maxIso || minIso === maxIso) return fmtDate(minIso);
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const [y1, m1, d1] = minIso.split('-');
  const [y2, m2, d2] = maxIso.split('-');
  if (y1 === y2 && m1 === m2) return `${months[+m1 - 1]} ${+d1}–${+d2}, ${y1}`;
  if (y1 === y2)              return `${months[+m1 - 1]} ${+d1} – ${months[+m2 - 1]} ${+d2}, ${y1}`;
  return `${fmtDate(minIso)} – ${fmtDate(maxIso)}`;
}

function fmtTime(dt) {
  return dt.toLocaleTimeString('en-CA', { hour: '2-digit', minute: '2-digit', hour12: false });
}

// A local Date → "YYYY-MM-DD" for a date input's value (no UTC conversion).
function toDateInputValue(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Open the shared hidden date input as a native picker, positioned just under
// the button that triggered it, seeded to the period currently in view. On
// pick, App.jumpToDate() navigates the calendar (see the input's onchange).
function openDatePicker(anchor) {
  const inp = document.getElementById('jump-datepicker');
  if (!inp || !calendar) return;
  if (anchor) {
    const r = anchor.getBoundingClientRect();
    inp.style.left = `${window.scrollX + r.left}px`;
    inp.style.top  = `${window.scrollY + r.bottom}px`;
  }
  inp.value = toDateInputValue(calendar.view.currentStart);
  try {
    if (typeof inp.showPicker === 'function') inp.showPicker();
    else inp.focus();
  } catch (_) {
    inp.focus();   // some browsers refuse showPicker() on a hidden anchor
  }
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Escape text, then bold everything after the first occurrence of the word
// "note"/"notes" (e.g. "AV Note …" → the note body renders in bold).
function boldAfterNote(str) {
  const esc = escHtml(str);
  const m = esc.match(/\bnotes?\b/i);
  if (!m) return esc;
  const cut = m.index + m[0].length;
  const after = esc.slice(cut);
  if (!after.trim()) return esc;   // nothing follows the word "note"
  return esc.slice(0, cut) + '<strong>' + after + '</strong>';
}

function uploadSummaryAlert(data) {
  // Build icon + colour depending on what happened
  const hasCancelled = data.cancelled > 0;
  const hasUpdated   = data.updated   > 0;
  const hasNew       = data.new       > 0;

  const icon  = hasCancelled ? 'bi-x-octagon-fill text-danger'
              : hasUpdated   ? 'bi-arrow-repeat text-primary'
              : 'bi-check-circle-fill text-success';
  const cls   = hasCancelled ? 'alert-warning'
              : hasUpdated   ? 'alert-info'
              : 'alert-success';

  const rows = [];
  if (hasNew)       rows.push(`<strong>${data.new}</strong> new event${data.new !== 1 ? 's' : ''} added`);
  if (hasUpdated)   rows.push(`<strong>${data.updated}</strong> event${data.updated !== 1 ? 's' : ''} updated`);
  if (hasCancelled) rows.push(`<strong>${data.cancelled}</strong> marked as <span class="text-danger fw-bold">CANCELLED</span>`);
  if (data.skipped) rows.push(`<span class="text-muted">${data.skipped} already up to date</span>`);

  return `<div class="alert ${cls} d-flex align-items-start gap-2 mb-0">
    <i class="bi ${icon} flex-shrink-0 mt-1"></i>
    <div>${rows.join('<br>')}</div>
  </div>`;
}

function noChangesAlert(msg) {
  return `<div class="alert alert-secondary d-flex align-items-center gap-2 mb-0">
    <i class="bi bi-check2-all"></i>
    <span>${escHtml(msg)}</span>
  </div>`;
}

function errorAlert(msg) {
  return `<div class="alert alert-danger d-flex align-items-center gap-2 mb-0">
    <i class="bi bi-exclamation-triangle-fill"></i><span>${escHtml(msg)}</span></div>`;
}
