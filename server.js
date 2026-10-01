// Second Brain server: serves the UI, stores data in data/brain.json,
// and fires desktop reminders even when the browser tab is closed.
if (Number(process.versions.node.split('.')[0]) < 18) {
  console.error(`Second Brain needs Node.js 18 or newer (you have ${process.version}). Get it from https://nodejs.org`);
  process.exit(1);
}
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const Planner = require('./public/planner.js');

const PORT = Number(process.env.PORT) || 4321;
const ROOT = __dirname;
const DATA_FILE = path.join(ROOT, 'data', 'brain.json');
const STATE_FILE = path.join(ROOT, 'data', 'reminder-state.json');
const SYNC_FILE = path.join(ROOT, 'data', 'sync-status.json'); // Canvas/Outlook status + cached busy times
const PUBLIC = path.join(ROOT, 'public');

const DEFAULT_OUTLOOK = {
  enabled: false,
  planAroundEvents: true,   // read busy times from the default Outlook Calendar
  writeStudyBlocks: true,   // put study sessions (next 7 days) into the Second Brain calendar
  writeDeadlines: true,     // put deadlines that don't come from Canvas into it too
  calendarName: 'Second Brain',
};
const DEFAULT_DATA = {
  settings: {
    weekdayHours: [2, 3, 3, 3, 3, 1, 2], // Sun..Sat hours you're willing to study
    maxBlockHours: 2,                   // max hours on one task per day
    studyWindow: { start: '09:00', end: '23:00' }, // study sessions are placed inside this window
    bufferMinutes: 15,                  // gap kept around Outlook events
    minSlotMinutes: 30,                 // ignore free gaps shorter than this
    reminderLeadHours: [72, 24, 3],     // remind this many hours before each deadline
    digestTime: '08:30',                // morning "here's your day" notification
    canvasFeedUrl: '',
    termStart: '',                      // first day of classes (YYYY-MM-DD), used by the syllabus-import prompt
    termNotes: '',                      // breaks / finals info, also for the prompt
    outlook: DEFAULT_OUTLOOK,
  },
  courses: [],
  tasks: [],
  log: [],
};

// ---------- storage ----------
function ensureData() {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  if (!fs.existsSync(DATA_FILE)) writeJson(DATA_FILE, DEFAULT_DATA);
}
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJson(file, obj) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}
function loadData() {
  const d = readJson(DATA_FILE, null) || structuredClone(DEFAULT_DATA);
  d.settings = { ...DEFAULT_DATA.settings, ...(d.settings || {}) };
  d.settings.outlook = { ...DEFAULT_OUTLOOK, ...(d.settings.outlook || {}) };
  d.courses ||= []; d.tasks ||= []; d.log ||= [];
  return d;
}
function mtime() { try { return fs.statSync(DATA_FILE).mtimeMs; } catch { return 0; } }
function loadSync() { return readJson(SYNC_FILE, { canvas: {}, outlook: {}, busy: [] }); }
function saveSync(patch) { writeJson(SYNC_FILE, { ...loadSync(), ...patch }); }
function busyTimes(data) {
  return data.settings.outlook.enabled && data.settings.outlook.planAroundEvents ? loadSync().busy || [] : [];
}

// ---------- notifications ----------
function notifyOther(title, body) {
  // Title/body are passed as arguments (never spliced into a script), so task names can't inject commands.
  const [cmd, args] = process.platform === 'darwin'
    ? ['osascript', ['-e', 'on run argv', '-e', 'display notification (item 2 of argv) with title (item 1 of argv)', '-e', 'end run', title, body]]
    : ['notify-send', [title, body]];
  const child = spawn(cmd, args, { stdio: 'ignore' });
  child.on('error', () => {}); // no notifier installed (e.g. headless Linux): the console log is enough
}
function notify(title, body) {
  console.log(`[reminder] ${title} — ${body}`);
  if (process.platform !== 'win32') return notifyOther(title, body);
  const ps = `
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null
$t = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
$x = $t.GetElementsByTagName('text')
$x.Item(0).AppendChild($t.CreateTextNode($env:SB_TITLE)) > $null
$x.Item(1).AppendChild($t.CreateTextNode($env:SB_BODY)) > $null
$n = [Windows.UI.Notifications.ToastNotification]::new($t)
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe').Show($n)`;
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
    env: { ...process.env, SB_TITLE: title, SB_BODY: body },
    windowsHide: true,
    stdio: 'ignore',
  });
  child.on('error', e => console.error('toast failed:', e.message));
}

function courseLabel(data, t) {
  const c = data.courses.find(c => c.id === t.courseId);
  return c ? c.code || c.name : '';
}
function fmtLead(ms) {
  const h = Math.round(ms / 3600000);
  if (h < 1) return 'in under an hour';
  if (h < 36) return `in ${h} hour${h === 1 ? '' : 's'}`;
  return `in ${Math.round(h / 24)} days`;
}

function checkReminders() {
  const data = loadData();
  const state = readJson(STATE_FILE, { sent: {}, lastDigest: null });
  const now = new Date();
  const leads = [...(data.settings.reminderLeadHours || [])].map(Number).sort((a, b) => a - b);
  let changed = false;

  for (const t of data.tasks) {
    if (t.done || !t.due) continue;
    const due = new Date(t.due);
    if (due <= now) continue;
    const key = h => `${t.id}|${t.due}|${h}`; // includes due so edited deadlines re-arm
    // Fire only the tightest lead we've crossed, and mark the looser ones as handled.
    const crossed = leads.filter(h => now >= due - h * 3600000);
    if (!crossed.length) continue;
    const tightest = crossed[0];
    if (!state.sent[key(tightest)]) {
      const label = courseLabel(data, t);
      notify(`${label ? label + ': ' : ''}${t.title}`, `${cap(t.type || 'task')} due ${fmtLead(due - now)} (${due.toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })})`);
    }
    for (const h of crossed) if (!state.sent[key(h)]) { state.sent[key(h)] = now.toISOString(); changed = true; }
  }

  // Morning digest: once per day, within 4 hours after digestTime.
  const [hh, mm] = String(data.settings.digestTime || '08:30').split(':').map(Number);
  const digestAt = new Date(now); digestAt.setHours(hh || 0, mm || 0, 0, 0);
  const todayKey = Planner.ymd(now);
  if (state.lastDigest !== todayKey && now >= digestAt && now - digestAt < 4 * 3600000) {
    const plan = Planner.buildPlan(data, { now, days: 1, busy: busyTimes(data) });
    const blocks = plan.days[0]?.blocks || [];
    const byId = Object.fromEntries(data.tasks.map(t => [t.id, t]));
    const body = blocks.length
      ? blocks.map(b => `${b.times?.[0]?.start || ''} ${courseLabel(data, byId[b.taskId])} ${byId[b.taskId].title}`.trim()).join(' · ')
      : 'Nothing scheduled today — nice.';
    notify(`Today's plan${plan.overdue.length ? ` (${plan.overdue.length} overdue!)` : ''}`, body);
    state.lastDigest = todayKey; changed = true;
  }
  if (changed) writeJson(STATE_FILE, state);
}
function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

// ---------- calendar export ----------
function toIcs(data) {
  const pad = n => String(n).padStart(2, '0');
  const stamp = d => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}T${pad(d.getHours())}${pad(d.getMinutes())}00`;
  const esc = s => String(s || '').replace(/[\\;,]/g, m => '\\' + m).replace(/\n/g, '\\n');
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//SecondBrain//EN', 'CALSCALE:GREGORIAN'];
  for (const t of data.tasks) {
    if (!t.due || t.done) continue;
    const due = new Date(t.due);
    const start = new Date(due.getTime() - 30 * 60000);
    const label = courseLabel(data, t);
    lines.push('BEGIN:VEVENT', `UID:${t.id}@secondbrain`, `DTSTAMP:${stamp(new Date())}`,
      `DTSTART:${stamp(start)}`, `DTEND:${stamp(due)}`,
      `SUMMARY:${esc(`${label ? '[' + label + '] ' : ''}${cap(t.type || 'task')}: ${t.title}`)}`,
      `DESCRIPTION:${esc(t.notes)}`,
      'BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:Reminder', 'TRIGGER:-P1D', 'END:VALARM',
      'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.join('\r\n');
}

// ---------- Canvas calendar feed ----------
function parseIcs(text) {
  const lines = text.replace(/\r?\n[ \t]/g, '').split(/\r?\n/); // unfold continuation lines
  const events = []; let cur = null;
  for (const l of lines) {
    if (l === 'BEGIN:VEVENT') cur = {};
    else if (l === 'END:VEVENT') { if (cur) events.push(cur); cur = null; }
    else if (cur) {
      const i = l.indexOf(':'); if (i < 0) continue;
      const [name, ...params] = l.slice(0, i).split(';');
      cur[name.toUpperCase()] = { value: l.slice(i + 1), params: params.join(';') };
    }
  }
  return events;
}
const icsText = s => String(s || '').replace(/\\n/gi, ' ').replace(/\\([,;\\])/g, '$1').trim();
function icsDate(p) {
  if (!p) return null;
  const v = p.value;
  if (/VALUE=DATE(?!-)/.test(p.params) || /^\d{8}$/.test(v)) return `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}T23:59`;
  const m = v.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)/);
  if (!m) return null;
  const d = m[7] ? new Date(Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6]))
    : new Date(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  return Planner.localIso(d);
}
const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const tokens = s => new Set(String(s || '').toLowerCase().match(/[a-z]+|\d+/g) || []);

function matchCourse(data, context) {
  const c = norm(context);
  if (!c) return null;
  let course = data.courses.find(x => x.code && c.includes(norm(x.code)));
  if (!course) {
    course = { id: 'canvas-' + c.slice(0, 16), code: context.slice(0, 24), name: context, color: '#6b7280' };
    if (!data.courses.find(x => x.id === course.id)) data.courses.push(course);
    else course = data.courses.find(x => x.id === course.id);
  }
  return course;
}

// Find the syllabus-imported task a Canvas item corresponds to (same course, close due date or TBA, similar title).
function findLink(data, courseId, title, due) {
  const tt = tokens(title);
  let best = null, bestScore = 0;
  for (const t of data.tasks) {
    if (t.canvasUid || t.courseId !== courseId) continue;
    const tba = !t.due;
    if (!tba && Math.abs(new Date(t.due) - new Date(due)) > 36 * 3600000) continue;
    let score = 0;
    for (const w of tokens(t.title)) if (tt.has(w)) score += /\d/.test(w) ? 2 : 1;
    if (t.type === Planner.guessType(title)) score += 1;
    if (tba && score < 3) continue; // TBA items need a strong title match (e.g. "Quiz 2")
    if (score > bestScore) { best = t; bestScore = score; }
  }
  return bestScore >= 1 ? best : null;
}

async function syncCanvas() {
  let data = loadData();
  const url = (data.settings.canvasFeedUrl || '').trim().replace(/^webcal:/i, 'https:');
  if (!url) return;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Canvas feed returned HTTP ${res.status}`);
    const events = parseIcs(await res.text()).filter(e => /assignment/i.test(e.UID?.value || ''));
    data = loadData(); // re-read in case the UI saved while we were fetching
    let added = 0, updated = 0, linked = 0;
    for (const e of events) {
      const uid = e.UID.value;
      const due = icsDate(e.DTSTART);
      if (!due) continue;
      const summary = icsText(e.SUMMARY?.value) || 'Untitled';
      const m = summary.match(/^(.*?)\s*\[([^\]]+)\]\s*$/);
      const title = (m ? m[1] : summary).trim();
      const course = matchCourse(data, m ? m[2] : '');
      let t = data.tasks.find(x => x.canvasUid === uid);
      if (t) {
        // Only apply changes Canvas made, so manual edits in the app survive.
        if (t.canvasDue !== due) { t.due = due; t.canvasDue = due; updated++; }
        if (t.canvasTitle !== title) { t.title = title; t.canvasTitle = title; updated++; }
        continue;
      }
      t = findLink(data, course?.id, title, due);
      if (t) { linked++; }
      else {
        const type = Planner.guessType(title);
        t = { id: Math.random().toString(36).slice(2, 10), courseId: course?.id || '', type, estHours: Planner.DEFAULT_HOURS[type], progressHours: 0, weight: null, done: false, notes: 'From Canvas.' };
        data.tasks.push(t); added++;
      }
      Object.assign(t, { canvasUid: uid, canvasDue: due, canvasTitle: title, due, title });
    }
    if (added || updated || linked) writeJson(DATA_FILE, data);
    saveSync({ canvas: { lastSync: new Date().toISOString(), items: events.length, added, updated, linked, error: null } });
    if (added || updated || linked) console.log(`[canvas] ${events.length} items: +${added} new, ${linked} linked, ${updated} updated`);
  } catch (e) {
    saveSync({ canvas: { ...loadSync().canvas, lastAttempt: new Date().toISOString(), error: e.message } });
    console.error('[canvas]', e.message);
  }
}

// ---------- Outlook (classic Outlook COM via outlook-bridge.ps1) ----------
function runBridge(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'outlook-bridge.ps1'), ...args], { windowsHide: true });
    let out = '', err = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    const timer = setTimeout(() => child.kill(), 180000);
    child.on('close', () => {
      clearTimeout(timer);
      const line = out.trim().split(/\r?\n/).pop() || '';
      try {
        const j = JSON.parse(line);
        j.ok ? resolve(j) : reject(new Error(j.error || 'Outlook bridge failed'));
      } catch { reject(new Error((err || out || 'no output from Outlook bridge').trim().slice(0, 300))); }
    });
  });
}

// Outlook category of each course = first category on a class event whose subject contains the
// course code (e.g. "Introduction to Business Statistics STAT 201 132" → "Red category").
// Remembered in sync-status so it survives weeks with no classes (breaks, finals).
function detectCourseCategories(data, events) {
  const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const found = { ...(loadSync().courseCategories || {}) };
  for (const c of data.courses) {
    const code = norm(c.code);
    const ev = code && events.find(e => e.categories && norm(e.subject).includes(code));
    if (ev) found[c.id] = ev.categories.split(',')[0].trim();
  }
  return found;
}

function outlookEvents(data, plan) {
  const o = data.settings.outlook;
  const course = id => data.courses.find(c => c.id === id);
  const learned = loadSync().courseCategories || {};
  // course.outlookCategory (+ outlookCategoryColor, created if missing) overrides the learned one.
  const cat = t => {
    const c = course(t.courseId);
    if (!c) return {};
    if (c.outlookCategory) return { categories: c.outlookCategory, categoryColor: c.outlookCategoryColor || null };
    return { categories: learned[c.id] || '' };
  };
  const label = t => (course(t.courseId)?.code ? course(t.courseId).code + ' · ' : '') + t.title;
  const byId = Object.fromEntries(data.tasks.map(t => [t.id, t]));
  const events = [];
  if (o.writeStudyBlocks) {
    plan.days.slice(0, 7).forEach(day => day.blocks.forEach(b => {
      const t = byId[b.taskId];
      (b.times || []).forEach((tm, i) => events.push({
        key: `study|${t.id}|${day.date}|${i}`,
        subject: `📚 ${label(t)}`,
        start: `${day.date}T${tm.start}`, end: `${day.date}T${tm.end}`,
        body: `Study session planned by Second Brain.\nDue: ${new Date(t.due).toLocaleString()}\n\n${t.notes || ''}`,
        busyStatus: 2, reminder: 10, ...cat(t),
      }));
    }));
  }
  if (o.writeDeadlines) {
    const now = new Date();
    data.tasks.filter(t => !t.done && t.due && !t.canvasUid && new Date(t.due) > now).forEach(t => {
      const due = new Date(t.due);
      events.push({
        key: `due|${t.id}`,
        subject: `📌 Due: ${label(t)}`,
        start: Planner.localIso(new Date(due - 30 * 60000)), end: Planner.localIso(due),
        body: t.notes || '', busyStatus: 0, reminder: 1440, ...cat(t),
      });
    });
  }
  return events;
}

let outlookRunning = false;
async function syncOutlook() {
  const data = loadData();
  const o = data.settings.outlook;
  if (!o.enabled || process.platform !== 'win32' || outlookRunning) return;
  outlookRunning = true;
  const status = { ...(loadSync().outlook || {}), lastAttempt: new Date().toISOString() };
  try {
    if (o.planAroundEvents) {
      const r = await runBridge(['-Action', 'read', '-Days', '21']);
      const events = Array.isArray(r.events) ? r.events : r.events ? [r.events] : [];
      saveSync({ busy: events, courseCategories: detectCourseCategories(data, events) });
      Object.assign(status, { lastRead: new Date().toISOString(), busyEvents: events.length, calendarItems: r.total });
    }
    const fresh = loadData();
    const plan = Planner.buildPlan(fresh, { days: 7, busy: busyTimes(fresh) });
    const file = path.join(ROOT, 'data', 'outlook-push.json');
    fs.writeFileSync(file, JSON.stringify(outlookEvents(fresh, plan)));
    const w = await runBridge(['-Action', 'write', '-InFile', file, '-CalendarName', o.calendarName || 'Second Brain']);
    Object.assign(status, { lastWrite: new Date().toISOString(), added: w.added, updated: w.updated, deleted: w.deleted, error: null });
    console.log(`[outlook] busy events: ${status.busyEvents ?? '-'}; calendar +${w.added} ~${w.updated} -${w.deleted}`);
  } catch (e) {
    status.error = e.message;
    console.error('[outlook]', e.message);
  } finally {
    saveSync({ outlook: status });
    outlookRunning = false;
  }
}
// Re-push to Outlook shortly after the plan changes (debounced).
let outlookTimer;
function scheduleOutlookSync(ms = 60000) { clearTimeout(outlookTimer); outlookTimer = setTimeout(syncOutlook, ms); }

// ---------- http ----------
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' };

function send(res, code, body, type = 'application/json') {
  res.writeHead(code, { 'Content-Type': type + '; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let s = '';
    req.on('data', c => { s += c; if (s.length > 5e6) req.destroy(); });
    req.on('end', () => resolve(s));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname === '/api/data' && req.method === 'GET') {
      const data = loadData(), sync = loadSync();
      return send(res, 200, { data, version: mtime(), busy: busyTimes(data), sync: { canvas: sync.canvas, outlook: sync.outlook, outlookRunning } });
    }
    if (url.pathname === '/api/sync' && req.method === 'POST') {
      await syncCanvas();
      await syncOutlook();
      return send(res, 200, { ok: true });
    }
    if (url.pathname === '/api/data' && req.method === 'PUT') {
      const { data, version } = JSON.parse(await readBody(req));
      if (!data || !Array.isArray(data.tasks)) return send(res, 400, { error: 'bad data' });
      // Someone (e.g. Claude importing a syllabus) changed the file since this tab loaded it.
      if (version !== mtime()) return send(res, 409, { error: 'stale', data: loadData(), version: mtime() });
      writeJson(DATA_FILE, data);
      scheduleOutlookSync();
      return send(res, 200, { version: mtime() });
    }
    if (url.pathname === '/api/test-notification' && req.method === 'POST') {
      notify('Second Brain', 'Notifications are working 🎉');
      return send(res, 200, { ok: true });
    }
    if (url.pathname === '/calendar.ics') {
      res.writeHead(200, { 'Content-Type': 'text/calendar; charset=utf-8', 'Content-Disposition': 'attachment; filename="deadlines.ics"' });
      return res.end(toIcs(loadData()));
    }
    // static files
    const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
    const file = path.normalize(path.join(PUBLIC, rel));
    if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return send(res, 404, 'Not found', 'text/plain');
    res.writeHead(200, { 'Content-Type': (MIME[path.extname(file)] || 'application/octet-stream') + '; charset=utf-8', 'Cache-Control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  } catch (e) {
    console.error(e);
    send(res, 500, { error: e.message });
  }
});

ensureData();
server.listen(PORT, '127.0.0.1', () => {
  console.log(`Second Brain running → http://localhost:${PORT}`);
  checkReminders();
  setInterval(checkReminders, 60 * 1000);
  // Canvas every 30 min, Outlook every 15 min (both no-ops until configured in Settings).
  syncCanvas().finally(() => scheduleOutlookSync(5000));
  setInterval(syncCanvas, 30 * 60 * 1000);
  setInterval(syncOutlook, 15 * 60 * 1000);
});
