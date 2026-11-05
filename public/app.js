import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { SUPABASE_URL, SUPABASE_ANON_KEY, VAPID_PUBLIC_KEY } from './config.js';

const $ = (id) => document.getElementById(id);
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const workoutPlan = [
  { dow: 1, name: 'Full-body strength', type: 'Strength' },
  { dow: 2, name: 'Cardio', type: 'Cardio' },
  { dow: 3, name: 'Upper-body strength', type: 'Strength' },
  { dow: 4, name: 'Walk + mobility', type: 'Recovery' },
  { dow: 5, name: 'Lower-body strength', type: 'Strength' }
];

let user = null;
let records = { workouts: [], tasks: [], water: [] };
let refreshTimer = null;
let monthCursor = new Date();
monthCursor.setDate(1);
monthCursor.setHours(0, 0, 0, 0);

const isoDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const today = () => isoDate(new Date());
const monday = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d;
};
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const timeLabel = (t) => t ? new Date(`2000-01-01T${t}`).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
const clock = (n) => `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;

function msg(id, text) {
  const el = $(id);
  if (el) el.textContent = text;
}

function showAuth() {
  $('appView')?.classList.add('hidden');
  $('authView')?.classList.remove('hidden');
  $('account').textContent = 'Not signed in';
}

async function showApp() {
  $('authView')?.classList.add('hidden');
  $('appView')?.classList.remove('hidden');
  $('account').textContent = user?.email || 'Signed in';
  await loadData();
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(() => loadData(), 60000);
}

function monthStart() {
  return isoDate(new Date(monthCursor.getFullYear(), monthCursor.getMonth(), 1));
}

function monthEnd() {
  return isoDate(new Date(monthCursor.getFullYear(), monthCursor.getMonth() + 1, 0));
}

function weekStart() {
  return isoDate(monday());
}

function weekEnd() {
  const d = monday();
  d.setDate(d.getDate() + 6);
  return isoDate(d);
}

async function init() {
  if (!SUPABASE_URL.startsWith('https://') || SUPABASE_ANON_KEY.includes('PASTE_')) {
    msg('account', 'Add Supabase config');
    $('authView')?.classList.remove('hidden');
    $('authMessage').textContent = 'Set SUPABASE_URL and SUPABASE_ANON_KEY in config.js before using the app.';
    return;
  }

  try {
    const { data: { session } } = await supabase.auth.getSession();
    if (session?.user) {
      user = session.user;
      await showApp();
    } else {
      showAuth();
    }

    supabase.auth.onAuthStateChange(async (_event, session) => {
      user = session?.user ?? null;
      if (user) {
        await showApp();
      } else {
        showAuth();
      }
    });
  } catch (error) {
    console.error(error);
    showAuth();
    $('authMessage').textContent = error?.message || 'Unable to connect to Supabase.';
  }
}

async function loadData() {
  if (!user) return;

  try {
    const [workoutsRes, tasksRes, waterRes] = await Promise.all([
      supabase.from('workouts').select('*').eq('user_id', user.id).gte('workout_date', monthStart()).lte('workout_date', monthEnd()),
      supabase.from('tasks').select('*').eq('user_id', user.id).order('created_at'),
      supabase.from('water_logs').select('*').eq('user_id', user.id).eq('log_date', today())
    ]);

    if (workoutsRes.error) throw workoutsRes.error;
    if (tasksRes.error) throw tasksRes.error;
    if (waterRes.error) throw waterRes.error;

    records = {
      workouts: workoutsRes.data || [],
      tasks: tasksRes.data || [],
      water: waterRes.data || []
    };

    await render();
  } catch (error) {
    console.error(error);
    $('authMessage').textContent = error.message || 'Unable to load your schedule.';
  }
}

async function ensureTemplates() {
  if (!user) return;
  const { data } = await supabase.from('tasks').select('id').eq('user_id', user.id).eq('is_template', true);
  if (data?.length) return;

  const defaults = ['Complete priority 1', 'Complete priority 2', 'Complete priority 3', "Review tomorrow's schedule"];
  await supabase.from('tasks').insert(defaults.map((title, index) => ({
    user_id: user.id,
    title,
    is_template: true,
    task_date: null,
    sort_order: index
  })));
}

function renderMonth() {
  const y = monthCursor.getFullYear();
  const m = monthCursor.getMonth();
  const first = new Date(y, m, 1);
  const offset = (first.getDay() + 6) % 7;
  const days = new Date(y, m + 1, 0).getDate();

  $('monthLabel').textContent = first.toLocaleDateString([], { month: 'long', year: 'numeric' });
  const grid = $('monthGrid');
  grid.innerHTML = '';

  for (let i = 0; i < offset; i += 1) {
    const blank = document.createElement('div');
    grid.append(blank);
  }

  for (let day = 1; day <= days; day += 1) {
    const date = isoDate(new Date(y, m, day));
    const cell = document.createElement('div');
    cell.className = 'monthcell' + (date === today() ? ' today' : '');
    const items = records.tasks.filter((t) => !t.is_template && t.task_date === date);
    cell.innerHTML = `<div class="date">${day}</div>` + items.slice(0, 4).map((t) => `<span class="mtask ${t.is_fixed ? 'mfixed' : ''}" title="${esc(t.title)}">${t.is_fixed ? '◆ ' : ''}${esc(t.title)}</span>`).join('') + (items.length > 4 ? `<small>+${items.length - 4} more</small>` : '');
    grid.append(cell);
  }
}

async function render() {
  await ensureTemplates();
  const { data: tasks } = await supabase.from('tasks').select('*').eq('user_id', user.id).order('sort_order');
  records.tasks = tasks || [];
  renderMonth();

  const wmap = new Map(records.workouts.map((w) => [w.workout_date, w]));
  const done = records.workouts.filter((w) => w.completed && w.workout_date >= weekStart() && w.workout_date <= weekEnd()).length;

  $('week').innerHTML = '';
  for (let i = 0; i < 7; i += 1) {
    const d = monday();
    d.setDate(d.getDate() + i);
    const date = isoDate(d);
    const p = workoutPlan.find((x) => x.dow === d.getDay());
    const entry = wmap.get(date);
    const el = document.createElement('div');
    el.className = 'day' + (date === today() ? ' today' : '') + (!p ? ' rest' : '');
    el.innerHTML = `
      <div class="dow">${d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}</div>
      <b>${p?.name || 'Rest / optional walk'}</b>
      <small>${p ? '45–60 min' : 'Recovery'}</small>
      ${p ? `<label><input type="checkbox" data-complete="${date}" ${entry?.completed ? 'checked' : ''}> Complete</label><input aria-label="Workout start time" type="time" data-start="${date}" value="${entry?.start_time || ''}">` : ''}
    `;
    $('week').append(el);
  }

  $('workoutStat').textContent = `${done}/5`;
  $('workoutProgressText').textContent = `${done} / 5`;
  $('workoutProgress').style.width = `${Math.min((done / 5) * 100, 100)}%`;

  let streak = 0;
  const c = new Date();
  c.setHours(0, 0, 0, 0);
  while (true) {
    const x = wmap.get(isoDate(c));
    if (!x?.completed) break;
    streak += 1;
    c.setDate(c.getDate() - 1);
  }
  $('streakStat').textContent = streak;

  const tasksForToday = records.tasks.filter((x) => x.is_template || x.task_date === today());
  const completed = tasksForToday.filter((x) => x.completed).length;
  const percent = tasksForToday.length ? Math.round((completed / tasksForToday.length) * 100) : 0;
  $('taskStat').textContent = `${percent}%`;
  $('taskCount').textContent = `${completed}/${tasksForToday.length} done`;
  $('taskProgressText').textContent = `${percent}%`;
  $('taskProgress').style.width = `${percent}%`;
  $('tasks').innerHTML = tasksForToday.map((x) => `
    <div class="item ${x.completed ? 'done' : ''}">
      <input type="checkbox" data-task="${x.id}" ${x.completed ? 'checked' : ''}>
      <div class="body">${esc(x.title)}${x.due_time ? `<small>Due ${timeLabel(x.due_time)}</small>` : ''}</div>
      ${!x.is_template ? `<button class="outline" data-remove="${x.id}" style="padding:4px 8px">×</button>` : ''}
    </div>
  `).join('');

  const water = records.water.reduce((n, x) => n + x.glasses, 0);
  $('waterStat').textContent = water;
  $('waterCount').textContent = water;
  $('reviewState').textContent = tasksForToday.some((x) => x.title.toLowerCase().includes('review tomorrow') && x.completed) ? 'Done' : 'Pending';

  const { data: sub } = await supabase.from('push_subscriptions').select('id').eq('user_id', user.id).limit(1);
  $('pushStatus').textContent = sub?.length ? 'Push subscription registered on this device.' : 'Enable reminders on each device to register push notifications.';
}

$('authForm').onsubmit = async (e) => {
  e.preventDefault();
  msg('authMessage', 'Signing in…');
  const { error } = await supabase.auth.signInWithPassword({
    email: $('email').value,
    password: $('password').value
  });
  msg('authMessage', error?.message || 'Signed in.');
};

$('signUp').onclick = async () => {
  msg('authMessage', 'Creating account…');
  const { data, error } = await supabase.auth.signUp({
    email: $('email').value,
    password: $('password').value
  });
  msg('authMessage', error?.message || (data.session ? 'Account created.' : 'Check your email to confirm your account.'));
};

$('signOut').onclick = () => supabase.auth.signOut();

$('monthPrev').onclick = async () => {
  monthCursor.setMonth(monthCursor.getMonth() - 1);
  await loadData();
};

$('monthNext').onclick = async () => {
  monthCursor.setMonth(monthCursor.getMonth() + 1);
  await loadData();
};

$('generateMonth').onclick = async () => {
  if (!user) return;
  const start = new Date(monthCursor.getFullYear(), monthCursor.getMonth(), 1);
  const end = new Date(monthCursor.getFullYear(), monthCursor.getMonth() + 1, 0);

  let pending = records.tasks.filter((t) => !t.is_template && !t.completed && !t.is_fixed && !t.task_date);
  pending = pending.concat(records.tasks.filter((t) => !t.is_template && !t.completed && !t.is_fixed && t.task_date >= monthStart() && t.task_date <= monthEnd()));
  pending = [...new Map(pending.map((t) => [t.id, t])).values()].sort((a, b) => (a.priority || 2) - (b.priority || 2) || (a.due_date || '9999').localeCompare(b.due_date || '9999'));

  const fixed = records.tasks.filter((t) => !t.is_template && t.is_fixed && t.task_date >= monthStart() && t.task_date <= monthEnd());
  const slots = [];

  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    if ([0, 6].includes(d.getDay())) continue;
    const date = isoDate(d);
    let cursor = 9 * 60;
    const dayFixed = fixed.filter((t) => t.task_date === date).sort((a, b) => (a.due_time || '').localeCompare(b.due_time || ''));

    for (const f of dayFixed) {
      const fs = f.due_time ? Number(f.due_time.slice(0, 2)) * 60 + Number(f.due_time.slice(3, 5)) : cursor;
      if (fs > cursor) slots.push({ date, start: cursor, end: fs });
      cursor = Math.max(cursor, fs + (f.duration_minutes || 60));
    }

    if (cursor < 17 * 60) slots.push({ date, start: cursor, end: 17 * 60 });
  }

  const updates = [];
  const unplaced = [];

  for (const t of pending) {
    const dur = Math.max(15, Number(t.duration_minutes) || 60);
    const idx = slots.findIndex((s) => s.end - s.start >= dur);
    if (idx < 0) {
      unplaced.push(t.title);
      continue;
    }

    const s = slots[idx];
    updates.push({ id: t.id, task_date: s.date, due_time: clock(s.start), user_id: user.id });
    s.start += dur;
    if (s.start >= s.end) slots.splice(idx, 1);
  }

  for (const u of updates) {
    const { error } = await supabase.from('tasks').update({ task_date: u.task_date, due_time: u.due_time }).eq('id', u.id).eq('user_id', user.id);
    if (error) {
      $('monthStatus').textContent = 'Could not save schedule: ' + error.message;
      return;
    }
  }

  $('monthStatus').textContent = `Scheduled ${updates.length} task(s) across weekdays${unplaced.length ? `; ${unplaced.length} task(s) need more time: ${unplaced.join(', ')}` : '. Fixed appointments were preserved.'}`;
  await loadData();
};

document.addEventListener('change', async (e) => {
  if (e.target.dataset.complete) {
    const date = e.target.dataset.complete;
    const existing = records.workouts.find((x) => x.workout_date === date);
    await supabase.from('workouts').upsert({
      id: existing?.id,
      user_id: user.id,
      workout_date: date,
      workout_type: workoutPlan.find((x) => x.dow === new Date(date + 'T12:00:00').getDay())?.name || 'Workout',
      completed: e.target.checked,
      start_time: existing?.start_time || null
    }, { onConflict: 'user_id,workout_date' });
    await loadData();
  }

  if (e.target.dataset.start) {
    const date = e.target.dataset.start;
    const time = e.target.value;
    const existing = records.workouts.find((x) => x.workout_date === date);
    await supabase.from('workouts').upsert({
      id: existing?.id,
      user_id: user.id,
      workout_date: date,
      workout_type: workoutPlan.find((x) => x.dow === new Date(date + 'T12:00:00').getDay())?.name || 'Workout',
      completed: existing?.completed || false,
      start_time: time || null,
      remind_at: time ? new Date(new Date(`${date}T${time}:00`).getTime() - 15 * 60 * 1000).toISOString() : null,
      reminder_sent_at: null,
      reminder_claimed_at: null
    }, { onConflict: 'user_id,workout_date' });
    await loadData();
  }

  if (e.target.dataset.task) {
    await supabase.from('tasks').update({ completed: e.target.checked }).eq('id', e.target.dataset.task).eq('user_id', user.id);
    await loadData();
  }
});

document.addEventListener('click', async (e) => {
  if (e.target.dataset.remove) {
    await supabase.from('tasks').delete().eq('id', e.target.dataset.remove).eq('user_id', user.id);
    await loadData();
  }
});

$('addTask').onsubmit = async (e) => {
  e.preventDefault();
  const title = $('taskText').value.trim();
  if (!title) return;

  await supabase.from('tasks').insert({
    user_id: user.id,
    title,
    task_date: $('taskDate').value || null,
    due_date: $('taskDeadline').value || null,
    due_time: $('taskTime').value || null,
    duration_minutes: Number($('taskDuration').value) || 60,
    priority: Number($('taskPriority').value) || 2,
    is_fixed: $('taskFixed').value === 'true',
    is_template: false,
    completed: false
  });

  e.target.reset();
  await loadData();
};

$('logWater').onclick = async () => {
  await supabase.from('water_logs').insert({ user_id: user.id, log_date: today(), glasses: 1 });
  await loadData();
};

$('planner').onsubmit = (e) => {
  e.preventDefault();
  const [a, b] = [$('from').value, $('until').value].map((t) => {
    const [h, m] = t.split(':').map(Number);
    return h * 60 + m;
  });

  const out = $('planResult');
  out.classList.remove('hidden');
  if (b <= a) {
    out.textContent = 'Please choose an end time after the start time.';
    return;
  }

  const tasks = records.tasks.filter((t) => !t.completed);
  const todayWorkout = workoutPlan.find((x) => x.dow === new Date().getDay());
  const parts = [];
  let cursor = a;

  if (todayWorkout && b - a >= 60) {
    parts.push(`Workout · ${clock(cursor)}–${clock(cursor + 60)}`);
    cursor += 70;
  }

  for (const t of tasks.slice(0, 3)) {
    if (cursor + 30 > b) break;
    parts.push(`${t.title} · ${clock(cursor)}–${clock(cursor + 30)}`);
    cursor += 35;
  }

  out.innerHTML = `<b>Suggested plan</b><br>${parts.map(esc).join('<br>')}<br><span class="muted">Energy: ${esc($('energy').value)}. Keep buffer time for breaks.</span>`;
};

const b64 = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

$('enablePush').onclick = async () => {
  try {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) throw Error('This browser does not support web push.');
    if (!VAPID_PUBLIC_KEY || VAPID_PUBLIC_KEY.startsWith('PASTE_')) throw Error('Add your VAPID public key in config.js and deploy the push function first.');

    const permission = await Notification.requestPermission();
    if (permission !== 'granted') throw Error('Notification permission was not granted.');

    const reg = await navigator.serviceWorker.register('/sw.js');
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: b64(VAPID_PUBLIC_KEY)
    });

    const json = sub.toJSON();
    const { error } = await supabase.from('push_subscriptions').upsert({
      user_id: user.id,
      endpoint: json.endpoint,
      p256dh: json.keys.p256dh,
      auth: json.keys.auth
    }, { onConflict: 'endpoint' });

    if (error) throw error;
    msg('pushStatus', 'Push enabled on this device. The server dispatcher must also be deployed for scheduled reminders.');
  } catch (err) {
    alert(err.message);
  }
};

$('export').onclick = async () => {
  const tables = ['workouts', 'tasks', 'water_logs'];
  const dump = {};
  for (const table of tables) {
    const { data, error } = await supabase.from(table).select('*').eq('user_id', user.id);
    if (error) {
      alert(error.message);
      return;
    }
    dump[table] = data;
  }

  const blob = new Blob([JSON.stringify(dump, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'dayframe-backup.json';
  a.click();
  URL.revokeObjectURL(a.href);
};

$('import').onclick = () => $('backupFile').click();
$('backupFile').onchange = async (e) => {
  const file = e.target.files[0];
  if (!file) return;

  try {
    const json = JSON.parse(await file.text());
    for (const table of ['workouts', 'tasks', 'water_logs']) {
      if (!json[table]?.length) continue;
      const rows = json[table].map(({ id, created_at, ...rest }) => ({ ...rest, user_id: user.id }));
      const { error } = await supabase.from(table).upsert(rows);
      if (error) throw error;
    }
    await loadData();
    alert('Backup imported.');
  } catch (err) {
    alert('Import failed: ' + err.message);
  }
};

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(console.error);
}

init();
