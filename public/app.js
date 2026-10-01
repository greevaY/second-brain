// Second Brain UI — plain JS, no build step.
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Math.random().toString(36).slice(2, 10);
const COLORS = ['#4f46e5', '#0891b2', '#c2410c', '#15803d', '#be185d', '#7c3aed', '#b45309', '#0f766e'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

let state = { data: null, version: null, busy: [], sync: {} };
let currentView = 'today';
let taskFilter = { course: '', type: '', showDone: false };
let importRows = [];

// ---------- data ----------
async function load() {
  const r = await fetch('/api/data');
  const j = await r.json();
  state.data = j.data; state.version = j.version; state.busy = j.busy || []; state.sync = j.sync || {};
  render();
}
const plan = days => Planner.buildPlan(state.data, { days, busy: state.busy });
let saveTimer;
function save() {
  render();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    const r = await fetch('/api/data', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data: state.data, version: state.version }) });
    const j = await r.json();
    if (r.status === 409) {
      state.data = j.data; state.version = j.version;
      toast('Data changed on disk (maybe a syllabus import) — reloaded. Redo your last change.');
      render();
    } else if (r.ok) state.version = j.version;
    else toast('Save failed: ' + (j.error || r.status));
  }, 250);
}
window.addEventListener('focus', () => { if (!$('#taskDialog').open) load(); });

function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(t._h); t._h = setTimeout(() => (t.hidden = true), 3500);
}

// ---------- helpers ----------
const course = id => state.data.courses.find(c => c.id === id);
const task = id => state.data.tasks.find(t => t.id === id);
function chip(courseId) {
  const c = course(courseId);
  return c ? `<span class="chip" style="background:${esc(c.color)}">${esc(c.code || c.name)}</span>` : '';
}
function fmtDue(due) {
  if (!due) return 'Date TBA';
  const d = new Date(due);
  return d.toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}
function relDue(due) {
  if (!due) return 'add the date once it\'s announced';
  const ms = new Date(due) - new Date();
  const days = Math.floor((Planner.startOfDay(due) - Planner.startOfDay(new Date())) / 86400000);
  if (ms < 0) return `<span class="due-soon">overdue</span>`;
  if (days === 0) return `<span class="due-soon">today</span>`;
  if (days === 1) return `<span class="due-soon">tomorrow</span>`;
  return `in ${days} days`;
}
function est(t) { return t.estHours == null || t.estHours === '' ? Planner.DEFAULT_HOURS[t.type] || 2 : Number(t.estHours); }
function progressBar(t) {
  const pct = Math.min(100, Math.round(((Number(t.progressHours) || 0) / (est(t) || 1)) * 100));
  return `<div class="bar" title="${pct}% of estimated work done"><span style="width:${pct}%"></span></div>`;
}
const fmtTime = hhmm => new Date(`2000-01-01T${hhmm}`).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const fmtTimes = times => (times || []).map(x => `${fmtTime(x.start)}–${fmtTime(x.end)}`).join(', ');
function taskRow(t, extra = '') {
  return `<div class="item ${t.done ? 'done' : ''}">
    <input type="checkbox" data-toggle="${t.id}" ${t.done ? 'checked' : ''} title="Mark complete">
    <div class="main">
      <div class="tags">${chip(t.courseId)}<span class="type ${esc(t.type)}">${esc(t.type)}</span></div>
      <div class="title" data-edit="${t.id}">${esc(t.title)}</div>
      <div class="meta">${fmtDue(t.due)} · ${relDue(t.due)}${t.weight ? ` · ${esc(t.weight)}% of grade` : ''}</div>
    </div><div class="extra">${extra}</div></div>`;
}

// ---------- views ----------
function render() {
  if (!state.data) return;
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('active', b.dataset.view === currentView));
  ({ today: viewToday, plan: viewPlan, tasks: viewTasks, import: viewImport, settings: viewSettings })[currentView]();
}

function viewToday() {
  const d = state.data;
  const p = plan(28);
  const now = new Date();
  const todayPlan = p.days[0];
  const week = d.tasks.filter(t => !t.done && t.due && new Date(t.due) > now && new Date(t.due) - now < 7 * 86400000)
    .sort((a, b) => new Date(a.due) - new Date(b.due));
  const exams = d.tasks.filter(t => !t.done && t.due && ['exam', 'quiz'].includes(t.type) && new Date(t.due) > now && new Date(t.due) - now < 21 * 86400000)
    .sort((a, b) => new Date(a.due) - new Date(b.due));
  const tba = d.tasks.filter(t => !t.done && !t.due);
  const doneToday = (d.log || []).filter(l => l.date === Planner.ymd(now)).reduce((a, l) => a + l.hours, 0);

  let html = `<h1>${now.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}</h1>
    <p class="sub">${doneToday ? `You've logged ${doneToday}h today. ` : ''}${todayPlan.blocks.length ? `${todayPlan.used}h planned for today.` : 'Nothing planned for today.'}</p>`;

  if (!d.courses.length && !d.tasks.length) {
    html += `<div class="card"><h2 style="margin-top:0">Welcome 👋</h2>
      <p>Get started by adding your syllabi:</p>
      <ol>
        <li><b>Easiest:</b> open <a href="#" data-go="import">Import syllabus</a>, copy the prompt, and give it plus your syllabus PDFs to any AI chatbot (ChatGPT, Claude, Gemini…). Paste its answer back.</li>
        <li>Using Claude Code? Drop the PDFs into the <code>syllabi/</code> folder and say <i>"import my syllabi"</i>.</li>
        <li>Or paste the schedule text yourself, or add things by hand with <b>+ Add</b>.</li>
      </ol>
      <p>Then set how many hours you can study each day in <a href="#" data-go="settings">Settings</a>.</p></div>`;
  }

  p.overdue.forEach(id => { const t = task(id); html += `<div class="alert danger">⚠️ Overdue: ${chip(t.courseId)} <b>${esc(t.title)}</b> (was due ${fmtDue(t.due)}). Check it off if you submitted it.</div>`; });

  html += `<div class="grid2"><div class="card"><h2 style="margin-top:0">Today's plan</h2>`;
  html += todayPlan.blocks.length ? todayPlan.blocks.map(b => {
    const t = task(b.taskId);
    return taskRow(t, `<span class="hours" title="${esc(fmtTimes(b.times))}">${b.times?.length ? fmtTime(b.times[0].start) + ' · ' : ''}${b.hours}h</span><button class="small" data-block="${t.id}" data-hours="${b.hours}" title="Log this study session">Did it ✓</button>`);
  }).join('') : `<div class="empty">Free day 🎉${week.length ? ' (or get ahead on something below)' : ''}</div>`;
  html += `</div><div class="card"><h2 style="margin-top:0">Due in the next 7 days</h2>`;
  html += week.length ? week.map(t => taskRow(t, `<div style="width:80px">${progressBar(t)}</div>`)).join('') : `<div class="empty">Nothing due this week.</div>`;
  html += `</div></div>`;

  html += `<h2>Upcoming exams & quizzes (3 weeks)</h2><div class="card">`;
  html += exams.length ? exams.map(t => taskRow(t, `<div style="width:80px">${progressBar(t)}</div>`)).join('') : `<div class="empty">None in the next 3 weeks.</div>`;
  html += `</div>`;
  if (tba.length) {
    html += `<h2>Date TBA</h2><div class="card">${tba.map(t => taskRow(t)).join('')}
      <p class="muted" style="margin-bottom:0;font-size:13px">These aren't planned yet. Click one to add its date once it's announced (or it'll fill in automatically if it shows up in Canvas).</p></div>`;
  }
  $('#view').innerHTML = html;
}

function viewPlan() {
  const d = state.data;
  const p = plan(21);
  const hours = d.settings.weekdayHours;
  const outlookOn = d.settings.outlook?.enabled;
  let html = `<h1>Study plan</h1><p class="sub">Auto-scheduled from deadlines, estimated hours, and your available time${outlookOn ? ', fitted around your Outlook calendar' : ''}. It re-plans every time something changes.</p><div class="days">`;
  p.days.forEach((day, i) => {
    const date = new Date(day.date + 'T00:00');
    const deadlines = d.tasks.filter(t => !t.done && t.due && Planner.ymd(t.due) === day.date);
    const busy = state.busy.filter(b => b.start.slice(0, 10) === day.date);
    const cap = Math.min(hours[date.getDay()], day.freeHours);
    // One time-ordered list of Outlook events and study sessions.
    const rows = [
      ...busy.map(b => ({ at: b.start.slice(11), html: `<div class="busy">${fmtTime(b.start.slice(11))}–${fmtTime(b.end.slice(11))} ${esc(b.subject || 'Busy')}</div>` })),
      ...day.blocks.flatMap(b => {
        const t = task(b.taskId); const c = course(t.courseId);
        const times = b.times?.length ? b.times : [{ start: '', end: '' }];
        return times.map(tm => ({ at: tm.start, html: `<div class="block" style="border-color:${esc(c?.color || '#888')};background:color-mix(in srgb, ${esc(c?.color || '#888')} 16%, transparent)">${tm.start ? `<span class="time">${fmtTime(tm.start)}–${fmtTime(tm.end)}</span> ` : `<b>${b.hours}h</b> `}${esc(c?.code || '')} <span class="title" data-edit="${t.id}">${esc(t.title)}</span></div>` }));
      }),
    ].sort((a, b) => a.at.localeCompare(b.at));
    html += `<div class="day ${i === 0 ? 'today' : ''} ${!cap ? 'off' : ''}">
      <h3><span>${i === 0 ? 'Today' : i === 1 ? 'Tomorrow' : date.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}</span><span class="muted">${day.used}/${cap}h</span></h3>`;
    deadlines.forEach(t => { html += `<div class="deadline">📌 ${esc(course(t.courseId)?.code || '')} ${esc(t.title)} — ${new Date(t.due).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</div>`; });
    html += rows.map(r => r.html).join('');
    if (!rows.length && !deadlines.length) html += `<div class="muted" style="font-size:13px">—</div>`;
    html += `</div>`;
  });
  html += `</div>`;
  $('#view').innerHTML = html;
}

function viewTasks() {
  const d = state.data;
  let list = d.tasks.filter(t => (!taskFilter.course || t.courseId === taskFilter.course) && (!taskFilter.type || t.type === taskFilter.type) && (taskFilter.showDone || !t.done))
    .sort((a, b) => (a.due ? new Date(a.due).getTime() : 8.64e15) - (b.due ? new Date(b.due).getTime() : 8.64e15));
  let html = `<h1>All tasks</h1><p class="sub">${d.tasks.filter(t => !t.done).length} open · ${d.tasks.filter(t => t.done).length} done</p>
    <div class="filters">
      <select id="fCourse"><option value="">All courses</option>${d.courses.map(c => `<option value="${c.id}" ${taskFilter.course === c.id ? 'selected' : ''}>${esc(c.code || c.name)}</option>`).join('')}</select>
      <select id="fType"><option value="">All types</option>${['assignment', 'exam', 'quiz', 'project', 'reading', 'other'].map(x => `<option ${taskFilter.type === x ? 'selected' : ''}>${x}</option>`).join('')}</select>
      <label class="inline" style="margin:0"><input type="checkbox" id="fDone" ${taskFilter.showDone ? 'checked' : ''}> show completed</label>
    </div><div class="card table-wrap"><table><thead><tr><th></th><th>Course</th><th>Type</th><th>Title</th><th>Due</th><th>Hours</th><th>Progress</th></tr></thead><tbody>`;
  let lastDay;
  const dayLabel = t => t.due ? new Date(t.due).toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' }) : 'Date TBA';
  html += list.map(t => {
    const day = t.due ? t.due.slice(0, 10) : 'tba';
    const sep = day !== lastDay ? `<tr class="day-sep"><td colspan="7">${esc(dayLabel(t))}</td></tr>` : '';
    lastDay = day;
    return sep + `<tr class="${t.done ? 'muted' : ''}">
    <td><input type="checkbox" data-toggle="${t.id}" ${t.done ? 'checked' : ''}></td>
    <td>${chip(t.courseId)}</td><td><span class="type ${esc(t.type)}">${esc(t.type)}</span></td>
    <td><span class="title" data-edit="${t.id}" style="cursor:pointer">${esc(t.title)}</span></td>
    <td style="white-space:nowrap">${fmtDue(t.due)}<br><span class="muted" style="font-size:12px">${relDue(t.due)}</span></td>
    <td>${Number(t.progressHours) || 0}/${est(t)}</td><td style="min-width:80px">${progressBar(t)}</td></tr>`;
  }).join('');
  html += `</tbody></table>${list.length ? '' : '<div class="empty">No tasks match.</div>'}</div>`;
  $('#view').innerHTML = html;
  $('#fCourse').onchange = e => { taskFilter.course = e.target.value; render(); };
  $('#fType').onchange = e => { taskFilter.type = e.target.value; render(); };
  $('#fDone').onchange = e => { taskFilter.showDone = e.target.checked; render(); };
}

function viewSettings() {
  const s = state.data.settings;
  const o = s.outlook || (s.outlook = {});
  const cs = state.sync.canvas || {}, os = state.sync.outlook || {};
  const ago = iso => iso ? new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'never';
  const canvasStatus = cs.error ? `<span class="due-soon">⚠️ ${esc(cs.error)}</span>`
    : cs.lastSync ? `✓ Last synced ${ago(cs.lastSync)}: ${cs.items} Canvas items (${cs.linked} matched to syllabus tasks, ${cs.added} new, ${cs.updated} updates).` : 'Not connected yet.';
  const outlookStatus = state.sync.outlookRunning ? 'Syncing now…'
    : os.error ? `<span class="due-soon">⚠️ ${esc(os.error)}</span>`
    : os.lastWrite ? `✓ Last synced ${ago(os.lastWrite)}${o.planAroundEvents ? `: ${os.busyEvents} busy events found in the next 3 weeks (${os.calendarItems} items in your Calendar)` : ''}. "${esc(o.calendarName || 'Second Brain')}" calendar: +${os.added} / ~${os.updated} / −${os.deleted}.` : 'Off.';
  let html = `<h1>Settings</h1>
  <h2>Connections</h2><div class="card">
    <h3 class="settings-h">Canvas</h3>
    <p class="muted">Pulls every assignment, quiz and exam date from Canvas automatically (every 30 min) and matches them to the tasks from your syllabi.
      Get the link in Canvas: <b>Calendar → "Calendar Feed"</b> (bottom right) → copy the URL.</p>
    <label>Canvas calendar feed URL <input id="canvasUrl" value="${esc(s.canvasFeedUrl || '')}" placeholder="https://yourschool.instructure.com/feeds/calendars/user_….ics"></label>
    <p class="sync-status">${canvasStatus}</p>
    <h3 class="settings-h">Outlook</h3>
    <p class="muted">Windows only: uses the classic Outlook desktop app on this PC (signed in to your school/work account) every 15 min. Your own events are only read, never changed.
      Study sessions go into a separate calendar you can hide or delete anytime.</p>
    <label class="inline"><input type="checkbox" id="olEnabled" ${o.enabled ? 'checked' : ''}> Sync with Outlook</label>
    <label class="inline"><input type="checkbox" id="olRead" ${o.planAroundEvents !== false ? 'checked' : ''}> Plan study time around events in my Outlook <b>Calendar</b> (work, classes…)</label>
    <label class="inline"><input type="checkbox" id="olStudy" ${o.writeStudyBlocks !== false ? 'checked' : ''}> Add my study sessions to Outlook (next 7 days, 10-min reminder)</label>
    <label class="inline"><input type="checkbox" id="olDue" ${o.writeDeadlines !== false ? 'checked' : ''}> Add deadlines that aren't already in Canvas (1-day reminder)</label>
    <div class="row"><label>Outlook calendar to create <input id="olName" value="${esc(o.calendarName || 'Second Brain')}"></label><span></span></div>
    <p class="sync-status">${outlookStatus}</p>
    <div class="actions"><button id="syncNow">Sync now</button></div>
  </div>
  <h2>Courses</h2><div class="card">
    ${state.data.courses.map(c => `<div class="item"><input type="color" value="${esc(c.color)}" data-ccolor="${c.id}" style="width:40px;padding:0;height:28px">
      <input value="${esc(c.code)}" data-ccode="${c.id}" placeholder="Code (CS 101)" style="max-width:140px">
      <input value="${esc(c.name)}" data-cname="${c.id}" placeholder="Course name">
      <button class="small danger" data-cdel="${c.id}">Remove</button></div>`).join('') || '<div class="empty">No courses yet.</div>'}
    <div class="actions"><button id="addCourse">+ Add course</button></div>
  </div>
  <h2>Available study hours per day</h2><div class="card">
    <div class="weekhours">${WEEKDAYS.map((w, i) => `<label>${w}<input type="number" min="0" max="16" step="0.5" value="${s.weekdayHours[i]}" data-wh="${i}"></label>`).join('')}</div>
    <div class="row">
      <label>Max hours on one task per day <input type="number" min="0.5" step="0.5" id="maxBlock" value="${s.maxBlockHours}"></label>
      <label>Study between <input type="time" id="winStart" value="${esc(s.studyWindow?.start || '09:00')}"></label>
      <label>and <input type="time" id="winEnd" value="${esc(s.studyWindow?.end || '23:00')}"></label>
      <label>Gap around events (min) <input type="number" min="0" step="5" id="buffer" value="${s.bufferMinutes ?? 15}"></label>
    </div>
  </div>
  <h2>Reminders</h2><div class="card">
    <p class="muted" style="margin-top:0">Desktop notifications fire while the Second Brain server is running (the terminal window, or see README for auto-start).</p>
    <div class="row">
      <label>Remind me this many hours before deadlines <input id="leads" value="${esc(s.reminderLeadHours.join(', '))}" placeholder="72, 24, 3"></label>
      <label>Morning plan notification at <input type="time" id="digest" value="${esc(s.digestTime)}"></label>
    </div>
    <div class="actions"><button id="testNotif">Send test notification</button><a href="/calendar.ics"><button type="button">Download deadlines (.ics) for Google/Apple Calendar</button></a></div>
  </div>`;
  $('#view').innerHTML = html;

  document.querySelectorAll('[data-wh]').forEach(i => i.onchange = () => { s.weekdayHours[i.dataset.wh] = Number(i.value) || 0; save(); });
  $('#maxBlock').onchange = e => { s.maxBlockHours = Number(e.target.value) || 2; save(); };
  $('#winStart').onchange = e => { s.studyWindow = { ...s.studyWindow, start: e.target.value }; save(); };
  $('#winEnd').onchange = e => { s.studyWindow = { ...s.studyWindow, end: e.target.value }; save(); };
  $('#buffer').onchange = e => { s.bufferMinutes = Number(e.target.value) || 0; save(); };
  $('#canvasUrl').onchange = e => { s.canvasFeedUrl = e.target.value.trim(); save(); if (s.canvasFeedUrl) syncNow(); };
  $('#olEnabled').onchange = e => { o.enabled = e.target.checked; save(); if (o.enabled) syncNow(); };
  $('#olRead').onchange = e => { o.planAroundEvents = e.target.checked; save(); };
  $('#olStudy').onchange = e => { o.writeStudyBlocks = e.target.checked; save(); };
  $('#olDue').onchange = e => { o.writeDeadlines = e.target.checked; save(); };
  $('#olName').onchange = e => { o.calendarName = e.target.value.trim() || 'Second Brain'; save(); };
  $('#syncNow').onclick = () => syncNow();
  $('#leads').onchange = e => { s.reminderLeadHours = e.target.value.split(/[,\s]+/).map(Number).filter(n => n > 0); save(); };
  $('#digest').onchange = e => { s.digestTime = e.target.value; save(); };
  $('#testNotif').onclick = async () => { await fetch('/api/test-notification', { method: 'POST' }); toast('Sent. Check your desktop notifications.'); };
  $('#addCourse').onclick = () => { addCourse('', ''); save(); };
  document.querySelectorAll('[data-ccode]').forEach(i => i.onchange = () => { course(i.dataset.ccode).code = i.value; save(); });
  document.querySelectorAll('[data-cname]').forEach(i => i.onchange = () => { course(i.dataset.cname).name = i.value; save(); });
  document.querySelectorAll('[data-ccolor]').forEach(i => i.onchange = () => { course(i.dataset.ccolor).color = i.value; save(); });
  document.querySelectorAll('[data-cdel]').forEach(b => b.onclick = () => {
    const n = state.data.tasks.filter(t => t.courseId === b.dataset.cdel).length;
    if (n && b.textContent !== 'Click again to delete') { b.textContent = 'Click again to delete'; toast(`This also deletes its ${n} task(s).`); return; }
    state.data.courses = state.data.courses.filter(c => c.id !== b.dataset.cdel);
    state.data.tasks = state.data.tasks.filter(t => t.courseId !== b.dataset.cdel);
    save();
  });
}
async function syncNow() {
  await new Promise(r => setTimeout(r, 600)); // let the pending settings save land first
  toast('Syncing with Canvas/Outlook… (Outlook can take up to a minute)');
  const btn = $('#syncNow'); if (btn) { btn.disabled = true; btn.textContent = 'Syncing…'; }
  await fetch('/api/sync', { method: 'POST' });
  await load();
  toast('Sync finished.');
}
function addCourse(code, name) {
  const c = { id: uid(), code, name, color: COLORS[state.data.courses.length % COLORS.length] };
  state.data.courses.push(c);
  return c;
}

// ---------- syllabus import (paste) ----------
const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
const TYPE_RULES = [
  [/\b(exam|midterm)\b/i, 'exam'],
  [/\bquiz(zes)?\b/i, 'quiz'],
  [/\b(project|presentation)\b/i, 'project'],
  [/\bfinal\b/i, 'exam'],
  [/\b(hw|homework|assignment|problem set|pset|ps\d|lab|essay|paper|report|due|submit|write-?up|reflection)\b/i, 'assignment'],
  [/\b(read|reading|chapter|ch\.)\b/i, 'reading'],
];
function parseSyllabus(text) {
  const rows = [];
  const today = new Date();
  const monthRe = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s*(\d{4}))?/i;
  const slashRe = /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/;
  const timeRe = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)/i;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    let m, month, day, year, matched;
    if ((m = line.match(monthRe))) { month = MONTHS[m[1].toLowerCase().slice(0, 3)]; day = +m[2]; year = m[3] && +m[3]; matched = m[0]; }
    else if ((m = line.match(slashRe)) && +m[1] <= 12 && +m[2] <= 31) { month = +m[1] - 1; day = +m[2]; year = m[3] && (+m[3] < 100 ? 2000 + +m[3] : +m[3]); matched = m[0]; }
    else continue;
    let type = 'other';
    for (const [re, ty] of TYPE_RULES) if (re.test(line)) { type = ty; break; }
    let hh = type === 'exam' || type === 'quiz' ? 9 : 23, mm = type === 'exam' || type === 'quiz' ? 0 : 59;
    const tm = line.match(timeRe);
    if (tm) { hh = (+tm[1] % 12) + (/p/i.test(tm[3]) ? 12 : 0); mm = +(tm[2] || 0); }
    if (!year) {
      year = today.getFullYear();
      if (new Date(year, month, day) < Planner.addDays(today, -60)) year++;
    }
    const due = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
    let title = line.replace(matched, '').replace(tm ? tm[0] : '', '')
      .replace(/\b(mon|tue|wed|thu|fri|sat|sun)[a-z]*\.?,?/gi, '').replace(/^\s*week\s*\d+\b/i, '')
      .replace(/[,;\s]+\)/g, ')').replace(/\(\s*\)/g, '')
      .replace(/^[\s\-–—:|,.•*]+|[\s\-–—:|,.]+$/g, '').replace(/\s+(due|by|on)$/i, '').replace(/\s{2,}/g, ' ').trim().slice(0, 90);
    if (!title) title = type === 'other' ? 'Untitled' : type[0].toUpperCase() + type.slice(1);
    rows.push({ keep: type !== 'other', title, type, due, estHours: Planner.DEFAULT_HOURS[type] });
  }
  return rows;
}

// ---------- syllabus import (any AI chatbot → JSON) ----------
const TYPES = ['assignment', 'exam', 'quiz', 'project', 'reading', 'other'];
function aiPrompt(termStart, termNotes) {
  return `I'm attaching one or more course syllabi. Extract every graded or dated item from each one: assignments, problem sets, labs, essays, projects (and their milestones), quizzes, midterms, finals, and presentations.

${termStart ? `The term's first day of classes is ${termStart}. Week 1 is the week containing that date; use it to turn "Week N" into real dates.` : 'Work out the term start date from the syllabus and use it to turn "Week N" into real dates.'}${termNotes ? `\nOther term details: ${termNotes}` : ''}

Rules:
- Expand recurring items into one task per occurrence (e.g. "quiz every Friday" means one quiz per Friday of the term; "HW due each Wednesday, weeks 2-9" means 8 tasks).
- "due" is local time formatted exactly YYYY-MM-DDTHH:MM. If no time is given, use 23:59 for assignments, and the class time (or 09:00) for exams and quizzes.
- If a date isn't announced yet (TBA, or finals week without a date), use null for "due".
- "type" must be one of: assignment, exam, quiz, project, reading, other.
- "estHours" is a realistic number of hours of work: problem set 3-6, essay 6-12, lab report 3-5, weekly quiz 1-2, midterm 6-10, final 12-20, projects scaled by grade weight.
- "weight" is the % of the final grade for that single item, or null if unknown.
- "notes" holds useful details: topics covered, where to submit, allowed materials.
- Put anything ambiguous (missing times, unclear dates, assumptions you made) in "warnings".

Reply with ONLY this JSON (no other text):
{
  "courses": [
    {
      "code": "CS 101",
      "name": "Intro to Computer Science",
      "tasks": [
        { "title": "Problem Set 3", "type": "assignment", "due": "2026-10-14T23:59", "estHours": 4, "weight": 5, "notes": "Chapters 3-4; submit on Gradescope" }
      ]
    }
  ],
  "warnings": ["CS 101: final exam date TBA"]
}`;
}

// Accepts the chatbot's reply (with or without ```json fences or extra text around it).
function parseAiJson(text) {
  const start = text.indexOf('{'), end = text.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error("Couldn't find any JSON in that text.");
  const j = JSON.parse(text.slice(start, end + 1));
  const list = Array.isArray(j.courses) ? j.courses : Array.isArray(j) ? j : j.code || j.tasks ? [j] : [];
  if (!list.length) throw new Error('The JSON has no "courses" in it.');
  const rows = [];
  for (const c of list) {
    const code = String(c.code || c.name || 'Unnamed course').trim();
    for (const t of c.tasks || []) {
      const type = TYPES.includes(t.type) ? t.type : Planner.guessType(t.title || '');
      let due = t.due ? String(t.due).trim().replace(' ', 'T').slice(0, 16) : null;
      if (due && /^\d{4}-\d{2}-\d{2}$/.test(due)) due += type === 'exam' || type === 'quiz' ? 'T09:00' : 'T23:59';
      if (due && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(due)) due = null;
      const estHours = Number(t.estHours) > 0 ? Number(t.estHours) : Planner.DEFAULT_HOURS[type];
      rows.push({ keep: true, courseCode: code, courseName: String(c.name || '').trim(), title: String(t.title || 'Untitled').trim(), type, due, estHours, weight: t.weight == null || t.weight === '' ? null : Number(t.weight) || null, notes: String(t.notes || '') });
    }
  }
  if (!rows.length) throw new Error('Found the courses but no tasks in them.');
  return { rows, warnings: (Array.isArray(j.warnings) ? j.warnings : []).map(String) };
}
let importWarnings = [];
const normCode = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const courseByCode = code => state.data.courses.find(c => normCode(c.code) && normCode(c.code) === normCode(code));
// Same course + title + due date as a task we already have.
function isDuplicate(r) {
  const cid = r.courseCode ? courseByCode(r.courseCode)?.id : $('#impCourse')?.value;
  return !!cid && state.data.tasks.some(t => t.courseId === cid && t.title.trim().toLowerCase() === r.title.toLowerCase() && (t.due || null) === (r.due || null));
}

function viewImport() {
  const courses = state.data.courses;
  const s = state.data.settings;
  let html = `<h1>Import syllabus</h1>
  <div class="card" style="margin-bottom:16px">
    <h2 style="margin-top:0">Option 1: Use any AI chatbot (recommended)</h2>
    <p class="muted" style="margin-top:0">Works with ChatGPT, Claude, Gemini, Copilot… anything that can read a PDF. It handles week-based schedules, tables and "every Friday" quizzes.</p>
    <div class="row">
      <label>First day of classes this term <input type="date" id="aiTermStart" value="${esc(s.termStart || '')}"></label>
      <label>Breaks / finals info (optional) <input id="aiTermNotes" value="${esc(s.termNotes || '')}" placeholder="e.g. Thanksgiving break Nov 25–29; finals week Dec 7"></label>
    </div>
    <ol style="padding-left:20px">
      <li><button id="aiCopy" class="primary">Copy prompt</button> and paste it into a new chat.</li>
      <li>Attach your syllabus PDFs (or paste their text) and send it.</li>
      <li>Paste the chatbot's whole answer here:</li>
    </ol>
    <textarea id="aiPromptText" hidden readonly></textarea>
    <textarea id="aiJson" rows="6" placeholder='{ "courses": [ ... ] }'></textarea>
    <div class="actions"><button id="aiLoad" class="primary">Load tasks</button></div>
  </div>
  <div class="card" style="margin-bottom:16px">
    <h2 style="margin-top:0">Option 2: Claude Code</h2>
    <p class="muted" style="margin:0">Put your syllabus files in the <code>syllabi/</code> folder of this project and tell Claude Code <i>"import my syllabi"</i>. It writes them straight into the app.</p>
  </div>
  <div class="card">
    <h2 style="margin-top:0">Option 3: Paste the schedule text</h2>
    <p class="muted" style="margin-top:0">No AI needed. Paste the schedule / due-dates part of a syllabus. Lines containing a date (e.g. <i>Oct 14</i>, <i>10/14</i>) become tasks you can review before adding. Less accurate than options 1 and 2.</p>
    <div class="row">
      <label>Course <select id="impCourse"><option value="__new">+ New course…</option>${courses.map(c => `<option value="${c.id}">${esc(c.code || c.name)}</option>`).join('')}</select></label>
      <label id="newCourseWrap">New course code <input id="impNewCourse" placeholder="e.g. MATH 20B"></label>
    </div>
    <label>Syllabus text <textarea id="impText" rows="10" placeholder="Oct 3 — Homework 1 due 11:59pm&#10;Oct 10 Quiz 1&#10;Oct 24 Midterm Exam&#10;..."></textarea></label>
    <button id="impParse" class="primary">Find dates</button>
  </div>
  <div id="impReview"></div>`;
  $('#view').innerHTML = html;
  const sel = $('#impCourse');
  if (courses.length) sel.value = courses[courses.length - 1].id;
  const syncNew = () => { $('#newCourseWrap').hidden = sel.value !== '__new'; };
  sel.onchange = syncNew; syncNew();
  $('#impParse').onclick = () => { importRows = parseSyllabus($('#impText').value); importWarnings = []; renderImportReview(); };

  const termInputs = () => {
    s.termStart = $('#aiTermStart').value; s.termNotes = $('#aiTermNotes').value.trim();
    $('#aiPromptText').value = aiPrompt(s.termStart, s.termNotes);
  };
  termInputs();
  $('#aiTermStart').onchange = $('#aiTermNotes').onchange = () => { termInputs(); save(); };
  $('#aiCopy').onclick = async () => {
    termInputs();
    if (!s.termStart) toast('Tip: fill in the first day of classes so "Week N" dates come out right.');
    try { await navigator.clipboard.writeText($('#aiPromptText').value); toast('Prompt copied. Paste it into your chatbot with your syllabi.'); }
    catch { const ta = $('#aiPromptText'); ta.hidden = false; ta.rows = 12; ta.select(); toast('Copy the selected prompt with Ctrl+C.'); }
  };
  $('#aiLoad').onclick = () => {
    try {
      ({ rows: importRows, warnings: importWarnings } = parseAiJson($('#aiJson').value));
      importRows.forEach(r => { if (isDuplicate(r)) r.keep = false; });
    }
    catch (e) { importRows = []; importWarnings = []; $('#impReview').innerHTML = `<div class="alert warn" style="margin-top:12px">${esc(e.message)} Make sure you pasted the chatbot's whole answer.</div>`; return; }
    renderImportReview();
    $('#impReview').scrollIntoView({ behavior: 'smooth' });
  };
  if (importRows.length) renderImportReview();
}
function renderImportReview() {
  const el = $('#impReview');
  if (!importRows.length) { el.innerHTML = `<div class="alert warn" style="margin-top:12px">No dates found. Try pasting just the schedule section, or use option 1 above.</div>`; return; }
  const fromAi = importRows.some(r => r.courseCode);
  const dupes = importRows.filter(isDuplicate).length;
  el.innerHTML = `<h2>Review (${importRows.filter(r => r.keep).length} selected)</h2>
    ${importWarnings.map(w => `<div class="alert warn">⚠️ ${esc(w)}</div>`).join('')}
    ${dupes ? `<p class="muted">${dupes} item(s) you already have are unchecked.</p>` : ''}
    <div class="card table-wrap"><table>
    <thead><tr><th>Add</th>${fromAi ? '<th>Course</th>' : ''}<th>Title</th><th>Type</th><th>Due (empty = TBA)</th><th>Est. hrs</th></tr></thead><tbody>
    ${importRows.map((r, i) => `<tr>
      <td><input type="checkbox" data-i="${i}" data-f="keep" ${r.keep ? 'checked' : ''}></td>
      ${fromAi ? `<td>${esc(r.courseCode)}</td>` : ''}
      <td><input data-i="${i}" data-f="title" value="${esc(r.title)}"></td>
      <td><select data-i="${i}" data-f="type">${TYPES.map(x => `<option ${r.type === x ? 'selected' : ''}>${x}</option>`).join('')}</select></td>
      <td><input type="datetime-local" data-i="${i}" data-f="due" value="${esc(r.due || '')}"></td>
      <td><input type="number" step="0.5" min="0" data-i="${i}" data-f="estHours" value="${r.estHours}" style="width:80px"></td></tr>`).join('')}
    </tbody></table><div class="actions"><span class="spacer"></span><button id="impAdd" class="primary">Add selected to my brain</button></div></div>`;
  el.querySelectorAll('[data-f]').forEach(inp => inp.onchange = () => {
    const r = importRows[inp.dataset.i];
    r[inp.dataset.f] = inp.type === 'checkbox' ? inp.checked : inp.type === 'number' ? Number(inp.value) : inp.value;
    if (inp.dataset.f === 'keep') el.querySelector('h2').textContent = `Review (${importRows.filter(r => r.keep).length} selected)`;
  });
  $('#impAdd').onclick = () => {
    let courseId = $('#impCourse').value;
    const picked = importRows.filter(r => r.keep);
    if (courseId === '__new' && picked.some(r => !r.courseCode)) {
      const code = $('#impNewCourse').value.trim();
      if (!code) { toast('Give the new course a code first.'); return; }
      courseId = addCourse(code, '').id;
    }
    picked.forEach(r => {
      const cid = r.courseCode ? (courseByCode(r.courseCode) || addCourse(r.courseCode, r.courseName)).id : courseId;
      state.data.tasks.push({ id: uid(), courseId: cid, title: r.title, type: r.type, due: r.due || null, estHours: r.estHours, progressHours: 0, weight: r.weight ?? null, done: false, notes: r.notes || '' });
    });
    importRows = []; importWarnings = []; if ($('#aiJson')) $('#aiJson').value = '';
    toast(`Added ${picked.length} tasks.`);
    currentView = 'today';
    save();
  };
}

// ---------- task dialog ----------
let editingId = null;
function openTask(id) {
  editingId = id || null;
  const t = id ? task(id) : { type: 'assignment', courseId: state.data.courses[0]?.id };
  const f = $('#taskForm');
  f.courseId.innerHTML = `<option value="">(no course)</option>` + state.data.courses.map(c => `<option value="${c.id}">${esc(c.code || c.name)}</option>`).join('');
  f.title.value = t.title || '';
  f.courseId.value = t.courseId || '';
  f.type.value = t.type || 'assignment';
  f.due.value = t.due || '';
  f.estHours.value = t.estHours ?? '';
  f.progressHours.value = t.progressHours ?? '';
  f.weight.value = t.weight ?? '';
  f.notes.value = t.notes || '';
  $('#taskDialogTitle').textContent = id ? 'Edit task' : 'Add task';
  $('#deleteTask').hidden = !id;
  $('#deleteTask').textContent = 'Delete';
  $('#taskDialog').showModal();
}
$('#taskForm').addEventListener('submit', () => {
  const f = $('#taskForm');
  const vals = {
    title: f.title.value.trim(), courseId: f.courseId.value, type: f.type.value, due: f.due.value || null,
    estHours: f.estHours.value === '' ? null : Number(f.estHours.value),
    progressHours: Number(f.progressHours.value) || 0,
    weight: f.weight.value === '' ? null : Number(f.weight.value),
    notes: f.notes.value,
  };
  if (editingId) Object.assign(task(editingId), vals);
  else state.data.tasks.push({ id: uid(), done: false, ...vals });
  save();
});
$('#cancelTask').onclick = () => $('#taskDialog').close();
$('#deleteTask').onclick = e => {
  if (e.target.textContent === 'Delete') { e.target.textContent = 'Really delete?'; return; }
  state.data.tasks = state.data.tasks.filter(t => t.id !== editingId);
  $('#taskDialog').close();
  save();
};

// ---------- global events ----------
$('#tabs').onclick = e => { const v = e.target.dataset.view; if (v) { currentView = v; render(); } };
$('#addBtn').onclick = () => openTask();
$('#view').addEventListener('click', e => {
  const t = e.target;
  if (t.dataset.edit) openTask(t.dataset.edit);
  if (t.dataset.go) { e.preventDefault(); currentView = t.dataset.go; render(); }
  if (t.dataset.block) {
    const tk = task(t.dataset.block), h = Number(t.dataset.hours);
    tk.progressHours = (Number(tk.progressHours) || 0) + h;
    state.data.log.push({ date: Planner.ymd(new Date()), taskId: tk.id, hours: h });
    if (tk.progressHours >= est(tk) && tk.type !== 'exam' && tk.type !== 'quiz') toast(`That's all the estimated time for "${tk.title}" — check it off when submitted.`);
    else toast(`Logged ${h}h on ${tk.title}.`);
    save();
  }
});
$('#view').addEventListener('change', e => {
  const id = e.target.dataset.toggle;
  if (id) { task(id).done = e.target.checked; save(); }
});

load();
