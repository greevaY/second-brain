# Second Brain — notes for Claude

A local, zero-dependency Node app that tracks a student's assignments, exams, and quizzes for the term, auto-plans study time, and sends desktop reminders (Windows toasts; osascript on macOS; notify-send on Linux).

- `server.js` — HTTP server on http://localhost:4321, JSON storage, reminder loop (every 60s), `/calendar.ics` export, Canvas feed sync (30 min), Outlook sync (15 min + 1 min after any edit), `POST /api/sync`.
- `public/planner.js` — scheduling engine (shared by browser + server). Earliest-deadline-first, capped per task per day, within a start window per task type; widens the window for tasks that don't fit and reports `atRisk`. Places sessions at real times inside `studyWindow`, around Outlook busy events.
- `outlook-bridge.ps1` — classic Outlook COM bridge. `read` = busy events from the default Calendar; `write` = diff-syncs study sessions/deadlines into the "Second Brain" calendar (only items tagged with the `SBKey` user property). Never modifies other calendars.
- `public/app.js` — vanilla JS UI. No build step. Its Import tab has a copyable AI-chatbot prompt (`aiPrompt`) whose JSON reply is parsed by `parseAiJson`, so people without Claude Code can import syllabi. Keep that prompt's rules in sync with the import guidelines below.
- `data/brain.json` — **all user data**. `data/reminder-state.json` — which reminders were sent. `data/sync-status.json` — Canvas/Outlook status + cached Outlook busy times.

## User context
Personal details (school, term dates, breaks, finals, Outlook account) live in **`CLAUDE.local.md`**, which is gitignored. If it doesn't exist, ask the user for: the first day of classes (Week 1), breaks, finals week, and whether they use Canvas/Outlook. Then create it in this shape:

```markdown
## User context (<Term>, <School>)
- Term: Week 1 = week of <Mon date>. <Break> <dates>. Finals week starts <date> (or "dates not published yet": those tasks get `due: null`).
- Outlook (optional): account, which calendar holds classes/work.
```

The app's Settings also store `settings.termStart` / `settings.termNotes` (set from the Import tab). Use them as a fallback.

- Classic Outlook's local cache only syncs while it's running. If the bridge reads 0 events, the user needs to open classic Outlook once and let it sync.

Run: `node server.js` (or double-click `start.bat` on Windows / `start.command` on macOS). Needs Node 18+. No npm install needed.

## Importing syllabi (the main thing the user will ask for)

When the user says "import my syllabi" (or similar):

1. Read every file in `syllabi/` (PDF, docx text, txt, md, images). Skip `README.txt`. Skip files already imported — check `data/brain.json` `courses[].source`.
2. For each syllabus extract: course code + name, and every graded/dated item: assignments, problem sets, labs, essays, projects (and milestones), quizzes, midterms, finals, presentations. Include recurring items expanded into individual dated tasks (e.g. "weekly quiz every Friday" → one task per Friday in the quarter; "HW due each Wednesday weeks 2–9" → one per week). Resolve "Week N" using the term start date in the syllabus, else the one in `CLAUDE.local.md`.
3. Merge into `data/brain.json` (read it fresh first; the app may have changed it). Don't duplicate existing tasks (same course + title + due date).
4. Tell the user what was added per course, and list anything ambiguous (missing times, "TBA" dates, finals-week dates not stated) so they can fix it.

Editing the file while the server runs is fine: the UI detects the change (file mtime) and reloads.

## Data schema (`data/brain.json`)

```jsonc
{
  "settings": {
    "weekdayHours": [2,3,3,3,3,1,2],   // Sun..Sat study hours available
    "maxBlockHours": 2,                // max hours on one task per day
    "reminderLeadHours": [72,24,3],
    "digestTime": "08:30"
  },
  "courses": [
    { "id": "short-random-id", "code": "CS 101", "name": "Intro to CS", "color": "#4f46e5", "source": "syllabi/cs101.pdf" }
    // optional: "outlookCategory": "CS 101", "outlookCategoryColor": 8  (Outlook olCategoryColor; created if missing)
    // Without it, the course's category is learned from Outlook class events whose subject contains the code.
  ],
  "tasks": [
    {
      "id": "short-random-id",
      "courseId": "<course id>",
      "title": "Problem Set 3",
      "type": "assignment",          // assignment | exam | quiz | project | reading | other
      "due": "2026-10-14T23:59",     // LOCAL time, no timezone suffix; null = date TBA (not planned yet)
      // set by the Canvas sync: canvasUid, canvasDue, canvasTitle (don't hand-edit)
      "estHours": 4,                 // hours of work; null = type default
      "progressHours": 0,
      "weight": 5,                   // % of grade, or null
      "done": false,
      "notes": "Chapters 3-4; submit on Gradescope"
    }
  ],
  "log": [ { "date": "2026-10-01", "taskId": "...", "hours": 1.5 } ]
}
```

Guidelines when filling fields:
- `due`: use the stated time; if none, assignments `23:59`, exams/quizzes at class time if known else `09:00`.
- `estHours`: estimate realistically — problem set 3–6, essay 6–12, lab report 3–5, weekly quiz 1–2, midterm 6–10, final 12–20, project scaled by weight. Heavier grade weight → more hours.
- Course colors: pick distinct ones from `#4f46e5 #0891b2 #c2410c #15803d #be185d #7c3aed #b45309 #0f766e`.
- Put useful details (topics covered, submission platform, allowed materials) in `notes`.
