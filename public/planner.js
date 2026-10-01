// Scheduling engine: turns tasks + available time into a day-by-day study plan
// with actual time slots (fitted around busy events, e.g. from Outlook).
// Shared by the browser (window.Planner) and the server (require) so reminders,
// the Outlook sync and the UI always agree on the plan.
(function (root) {
  const DAY = 86400000;

  // How many days before the due date we're willing to start working on something.
  // Widened automatically for any task that wouldn't otherwise fit.
  const START_WINDOW = { exam: 10, quiz: 4, assignment: 10, project: 21, reading: 5, other: 7 };
  const DEFAULT_HOURS = { exam: 6, quiz: 2, assignment: 4, project: 10, reading: 1, other: 2 };
  const TYPE_RULES = [
    [/\b(exam|midterm)\b/i, 'exam'],
    [/\bquiz(zes)?\b/i, 'quiz'],
    [/\b(project|presentation)\b/i, 'project'],
    [/\bfinal\b/i, 'exam'],
    [/\b(hw|homework|assignment|problem set|pset|ps\d|lab|essay|paper|report|due|submit|write-?up|reflection|response|exercise|discussion|replies)\b/i, 'assignment'],
    [/\b(read|reading|chapter|ch\.)\b/i, 'reading'],
  ];
  function guessType(text) {
    for (const [re, ty] of TYPE_RULES) if (re.test(text)) return ty;
    return 'other';
  }

  const pad = n => String(n).padStart(2, '0');
  function ymd(d) { const x = new Date(d); return x.getFullYear() + '-' + pad(x.getMonth() + 1) + '-' + pad(x.getDate()); }
  function localIso(d) { const x = new Date(d); return ymd(x) + 'T' + pad(x.getHours()) + ':' + pad(x.getMinutes()); }
  function startOfDay(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
  function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
  function toMin(hhmm) { const [h, m] = String(hhmm || '0:0').split(':').map(Number); return (h || 0) * 60 + (m || 0); }
  function hm(mins) { return pad(Math.floor(mins / 60)) + ':' + pad(mins % 60); }
  function remaining(t) {
    const est = t.estHours == null || t.estHours === '' ? DEFAULT_HOURS[t.type] || 2 : Number(t.estHours);
    return Math.max(0, est - (Number(t.progressHours) || 0));
  }
  function roundQ(h) { return Math.round(h * 4) / 4; }

  // Free time on `day` inside the study window, minus busy events (+ buffer). Returns [[startMin, endMin], ...].
  function freeSlots(day, now, s, busy) {
    const ws = toMin((s.studyWindow || {}).start || '09:00');
    const we = toMin((s.studyWindow || {}).end || '23:00');
    let start = ws;
    if (ymd(day) === ymd(now)) start = Math.max(ws, Math.ceil((now.getHours() * 60 + now.getMinutes()) / 15) * 15);
    let slots = start < we ? [[start, we]] : [];
    const buf = s.bufferMinutes == null ? 15 : Number(s.bufferMinutes);
    const d0 = day.getTime(), d1 = addDays(day, 1).getTime();
    for (const b of busy || []) {
      const bs = new Date(b.start).getTime(), be = new Date(b.end).getTime();
      if (be <= d0 || bs >= d1) continue;
      const a = (bs - d0) / 60000 - buf, z = (be - d0) / 60000 + buf;
      slots = slots.flatMap(([x, y]) => (z <= x || a >= y) ? [[x, y]] : [[x, Math.min(y, a)], [Math.max(x, z), y]].filter(([p, q]) => q > p));
    }
    const min = Number(s.minSlotMinutes) || 30;
    return slots.filter(([x, y]) => y - x >= min);
  }

  // Lay the day's blocks into its free slots: the earliest gap that fits the whole
  // session, otherwise split it across gaps.
  function place(blocks, slots) {
    const free = slots.map(([x, y]) => [x, y]);
    for (const b of blocks) {
      let need = Math.round(b.hours * 60);
      b.times = [];
      const whole = free.find(([x, y]) => y - x >= need);
      for (const s of whole ? [whole] : free) {
        if (need <= 0) break;
        const take = Math.min(need, s[1] - s[0]);
        if (take <= 0) continue;
        b.times.push({ start: hm(s[0]), end: hm(s[0] + take) });
        s[0] += take; need -= take;
      }
      b.times.sort((p, q) => p.start.localeCompare(q.start));
    }
  }

  function schedule(data, now, horizon, extraWindow, busy) {
    const s = data.settings || {};
    const weekdayHours = s.weekdayHours || [2, 3, 3, 3, 3, 1, 2];
    const maxBlock = Number(s.maxBlockHours) || 2;
    const today = startOfDay(now);
    const todayKey = ymd(today);
    const loggedToday = (data.log || []).filter(l => l.date === todayKey).reduce((a, l) => a + (Number(l.hours) || 0), 0);

    const work = (data.tasks || [])
      .filter(t => !t.done && t.due && new Date(t.due) > now && remaining(t) > 0.01)
      .map(t => ({ t, left: remaining(t), due: new Date(t.due) }));

    const days = [];
    for (let i = 0; i < horizon; i++) {
      const day = addDays(today, i);
      const slots = freeSlots(day, now, s, busy);
      const freeHours = slots.reduce((a, [x, y]) => a + (y - x), 0) / 60;
      let cap = Number(weekdayHours[day.getDay()]) || 0;
      if (i === 0) cap = Math.max(0, cap - loggedToday);
      cap = Math.min(cap, freeHours);
      const blocks = [];
      const cands = work
        .filter(x => {
          if (x.left <= 0.01) return false;
          // Only work on the due day itself if it's due after noon.
          if (x.due.getTime() - day.getTime() <= 12 * 3600000) return false;
          const win = (START_WINDOW[x.t.type] || 7) + (extraWindow[x.t.id] || 0);
          return (x.due - day) / DAY <= win;
        })
        .sort((a, b) => a.due - b.due); // earliest deadline first
      for (const x of cands) {
        if (cap < 0.25) break;
        // Tasks that didn't fit last pass are allowed to take the whole day.
        const amt = roundQ(Math.min(x.left, extraWindow[x.t.id] ? cap : maxBlock, cap));
        if (amt < 0.25) continue;
        blocks.push({ taskId: x.t.id, hours: amt });
        x.left -= amt;
        cap -= amt;
      }
      place(blocks, slots);
      days.push({ date: ymd(day), blocks, used: blocks.reduce((a, b) => a + b.hours, 0), freeHours: roundQ(freeHours) });
    }
    const atRisk = work.filter(x => x.left > 0.01 && (x.due - today) / DAY <= horizon)
      .map(x => ({ taskId: x.t.id, hoursShort: roundQ(x.left) }));
    return { days, atRisk };
  }

  function buildPlan(data, opts) {
    opts = opts || {};
    const now = opts.now || new Date();
    const horizon = opts.days || 28;
    const extra = {};
    let plan = schedule(data, now, horizon, extra, opts.busy);
    // If something can't fit in its normal window, let it start earlier and retry.
    for (let pass = 0; pass < 4 && plan.atRisk.length; pass++) {
      plan.atRisk.forEach(r => { extra[r.taskId] = (extra[r.taskId] || 0) + 7; });
      plan = schedule(data, now, horizon, extra, opts.busy);
    }
    plan.overdue = (data.tasks || []).filter(t => !t.done && t.due && new Date(t.due) <= now).map(t => t.id);
    return plan;
  }

  const api = { buildPlan, ymd, localIso, startOfDay, addDays, remaining, guessType, DEFAULT_HOURS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Planner = api;
})(this);
