# Dayframe — deployable personal scheduler

Dayframe is an installable, responsive web app with Supabase account authentication and cloud-synced workout/task/progress data. It does not use Google Calendar.

## What is included
- Email/password account creation and sign-in
- Per-user database with Row Level Security
- Weekly five-day workout plan, completion, start times and progress
- Daily top-three priorities, custom tasks, hydration logs and evening review
- Monthly work calendar with month navigation and automatic task scheduling
- Configurable day, night, or custom work hours, including selectable workdays and days off
- Task duration, priority, fixed appointment protection, and optional work dates
- Pending and upcoming task highlights with completion controls in the calendar
- Automatic rollover and schedule reflow for unfinished tasks
- Basic smart schedule suggestions based on available hours
- PWA manifest and service worker for receiving web push
- JSON backup export/import

## 1. Create Supabase project
1. Create a project at https://supabase.com.
2. Open SQL Editor and run `supabase/schema.sql`.
	For an existing Dayframe project, run the updated schema again before deploying; its `add column if not exists` statements add new fields safely.
3. In Project Settings → API, copy the Project URL and anon/publishable key.
4. For Netlify, add `SUPABASE_URL` and `SUPABASE_ANON_KEY` under Site configuration → Environment variables. The included build script generates `public/config.js` automatically. Set `VAPID_PUBLIC_KEY` only if you have configured push.
5. In Authentication → URL Configuration, add your eventual deployment URL to Site URL and Redirect URLs.

The anon/publishable key is intended for browser use. Never put a Supabase service-role key in `config.js` or any frontend file.

## 2. Deploy the frontend
This folder is a static site. Deploy it to Netlify, Vercel, Cloudflare Pages, or any HTTPS static host:
- Build command: `node scripts/write-config.mjs` (already set in `netlify.toml`)
- Publish directory: `public` (already set in `netlify.toml`)
- Add the Netlify environment variables `SUPABASE_URL` and `SUPABASE_ANON_KEY`; never commit `public/config.js`.

For local testing, serve `public/` over localhost (for example `npx serve public`). Service workers and push require HTTPS in production (localhost is allowed for development).

## Tests
Run `npm test` to verify the day/night shift intervals, days off, recovery guidance, and task-slot collision handling. Netlify runs this suite before generating the public Supabase config.

## 3. Push notification configuration
The PWA can receive push messages. The UI subscription button registers the device subscription in Supabase. Actual scheduled delivery still requires a trusted server-side dispatcher:
- Generate a VAPID public/private key pair.
- Put the public key in `VAPID_PUBLIC_KEY` in `config.js`.
- Store the private key only as a server secret, never in frontend code.
- Deploy a scheduled server/edge function that selects workouts where `remind_at <= now()` and `reminder_sent_at is null`, sends Web Push to each user's subscriptions, then marks `reminder_sent_at`.
- Run that dispatcher every minute using your host's cron/scheduler. It must use server credentials and validate its caller.

This starter intentionally does not pretend that a browser timer is a reliable background scheduler. A service worker cannot wake itself at an arbitrary future time; real 15-minute advance alerts need the server-side dispatcher above. Until that is deployed, do not rely on reminders as guaranteed.

## 4. Install on devices
Open the HTTPS deployment on each device. On supported browsers choose “Install app” / “Add to Home Screen”, sign into the same account, and enable notifications on each device. Data syncs through Supabase; push subscriptions are device-specific.

## 5. Security and operations checklist
- Enable email confirmation and configure SMTP before public launch.
- Add your production domain to Supabase Auth redirect URLs.
- Keep service-role and VAPID private keys in server environment secrets only.
- Use HTTPS.
- Test account isolation with two separate accounts.
- Configure backups and review your provider's retention/region settings.
- Scheduled reminders need a deployed dispatcher and a cron schedule; frontend subscription alone does not send them.

## Current limitations
The planner is a deterministic time-slot suggestion tool, not an LLM integration. It does not read external calendars. It schedules against the availability window you enter. There is no Google Calendar dependency.

## Monthly scheduling update
The monthly planner distributes unscheduled or movable incomplete tasks within the work hours and workdays saved for the account. Day, night, and custom shifts are supported, including shifts that cross midnight. Tasks are ordered by priority and deadline; fixed appointments are preserved. When a task is completed, remaining movable tasks are rescheduled from the current time. Tasks that do not fit remain unscheduled and are reported.

For existing Supabase projects, run the updated `supabase/schema.sql` before deploying. It adds recovery settings, monthly budgets, and budget entries with row-level security.

## Pending task handling
Calendar tasks are highlighted as overdue, due today, coming soon, or completed. Unfinished movable tasks with a past work date are automatically shifted to the next available slot within the saved schedule. Fixed appointments are not shifted, deadlines are preserved, and all calendar tasks can be marked complete or reopened directly from their calendar entry.

Select the plus button on a calendar date to create a task for that date. The budget planner stores a monthly spending limit and dated income/expense entries. Workout times follow the saved work shift and recovery buffer; changing the schedule updates unfinished workouts for the current week. The recovery label is an in-app visual reminder, not a push notification.

## AI assistant setup
The in-app assistant proposes task creations and work-schedule changes, then waits for the user to apply or dismiss them. It runs through the authenticated Netlify function at `/.netlify/functions/assistant`; the model key is never sent to the browser. Add `AI_API_KEY` to Netlify environment variables before deploying. Optionally set `AI_ENDPOINT` to an OpenAI-compatible chat-completions endpoint and `AI_MODEL` to a model available from that provider. Keep all provider keys in Netlify secrets, never in `public/config.js`.

The plain Python static server does not run Netlify functions, so the assistant requires a deployed Netlify site or the Netlify CLI local function runtime. The assistant endpoint verifies the Supabase session and validates each proposed action; changes are written only after the user selects **Apply suggestions**.
