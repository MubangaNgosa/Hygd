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

// ── Notes thread (append-only, attributed, 4s polling while modal open) ────
let _notesPollTimer = null;
let _currentNotes   = [];
let _notesTouched   = false;   // note count changed while modal open → refresh line indicators on close
let _checklistTouched = false; // setup checkboxes changed → refresh complete-state styling on close

async function loadNotes(eventId) {
  try {
    const res = await fetch(`/api/events/${eventId}/notes`);
    if (!res.ok) return;
    _currentNotes = await res.json();
    renderNotes(_currentNotes);
    syncNoteCount(eventId, _currentNotes.length);
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
  // Don't stomp on an inline edit that's in progress (e.g. a poll tick)
  if (list.querySelector('.note-item.editing')) return;

  if (!notes.length) {
    list.innerHTML = '<div class="notes-empty text-muted small">No notes yet — add the first one below.</div>';
    return;
  }

  const me = getUsername();
  list.innerHTML = notes.map(n => {
    const mine  = !!me && n.author === me;
    const stamp = fmtNoteTime(n.created_at) + (n.updated_at ? ' · edited' : '');
    const actions = mine ? `
        <span class="note-actions">
          <button class="note-action" title="Edit" onclick="App.editNote(${n.id})"><i class="bi bi-pencil"></i></button>
          <button class="note-action" title="Delete" onclick="App.deleteNote(${n.id})"><i class="bi bi-trash3"></i></button>
        </span>` : '';
    return `<div class="note-item${mine ? ' mine' : ''}" data-note-id="${n.id}">
        <div class="note-head">
          <span class="note-author">${escHtml(n.author)}</span>
          <span class="note-time">${escHtml(stamp)}</span>
          ${actions}
        </div>
        <div class="note-text">${escHtml(n.text).replace(/\n/g, '<br>')}</div>
      </div>`;
  }).join('');
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
let showPast    = false;   // reveal events whose group's last instance has passed
const FILTERS = { depts: new Set(), room: '', cancelledOnly: false };

// ── FullCalendar ──────────────────────────────────────────────────────────
let calendar;

document.addEventListener('DOMContentLoaded', () => {
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
    noEventsContent: 'No events match the current filters',
    events: fetchEvents,
    datesSet() {
      // Keep the grouped toolbar's range title / active button in sync with
      // whatever range the calendar is showing (grouped mode navigates via it).
      updateGroupedToolbar();
    },
    eventClick(info) {
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
    if (_notesTouched || _checklistTouched) {
      _notesTouched = false;
      _checklistTouched = false;
      if (groupedMode) renderGrouped(applyFilters(ALL_EVENTS));
      else             calendar.refetchEvents();
    }
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
    ? { left: 'prev,next today', center: 'title', right: 'listDay,dayGridMonth' }
    : { left: 'prev,next today', center: 'title', right: 'listDay,listWeek,dayGridMonth' };
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

// ── Event fetching + filtering ────────────────────────────────────────────
async function fetchEvents(info, success, failure) {
  try {
    const qs  = info.startStr && info.endStr
      ? `?start=${info.startStr}&end=${info.endStr}` : '';
    const res = await fetch(`/api/events${qs}`);
    ALL_EVENTS = await res.json();
    _eventsById = {};
    for (const e of ALL_EVENTS) _eventsById[e.id] = e;
    buildFilterBar(ALL_EVENTS);
    buildLegend(ALL_EVENTS);
    updateHiddenButton();
    updatePastButton();
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
    if (FILTERS.room && p.room !== FILTERS.room) return false;
    return true;
  });
}

function buildFilterBar(list) {
  // Department chips (with counts), sorted by frequency
  const counts = {};
  const rooms  = new Set();
  for (const e of list) {
    const cat = e.extendedProps.dept_category || 'General';
    counts[cat] = (counts[cat] || 0) + 1;
    if (e.extendedProps.room) rooms.add(e.extendedProps.room);
  }

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

  // Room dropdown — keep current selection if still present
  const sel = document.getElementById('room-filter');
  const sortedRooms = [...rooms].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const current = FILTERS.room;
  sel.innerHTML = `<option value="">All rooms (${rooms.size})</option>` +
    sortedRooms.map(r => `<option value="${escHtml(r)}"${r === current ? ' selected' : ''}>${escHtml(r)}</option>`).join('');
  if (current && !rooms.has(current)) { FILTERS.room = ''; sel.value = ''; }

  updateFilterMeta(list.length);
}

function updateFilterMeta(total) {
  const shown  = applyFilters(ALL_EVENTS).length;
  const active = FILTERS.depts.size > 0 || !!FILTERS.room || FILTERS.cancelledOnly;
  const meta   = document.getElementById('filter-count');
  const clear  = document.getElementById('clear-filters');
  meta.textContent = active ? `Showing ${shown} of ${total}` : `${total} event${total !== 1 ? 's' : ''}`;
  clear.classList.toggle('d-none', !active);
}

// An event is "complete" once every setup item has been checked off.
function eventIsComplete(p) {
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

  if (p.layout_image && !titleEl.querySelector('.ev-flag')) {
    const s = document.createElement('span');
    s.className = 'ev-flag';
    s.textContent = ' 🗺';
    s.title = 'Room layout available';
    titleEl.appendChild(s);
  }
  if (p.note_count > 0 && !titleEl.querySelector('.note-flag')) {
    const s = document.createElement('span');
    s.className = 'note-flag';
    s.textContent = '★';
    s.title = `${p.note_count} note${p.note_count !== 1 ? 's' : ''}`;
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

function renderGrouped(list) {
  const panel = document.getElementById('grouped-panel');

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
      name:   evs.find(e => e.title)?.title || key,
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
      const noteFlag = p.note_count > 0
        ? `<span class="note-flag" title="${p.note_count} note${p.note_count !== 1 ? 's' : ''}">★</span>` : '';
      const hiddenFlag = p.hidden
        ? '<span class="hidden-flag" title="Hidden event"><i class="bi bi-eye-slash"></i></span>' : '';
      const complete = eventIsComplete(p);
      const past = eventIsPast(p);
      const completeBadge = complete
        ? '<span class="status-badge complete"><i class="bi bi-check-circle-fill me-1"></i>Complete</span>' : '';
      const pastBadge = past ? '<span class="status-badge past">Past</span>' : '';
      return `<button class="group-row${cancelled ? ' cancelled' : ''}${p.hidden ? ' hidden' : ''}${complete ? ' complete' : ''}${past ? ' past' : ''}" onclick="App.openEvent('${e.id}')">
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
          ${hideGroupBtn}
        </summary>
        <div class="group-rows">${rows}</div>
      </details>`;
  }).join('');
}

function fmtTimeISO(iso) {
  return iso ? fmtTime(new Date(iso)) : '';
}

// Open the detail modal from a raw /api/events object (normalise start/end to Date)
function openEventRaw(raw) {
  showEventModal({
    id:    raw.id,
    title: raw.title,
    start: raw.start ? new Date(raw.start) : null,
    end:   raw.end ? new Date(raw.end) : null,
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

  document.getElementById('eventModalLabel').textContent = event.title;
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
        <button class="btn btn-primary btn-sm mt-2" id="note-add-btn" onclick="App.postNote()">
          <i class="bi bi-send me-1"></i>Add note
        </button>
      </div>
    </div>`;

  // Room layout diagram (auto-extracted screenshot)
  const layoutHtml = props.layout_image
    ? `<div class="layout-section mb-3">
         <h6>Room Layout</h6>
         <a href="/layouts/${encodeURIComponent(props.layout_image)}" target="_blank" rel="noopener"
            title="Click to open the full-size layout">
           <img class="layout-img" src="/layouts/${encodeURIComponent(props.layout_image)}"
                alt="Room layout diagram for ${escHtml(props.room || '')}" loading="lazy">
         </a>
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
    calendar.refetchEvents();
  },

  setRoom(room) {
    FILTERS.room = room || '';
    calendar.refetchEvents();
  },

  toggleCancelled() {
    FILTERS.cancelledOnly = !FILTERS.cancelledOnly;
    calendar.refetchEvents();
  },

  clearFilters() {
    FILTERS.depts.clear();
    FILTERS.room = '';
    FILTERS.cancelledOnly = false;
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

  async postNote() {
    let name = getUsername();
    if (!name) { App.changeName(); name = getUsername(); if (!name) return; }
    const input = document.getElementById('note-input');
    const text  = (input.value || '').trim();
    if (!text || _currentEventId == null) return;

    const btn = document.getElementById('note-add-btn');
    if (btn) btn.disabled = true;
    try {
      const res = await fetch(`/api/events/${_currentEventId}/notes`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ author: name, text }),
      });
      if (res.ok) {
        input.value = '';
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
          ? ev.title : key)
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
