# 🧠 Second Brain

A study planner for students. Add your syllabi and it tracks every assignment, quiz and exam for the term, plans **when** to work on each one, and reminds you before things are due.

It runs on your own computer, and your data never leaves it. It has no account and nothing to install besides Node.js.

## Setup (5 minutes)

1. **Install Node.js** (version 18 or newer): download the LTS version from https://nodejs.org.
2. **Get this folder**: click *Code → Download ZIP* on GitHub and unzip it, or `git clone` it.
3. **Start it**:
   - **Windows:** double-click `start.bat`.
   - **macOS:** double-click `start.command`. The first time, you may need to right-click it → *Open*. If it won't run, open Terminal in this folder and run `chmod +x start.command` once.
   - **Linux / any OS:** open a terminal in this folder and run `node server.js`.
4. Open http://localhost:4321 in your browser. (The launchers do this for you.)

Keep the terminal window open. The server sends reminders even when the browser is closed.

## Add your syllabi

Go to the **Import syllabus** tab. You have three options:

1. **Any AI chatbot (recommended):** enter your first day of classes, click **Copy prompt**, and paste the prompt into ChatGPT, Claude, Gemini or Copilot. Attach your syllabus PDFs to the same message. Paste the chatbot's answer back into the app, check the list, and click **Add**. Recurring items like "quiz every Friday" are expanded into one task per date. Anything the chatbot was unsure about is shown as a warning.
2. **Claude Code:** drop the PDFs in the `syllabi/` folder and say *"import my syllabi"*.
3. **No AI:** paste the schedule section of a syllabus. Lines that contain a date become tasks you can review. This is less accurate.

You can also add or edit anything by hand with **+ Add**. If a date isn't announced yet, leave it empty (TBA) and fill it in later.

## How planning works

- In **Settings**, set how many hours you can study on each day of the week.
- Each task has an estimated number of hours. The planner spreads that work over the days before the deadline, starting with whatever is due soonest. By default it puts at most 2 hours per task on any one day, so exam studying is spread out instead of crammed.
- Click **Did it ✓** on a study block to log the time. The plan re-plans itself around it.

## Optional connections (Settings → Connections)

- **Canvas** (if your school uses it): paste your Canvas calendar feed URL (Canvas → Calendar → *Calendar Feed*). New or changed due dates come in every 30 minutes and are matched to your syllabus tasks.
- **Outlook** (Windows + the classic Outlook desktop app only): reads your Outlook calendar (work, classes) and only schedules study time in the free gaps. It puts study sessions in a separate **Second Brain** calendar and never changes your own events. Classic Outlook needs to have finished syncing your calendar at least once.

## Reminders

- A desktop notification fires 72h, 24h and 3h before each deadline. You can change these times in Settings. Notifications work on Windows and macOS, and on Linux if `notify-send` is installed.
- A morning notification at 8:30 lists today's plan.
- **Settings → Download deadlines (.ics)** exports your deadlines so you can import them into Google or Apple Calendar and get reminders on your phone.

### Start automatically when you log in (optional)

- **Windows:** press `Win+R`, type `shell:startup`, and put a shortcut to `start.bat` in that folder.
- **macOS:** System Settings → General → Login Items → add `start.command`.

## Your data

Everything is stored in the `data/` folder, mostly `data/brain.json`. To back it up, copy that folder. To start fresh (for example, for a new term), stop the server and delete `data/`. Both `data/` and your syllabus files are excluded from git, so it's safe to share or fork this repo.

To use a different port: `PORT=5000 node server.js` (macOS/Linux) or `set PORT=5000 && node server.js` (Windows). The launchers always open port 4321.
