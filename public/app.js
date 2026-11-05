import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { SUPABASE_URL, SUPABASE_ANON_KEY, VAPID_PUBLIC_KEY } from './config.js';
import { clock as scheduleClock, dateAfter as scheduleDateAfter, dayOfWeek as scheduleDayOfWeek, findAvailableSlot, minutesAt as scheduleMinutesAt, workingIntervals as getWorkingIntervals, workoutGuidance as getWorkoutGuidance } from './scheduling.mjs';

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
let records = { workouts: [], tasks: [], water: [], budgetEntries: [], monthlyBudget: null };
let assistantHistory = [];
let assistantPendingActions = [];
const defaultWorkSchedule = { shift_mode: 'day', start_time: '09:00:00', end_time: '17:00:00', recovery_minutes: 60, working_days: [1, 2, 3, 4, 5] };
let workSchedule = { ...defaultWorkSchedule, working_days: [...defaultWorkSchedule.working_days] };
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
const clock = scheduleClock;
const plannedWorkout = (date) => workoutPlan.find((x) => x.dow === new Date(`${date}T12:00:00`).getDay());
let rolloverInProgress = false;

function dateAfter(date, days) {
  return scheduleDateAfter(date, days);
}

function minutesAt(time) {
  return scheduleMinutesAt(time);
}

function dayOfWeek(date) {
  return scheduleDayOfWeek(date);
}

function workingIntervals(date) {
  return getWorkingIntervals(workSchedule, date);
}

function workoutGuidance(date) {
  return getWorkoutGuidance(workSchedule, date);
}

function taskStatus(task) {
  if (task.completed) return 'done';
  const currentDate = today();
  if ((task.task_date && task.task_date < currentDate) || (task.due_date && task.due_date < currentDate)) return 'overdue';
  if (task.task_date === currentDate || task.due_date === currentDate) return 'today';

  const upcomingDates = [task.task_date, task.due_date].filter((date) => date && date > currentDate).sort();
  if (!upcomingDates.length) return 'unscheduled';
  return upcomingDates[0] <= dateAfter(currentDate, 7) ? 'soon' : 'upcoming';
}

function collapseDashboardDetails() {
  const collapsibleTitles = new Set(['Progress tracking', 'Smart scheduling', 'Daily essentials', 'Reminder status', 'Data portability']);
  document.querySelectorAll('#appView > .layout .panel').forEach((panel) => {
    const heading = panel.querySelector(':scope > h2');
    if (!heading || !collapsibleTitles.has(heading.textContent.trim())) return;

    const children = [...panel.childNodes];
    const details = document.createElement('details');
    details.className = 'panel-fold';
    const summary = document.createElement('summary');
    summary.append(heading);
    const content = document.createElement('div');
    content.className = 'fold-content';
    children.forEach((child) => {
      if (child !== heading) content.append(child);
    });
    details.append(summary, content);
    panel.classList.add('fold-panel');
    panel.replaceChildren(details);
  });
}

function mountBudgetPlanner() {
  if ($('budgetPanel')) return;
  const panel = document.createElement('section');
  panel.id = 'budgetPanel';
  panel.className = 'panel';
  panel.style.marginBottom = '14px';
  panel.innerHTML = `
    <details class="panel-fold" id="budgetDetails" open>
    <summary><span>Monthly budget</span><span id="budgetPeek" class="fold-peek"></span><span id="budgetMonthLabel" class="pill"></span></summary>
    <div class="fold-content">
    <form id="budgetLimitForm" class="budget-limit-form">
      <div class="field"><label for="budgetLimit">Planned spending limit</label><input id="budgetLimit" type="number" min="0" step="0.01" required></div>
      <button type="submit">Save limit</button>
    </form>
    <div class="budget-totals">
      <div><span>Spent</span><strong id="budgetSpent">0.00</strong></div>
      <div><span>Remaining</span><strong id="budgetRemaining">0.00</strong></div>
      <div><span>Income</span><strong id="budgetIncome">0.00</strong></div>
    </div>
    <form id="budgetEntryForm" class="budget-entry-form">
      <div class="fields">
        <div class="field"><label for="budgetTitle">Item</label><input id="budgetTitle" maxlength="120" required placeholder="Rent, groceries, paycheck"></div>
        <div class="field"><label for="budgetType">Type</label><select id="budgetType"><option value="expense">Expense</option><option value="income">Income</option></select></div>
        <div class="field"><label for="budgetCategory">Category</label><select id="budgetCategory"><option>Housing</option><option>Food</option><option>Transport</option><option>Health</option><option>Utilities</option><option>Work</option><option>Fitness</option><option>Other</option></select></div>
        <div class="field"><label for="budgetAmount">Amount</label><input id="budgetAmount" type="number" min="0.01" step="0.01" required></div>
        <div class="field"><label for="budgetDate">Date</label><input id="budgetDate" type="date" required></div>
      </div>
      <button type="submit">Add budget entry</button><span id="budgetMessage" class="status" role="status"></span>
    </form>
    <div id="budgetEntries" class="budget-entries"></div>
    </div></details>`;

  const monthPanel = $('monthGrid').closest('section');
  monthPanel.after(panel);

  $('budgetLimitForm').onsubmit = async (e) => {
    e.preventDefault();
    const { error } = await supabase.from('monthly_budgets').upsert({
      user_id: user.id,
      budget_month: monthStart(),
      spending_limit: Number($('budgetLimit').value) || 0,
      updated_at: new Date().toISOString()
    }, { onConflict: 'user_id,budget_month' });
    if (error) {
      msg('budgetMessage', error.message);
      return;
    }
    msg('budgetMessage', 'Monthly limit saved.');
    await loadData();
  };

  $('budgetEntryForm').onsubmit = async (e) => {
    e.preventDefault();
    const { error } = await supabase.from('budget_entries').insert({
      user_id: user.id,
      entry_date: $('budgetDate').value,
      title: $('budgetTitle').value.trim(),
      category: $('budgetCategory').value,
      entry_type: $('budgetType').value,
      amount: Number($('budgetAmount').value)
    });
    if (error) {
      msg('budgetMessage', error.message);
      return;
    }
    e.target.reset();
    $('budgetDate').value = today();
    msg('budgetMessage', 'Budget entry added.');
    await loadData();
  };

  $('budgetDate').value = monthStart() <= today() && today() <= monthEnd() ? today() : monthStart();
}

function renderBudget() {
  const entries = records.budgetEntries || [];
  const limit = Number(records.monthlyBudget?.spending_limit) || 0;
  const spent = entries.filter((entry) => entry.entry_type === 'expense').reduce((total, entry) => total + Number(entry.amount), 0);
  const income = entries.filter((entry) => entry.entry_type === 'income').reduce((total, entry) => total + Number(entry.amount), 0);
  const amountLabel = (value) => new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);

  $('budgetMonthLabel').textContent = monthCursor.toLocaleDateString([], { month: 'long', year: 'numeric' });
  $('budgetLimit').value = records.monthlyBudget ? limit.toFixed(2) : '';
  $('budgetDate').value = monthStart() <= today() && today() <= monthEnd() ? today() : monthStart();
  $('budgetSpent').textContent = amountLabel(spent);
  $('budgetRemaining').textContent = amountLabel(limit - spent);
  $('budgetRemaining').classList.toggle('over-budget', spent > limit);
  $('budgetIncome').textContent = amountLabel(income);
  $('budgetPeek').textContent = `Remaining ${amountLabel(limit - spent)}`;
  $('budgetEntries').innerHTML = entries.slice().sort((a, b) => b.entry_date.localeCompare(a.entry_date) || b.created_at.localeCompare(a.created_at)).map((entry) => `
    <div class="budget-entry ${entry.entry_type}">
      <div><strong>${esc(entry.title)}</strong><small>${esc(entry.entry_date)} · ${esc(entry.category)}</small></div>
      <b>${entry.entry_type === 'income' ? '+' : '−'}${amountLabel(Number(entry.amount))}</b>
      <button type="button" class="outline" data-delete-budget="${entry.id}" aria-label="Delete ${esc(entry.title)}">×</button>
    </div>`).join('') || '<p class="muted small">No entries for this month yet.</p>';
  if (records.budgetError) msg('budgetMessage', 'Budget tables are not available. Run the latest supabase/schema.sql in your Supabase project.');
}

function renderAssistantMessages() {
  const container = $('assistantMessages');
  container.replaceChildren();
  for (const message of assistantHistory.slice(-10)) {
    const bubble = document.createElement('p');
    bubble.className = `assistant-message ${message.role}`;
    bubble.textContent = message.content;
    container.append(bubble);
  }
  container.scrollTop = container.scrollHeight;
}

function renderAssistantPreview() {
  const container = $('assistantActions');
  container.replaceChildren();
  container.hidden = assistantPendingActions.length === 0;
  $('assistantApply').hidden = assistantPendingActions.length === 0;
  $('assistantDiscard').hidden = assistantPendingActions.length === 0;

  for (const action of assistantPendingActions) {
    const item = document.createElement('div');
    item.className = 'assistant-action';
    if (action.type === 'create_task') {
      const date = action.task_date ? ` on ${action.task_date}` : ' (unscheduled)';
      item.textContent = `Task: ${action.title}${date} · ${action.duration_minutes} min · priority ${action.priority}`;
    } else {
      const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
      const workDays = action.working_days.map((day) => dayNames[day]).join(', ') || 'all days off';
      item.textContent = `Work schedule: ${action.shift_mode} shift, ${action.start_time}–${action.end_time}, ${action.recovery_minutes} min recovery. Workdays: ${workDays}.`;
    }
    container.append(item);
  }
}

function mountAssistant() {
  if ($('assistantPanel')) return;
  const panel = document.createElement('section');
  panel.id = 'assistantPanel';
  panel.className = 'panel assistant-panel';
  panel.innerHTML = `
    <div class="assistant-heading"><div><h2>Dayframe assistant</h2><p class="sub">Describe a task or the work hours you want to set.</p></div><span class="assistant-spark">AI</span></div>
    <div id="assistantMessages" class="assistant-messages" role="log" aria-live="polite"><p class="assistant-message assistant">Hi. Tell me what you need to do, when it’s due, or how your work shift should change.</p></div>
    <form id="assistantForm" class="assistant-form"><label class="visually-hidden" for="assistantPrompt">Message the Dayframe assistant</label><textarea id="assistantPrompt" rows="2" maxlength="2000" required placeholder="For example: Add a 45-minute grocery run tomorrow after 6 pm"></textarea><button id="assistantSend" type="submit">Ask</button></form>
    <p id="assistantStatus" class="status" role="status" aria-live="polite"></p>
    <div id="assistantActions" class="assistant-actions" hidden></div>
    <div class="assistant-controls"><button id="assistantApply" type="button" hidden>Apply suggestions</button><button id="assistantDiscard" class="outline" type="button" hidden>Dismiss</button></div>`;
  document.querySelector('#appView > .top').after(panel);

  $('assistantForm').onsubmit = async (event) => {
    event.preventDefault();
    const prompt = $('assistantPrompt').value.trim();
    if (!prompt || $('assistantSend').disabled) return;

    assistantHistory.push({ role: 'user', content: prompt });
    renderAssistantMessages();
    $('assistantPrompt').value = '';
    $('assistantSend').disabled = true;
    msg('assistantStatus', 'Thinking…');

    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) throw new Error('Sign in to use the assistant.');
      const response = await fetch('/.netlify/functions/assistant', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({
          messages: assistantHistory.slice(-10),
          context: {
            today: today(),
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            workSchedule
          }
        })
      });
      const contentType = response.headers.get('content-type') || '';
      if (!contentType.includes('application/json')) {
        if (response.status === 404) {
          throw new Error('The AI function is not running on this static server. Use your deployed Netlify site or start the app with Netlify Functions.');
        }
        throw new Error(`The AI function returned an unexpected response (HTTP ${response.status}).`);
      }
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'The assistant could not respond.');

      assistantHistory.push({ role: 'assistant', content: result.message });
      assistantPendingActions = result.actions;
      renderAssistantMessages();
      renderAssistantPreview();
      msg('assistantStatus', assistantPendingActions.length ? 'Review these suggestions, then choose whether to apply them.' : 'No changes proposed.');
    } catch (error) {
      assistantHistory.push({ role: 'assistant', content: error.message || 'The assistant could not respond.' });
      renderAssistantMessages();
      msg('assistantStatus', error.message || 'The assistant could not respond.');
    } finally {
      $('assistantSend').disabled = false;
    }
  };

  $('assistantApply').onclick = async () => {
    let applied = 0;
    for (const action of assistantPendingActions) {
      try {
        if (action.type === 'create_task') {
          const { error } = await supabase.from('tasks').insert({
            user_id: user.id,
            title: action.title,
            task_date: action.task_date,
            due_date: action.due_date,
            due_time: action.due_time,
            duration_minutes: action.duration_minutes,
            priority: action.priority,
            is_fixed: action.is_fixed,
            is_template: false,
            completed: false
          });
          if (error) throw error;
        } else {
          const schedule = {
            user_id: user.id,
            shift_mode: action.shift_mode,
            start_time: action.start_time,
            end_time: action.end_time,
            recovery_minutes: action.recovery_minutes,
            working_days: action.working_days,
            updated_at: new Date().toISOString()
          };
          const { error } = await supabase.from('work_schedules').upsert(schedule, { onConflict: 'user_id' });
          if (error) throw error;
          workSchedule = { ...schedule };
          await syncWorkoutSchedule();
          await autoPlanMonth(false);
        }
        applied += 1;
      } catch (error) {
        assistantPendingActions = assistantPendingActions.slice(applied);
        renderAssistantPreview();
        msg('assistantStatus', `${applied} suggestion(s) applied. Could not apply the rest: ${error.message}`);
        await loadData();
        return;
      }
    }

    assistantPendingActions = [];
    assistantHistory.push({ role: 'assistant', content: 'Done. I applied the suggestions you approved.' });
    renderAssistantMessages();
    renderAssistantPreview();
    msg('assistantStatus', `${applied} suggestion(s) applied to your account.`);
    await loadData();
  };

  $('assistantDiscard').onclick = () => {
    assistantPendingActions = [];
    renderAssistantPreview();
    msg('assistantStatus', 'Suggestions dismissed; no changes were made.');
  };
}

async function scheduleTasks(pending, { startDate, endDate, startAtNow = true } = {}) {
  const busy = new Map();
  const pendingIds = new Set(pending.map((task) => task.id));
  const durationFor = (task) => Math.max(15, Number(task.duration_minutes) || 60);
  const reserve = (date, start, end) => {
    if (!busy.has(date)) busy.set(date, []);
    busy.get(date).push([start, end]);
  };
  const findSlot = (date, duration, earliest = 0) => {
    const occupied = busy.get(date) || [];
    return findAvailableSlot(workSchedule, date, duration, occupied, earliest);
  };

  for (const task of records.tasks) {
    if (pendingIds.has(task.id) || task.is_template || task.completed || !task.task_date || task.task_date < startDate || task.task_date > endDate) continue;
    const duration = durationFor(task);
    if (task.due_time) {
      const start = minutesAt(task.due_time);
      const end = start + duration;
      reserve(task.task_date, start, Math.min(end, 1440));
      if (end > 1440) reserve(dateAfter(task.task_date, 1), 0, end - 1440);
    } else if (task.is_fixed) {
      const slot = findSlot(task.task_date, duration);
      if (slot) reserve(slot.date, slot.start, slot.end);
    }
  }

  const currentTime = new Date();
  const nowMinutes = Math.ceil((currentTime.getHours() * 60 + currentTime.getMinutes()) / 15) * 15;
  let moved = 0;
  let failed = 0;

  for (const task of pending) {
    let slot = null;
    for (let offset = 0; offset < 90 && !slot; offset += 1) {
      const date = dateAfter(startDate, offset);
      if (date > endDate) break;
      const earliest = startAtNow && date === today() ? nowMinutes : 0;
      slot = findSlot(date, durationFor(task), earliest);
    }

    if (!slot) {
      failed += 1;
      continue;
    }

    const { error } = await supabase.from('tasks').update({ task_date: slot.date, due_time: clock(slot.start) }).eq('id', task.id).eq('user_id', user.id);
    if (error) {
      failed += 1;
      console.error('Unable to schedule task:', error);
      continue;
    }

    task.task_date = slot.date;
    task.due_time = clock(slot.start);
    reserve(slot.date, slot.start, slot.end);
    moved += 1;
  }

  return { moved, failed };
}

async function rollOverOverdueTasks() {
  if (!user || rolloverInProgress) return { moved: 0, failed: 0 };
  const pending = records.tasks
    .filter((task) => !task.is_template && !task.completed && !task.is_fixed && task.task_date && task.task_date < today())
    .sort((a, b) => (a.priority || 2) - (b.priority || 2) || (a.due_date || '9999').localeCompare(b.due_date || '9999'));
  if (!pending.length) return { moved: 0, failed: 0 };

  rolloverInProgress = true;
  try {
    return await scheduleTasks(pending, { startDate: today(), endDate: dateAfter(today(), 89) });
  } finally {
    rolloverInProgress = false;
  }
}

async function rescheduleRemainingTasks() {
  const pending = records.tasks.filter((task) => !task.is_template && !task.completed && !task.is_fixed && task.task_date === today());
  if (!pending.length) return { moved: 0, failed: 0 };
  return scheduleTasks(sortedTasks(pending), { startDate: today(), endDate: dateAfter(today(), 89) });
}

async function syncWorkoutSchedule() {
  const { data: existingWorkouts, error: loadError } = await supabase.from('workouts').select('*').eq('user_id', user.id).gte('workout_date', weekStart()).lte('workout_date', weekEnd());
  if (loadError) throw loadError;

  for (let offset = 0; offset < 7; offset += 1) {
    const date = dateAfter(weekStart(), offset);
    const plan = plannedWorkout(date);
    if (date < today() || !plan) continue;
    const existing = (existingWorkouts || []).find((workout) => workout.workout_date === date);
    if (existing?.completed || existing?.is_skipped) continue;
    const guidance = workoutGuidance(date);
    if (!guidance.workoutTime && !existing) continue;
    const startTime = guidance.workoutTime || null;
    const { error } = await supabase.from('workouts').upsert({
      id: existing?.id,
      user_id: user.id,
      workout_date: date,
      workout_type: existing?.workout_type || plan.name,
      completed: false,
      start_time: startTime,
      remind_at: startTime ? new Date(new Date(`${date}T${startTime}:00`).getTime() - 15 * 60 * 1000).toISOString() : null,
      reminder_sent_at: null,
      reminder_claimed_at: null,
      is_skipped: false
    }, { onConflict: 'user_id,workout_date' });
    if (error) throw error;
  }
}

function showEditor(kind, item, date) {
  $('editKind').value = kind;
  $('editId').value = item?.id || '';
  $('editOriginalDate').value = date || item?.task_date || item?.workout_date || '';
  $('editHeading').textContent = kind === 'task' ? (item ? 'Edit task' : 'Add task') : 'Edit workout';
  $('editTaskFields').classList.toggle('hidden', kind !== 'task');
  $('editWorkoutFields').classList.toggle('hidden', kind !== 'workout');
  $('editTaskTitle').required = kind === 'task';
  $('editWorkoutTitle').required = kind === 'workout';
  $('editWorkoutDate').required = kind === 'workout';
  msg('editMessage', '');

  if (kind === 'task') {
    $('editTaskTitle').value = item?.title || '';
    $('editTaskDate').value = item?.task_date || date || '';
    $('editTaskDeadline').value = item?.due_date || '';
    $('editTaskTime').value = item?.due_time || '';
    $('editTaskDuration').value = item?.duration_minutes || 60;
    $('editTaskPriority').value = item?.priority || 2;
    $('editTaskFixed').value = String(Boolean(item?.is_fixed));
    $('editTaskCompleted').checked = Boolean(item?.completed);
  } else {
    const workoutDate = date || item?.workout_date || today();
    const defaultWorkout = plannedWorkout(workoutDate);
    $('editWorkoutTitle').value = item?.is_skipped ? (defaultWorkout?.name || '') : (item?.workout_type || defaultWorkout?.name || 'Workout');
    $('editWorkoutDate').value = workoutDate;
    $('editWorkoutTime').value = item?.start_time || '';
    $('editWorkoutCompleted').checked = Boolean(item?.completed);
  }

  $('editDialog').showModal();
}

async function saveWorkout() {
  const originalDate = $('editOriginalDate').value;
  const workoutDate = $('editWorkoutDate').value;
  const title = $('editWorkoutTitle').value.trim();
  const startTime = $('editWorkoutTime').value || null;
  const completed = $('editWorkoutCompleted').checked;
  if (!title || !workoutDate) throw new Error('Workout and date are required.');

  const original = records.workouts.find((x) => x.id === $('editId').value);
  const destination = records.workouts.find((x) => x.workout_date === workoutDate && x.id !== original?.id);
  if (destination) throw new Error('There is already a workout on that date. Choose another date.');

  const { error } = await supabase.from('workouts').upsert({
    id: workoutDate === originalDate ? original?.id : undefined,
    user_id: user.id,
    workout_date: workoutDate,
    workout_type: title,
    completed,
    start_time: startTime,
    remind_at: startTime ? new Date(new Date(`${workoutDate}T${startTime}:00`).getTime() - 15 * 60 * 1000).toISOString() : null,
    reminder_sent_at: null,
    reminder_claimed_at: null,
    is_skipped: false
  }, { onConflict: 'user_id,workout_date' });
  if (error) throw error;

  if (workoutDate !== originalDate) {
    const oldEntry = original || records.workouts.find((x) => x.workout_date === originalDate);
    if (plannedWorkout(originalDate)) {
      const { error: skipError } = await supabase.from('workouts').upsert({
        id: oldEntry?.id,
        user_id: user.id,
        workout_date: originalDate,
        workout_type: oldEntry?.workout_type || plannedWorkout(originalDate).name,
        completed: false,
        start_time: null,
        remind_at: null,
        reminder_sent_at: null,
        reminder_claimed_at: null,
        is_skipped: true
      }, { onConflict: 'user_id,workout_date' });
      if (skipError) throw skipError;
    } else if (oldEntry) {
      const { error: deleteError } = await supabase.from('workouts').delete().eq('id', oldEntry.id).eq('user_id', user.id);
      if (deleteError) throw deleteError;
    }
  }
}

function msg(id, text) {
  const el = $(id);
  if (el) el.textContent = text;
}

function showAuth() {
  $('appView')?.classList.add('hidden');
  $('authView')?.classList.remove('hidden');
  $('account').textContent = 'Not signed in';
}

function renderWorkSchedule() {
  const scheduleFields = document.querySelector('#workScheduleForm .fields');
  if (!$('recoveryMinutes')) {
    const recoveryField = document.createElement('div');
    recoveryField.className = 'field';
    recoveryField.innerHTML = '<label for="recoveryMinutes">Rest after work</label><select id="recoveryMinutes"><option value="0">No extra rest</option><option value="30">30 minutes</option><option value="60">1 hour</option><option value="90">1.5 hours</option><option value="120">2 hours</option><option value="180">3 hours</option><option value="240">4 hours</option></select>';
    scheduleFields.append(recoveryField);
  }
  const daysOffFieldset = document.querySelector('#workScheduleForm fieldset');
  if (!daysOffFieldset.dataset.dayOffPicker) {
    const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    daysOffFieldset.innerHTML = `<legend>Choose your days off</legend><div class="weekday-options">${weekdays.map((day, index) => `<label><input type="checkbox" name="dayOff" value="${index}"> ${day}</label>`).join('')}</div>`;
    daysOffFieldset.dataset.dayOffPicker = 'true';
  }
  $('shiftMode').value = workSchedule.shift_mode;
  $('workStart').value = workSchedule.start_time.slice(0, 5);
  $('workEnd').value = workSchedule.end_time.slice(0, 5);
  $('recoveryMinutes').value = String(workSchedule.recovery_minutes ?? 60);
  document.querySelectorAll('input[name="dayOff"]').forEach((input) => {
    input.checked = !(workSchedule.working_days || []).map(Number).includes(Number(input.value));
  });

  const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const daysOff = weekdays.filter((_day, index) => !(workSchedule.working_days || []).map(Number).includes(index));
  const mode = workSchedule.shift_mode === 'custom' ? 'Custom hours' : `${workSchedule.shift_mode[0].toUpperCase()}${workSchedule.shift_mode.slice(1)} shift`;
  $('workScheduleStatus').textContent = `${mode} · ${timeLabel(workSchedule.start_time)}–${timeLabel(workSchedule.end_time)} · Rest ${workSchedule.recovery_minutes || 0}m · Days off: ${daysOff.length ? daysOff.join(', ') : 'none'}`;
  $('from').value = workSchedule.start_time.slice(0, 5);
  $('until').value = workSchedule.end_time.slice(0, 5);
}

async function showApp() {
  $('authView')?.classList.add('hidden');
  $('appView')?.classList.remove('hidden');
  $('account').textContent = user?.email || 'Signed in';
  renderMonth();
  renderBudget();
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

    const [scheduleRes, budgetEntriesRes, monthlyBudgetRes] = await Promise.all([
      supabase.from('work_schedules').select('*').eq('user_id', user.id).maybeSingle(),
      supabase.from('budget_entries').select('*').eq('user_id', user.id).gte('entry_date', monthStart()).lte('entry_date', monthEnd()),
      supabase.from('monthly_budgets').select('*').eq('user_id', user.id).eq('budget_month', monthStart()).maybeSingle()
    ]);

    const savedSchedule = scheduleRes.error ? defaultWorkSchedule : (scheduleRes.data || defaultWorkSchedule);
    workSchedule = {
      shift_mode: savedSchedule.shift_mode || 'day',
      start_time: String(savedSchedule.start_time || defaultWorkSchedule.start_time).slice(0, 5),
      end_time: String(savedSchedule.end_time || defaultWorkSchedule.end_time).slice(0, 5),
      recovery_minutes: Number(savedSchedule.recovery_minutes ?? defaultWorkSchedule.recovery_minutes),
      working_days: (savedSchedule.working_days || defaultWorkSchedule.working_days).map(Number)
    };

    records = {
      workouts: workoutsRes.data || [],
      tasks: tasksRes.data || [],
      water: waterRes.data || [],
      budgetEntries: budgetEntriesRes.error ? [] : (budgetEntriesRes.data || []),
      monthlyBudget: monthlyBudgetRes.error ? null : monthlyBudgetRes.data || null,
      budgetError: Boolean(budgetEntriesRes.error || monthlyBudgetRes.error),
      scheduleError: scheduleRes.error || null
    };

    renderWorkSchedule();
    if (scheduleRes.error) msg('workScheduleStatus', 'Work schedule settings unavailable. Run the latest supabase/schema.sql.');
    const rollover = await rollOverOverdueTasks();
    await render();
    if (rollover.moved || rollover.failed) {
      $('monthStatus').textContent = `${rollover.moved} unfinished task(s) moved to the next available weekday${rollover.failed ? `; ${rollover.failed} could not be moved` : ''}.`;
    }
  } catch (error) {
    console.error(error);
    $('authMessage').textContent = error.message || 'Unable to load your schedule.';
    $('monthStatus').textContent = `Calendar data could not be loaded: ${error.message || 'check your Supabase setup.'}`;
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
  const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const start = minutesAt(workSchedule.start_time);
  const end = minutesAt(workSchedule.end_time);
  const overnight = start > end;
  const mode = workSchedule.shift_mode === 'custom' ? 'Custom shift' : `${workSchedule.shift_mode[0].toUpperCase()}${workSchedule.shift_mode.slice(1)} shift`;

  for (let i = 0; i < offset; i += 1) {
    const blank = document.createElement('div');
    grid.append(blank);
  }

  for (let day = 1; day <= days; day += 1) {
    const date = isoDate(new Date(y, m, day));
    const activeIntervals = workingIntervals(date);
    const startsShift = (workSchedule.working_days || []).map(Number).includes(dayOfWeek(date));
    const carriesOvernight = overnight && end > 0 && (workSchedule.working_days || []).map(Number).includes(dayOfWeek(dateAfter(date, -1)));
    const cell = document.createElement('div');
    cell.className = 'monthcell' + (date === today() ? ' today' : '') + (!activeIntervals.length ? ' day-off' : ' working-day');
    let hoursLabel = 'Day off';
    if (startsShift) hoursLabel = `${mode} · ${timeLabel(workSchedule.start_time)}–${timeLabel(workSchedule.end_time)}${overnight ? ' +1 day' : ''}`;
    else if (carriesOvernight) hoursLabel = `Night shift carryover · until ${timeLabel(workSchedule.end_time)}`;
    else if (activeIntervals.length) hoursLabel = `${mode} · ${timeLabel(workSchedule.start_time)}–${timeLabel(workSchedule.end_time)}`;
    const items = records.tasks.filter((t) => !t.is_template && t.task_date === date);
    const statusOrder = ['overdue', 'today', 'soon', 'upcoming', 'unscheduled', 'done'];
    items.sort((a, b) => statusOrder.indexOf(taskStatus(a)) - statusOrder.indexOf(taskStatus(b)));
    const taskRows = items.map((task) => {
      const status = taskStatus(task);
      const label = { overdue: 'Overdue', today: 'Today', soon: 'Soon', upcoming: 'Upcoming', unscheduled: 'Unscheduled', done: 'Done' }[status];
      return `<div class="calendar-task task-${status} ${task.is_fixed ? 'mfixed' : ''}"><input type="checkbox" data-task="${task.id}" ${task.completed ? 'checked' : ''} aria-label="Mark ${esc(task.title)} ${task.completed ? 'not done' : 'done'}"><button type="button" class="mtask-open" data-edit-task="${task.id}" title="Edit ${esc(task.title)}">${task.is_fixed ? '◆ ' : ''}${esc(task.title)}</button><span class="task-badge">${label}</span><button type="button" class="outline mtask-delete" data-remove="${task.id}" aria-label="Delete ${esc(task.title)}" title="Delete task">×</button></div>`;
    }).join('');
    cell.innerHTML = `<div class="date">${day} <span class="calendar-day-name">${weekdays[dayOfWeek(date)]}</span><button type="button" class="calendar-add" data-add-task-date="${date}" aria-label="Add task on ${date}" title="Add task">+</button></div><div class="calendar-hours">${esc(hoursLabel)}</div>${taskRows}`;
    grid.append(cell);
  }

  const openTasks = records.tasks.filter((task) => !task.is_template && !task.completed);
  const counts = openTasks.reduce((result, task) => {
    const status = taskStatus(task);
    result[status] = (result[status] || 0) + 1;
    return result;
  }, {});
  $('taskSummary').textContent = `${openTasks.length} open · ${counts.overdue || 0} overdue · ${counts.today || 0} due today · ${counts.soon || 0} coming soon · ${counts.unscheduled || 0} unscheduled`;
}

async function render() {
  await ensureTemplates();
  const { data: tasks } = await supabase.from('tasks').select('*').eq('user_id', user.id).order('sort_order');
  records.tasks = tasks || [];
  renderMonth();
  renderBudget();

  const wmap = new Map(records.workouts.map((w) => [w.workout_date, w]));
  const done = records.workouts.filter((w) => w.completed && !w.is_skipped && w.workout_date >= weekStart() && w.workout_date <= weekEnd()).length;

  $('week').innerHTML = '';
  for (let i = 0; i < 7; i += 1) {
    const d = monday();
    d.setDate(d.getDate() + i);
    const date = isoDate(d);
    const p = workoutPlan.find((x) => x.dow === d.getDay());
    const entry = wmap.get(date);
    const workoutName = entry?.is_skipped ? '' : (entry?.workout_type || p?.name || '');
    const guidance = workoutGuidance(date);
    const workoutTime = entry?.start_time || guidance.workoutTime;
    const el = document.createElement('div');
    el.className = 'day' + (date === today() ? ' today' : '') + (!p ? ' rest' : '');
    el.innerHTML = `
      <div class="dow">${d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}</div>
      <b>${esc(workoutName || 'Rest / optional walk')}</b>
      <small>${workoutName ? (p ? '45–60 min' : 'Scheduled workout') : 'Recovery'}</small>
      ${guidance.restLabel ? `<span class="recovery-pill">${esc(guidance.restLabel)}</span>` : ''}
      ${workoutName ? `<label><input type="checkbox" data-complete="${date}" ${entry?.completed ? 'checked' : ''}> Complete</label><input aria-label="Workout start time" type="time" data-start="${date}" value="${workoutTime || ''}">` : ''}
      <div class="workout-actions"><button type="button" class="outline" data-edit-workout="${date}">Edit</button>${workoutName ? `<button type="button" class="outline" data-delete-workout="${date}">Delete</button>` : ''}</div>
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

  const tasksForToday = records.tasks.filter((x) => x.is_template || !x.task_date || x.task_date === today());
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
      ${!x.is_template ? `<div class="item-actions"><button type="button" class="outline" data-edit-task="${x.id}">Edit</button><button type="button" class="outline" data-remove="${x.id}" aria-label="Delete ${esc(x.title)}">Delete</button></div>` : ''}
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

function sortedTasks(tasks) {
  return tasks.sort((a, b) => (a.priority || 2) - (b.priority || 2) || (a.due_date || '9999').localeCompare(b.due_date || '9999'));
}

async function autoPlanMonth(reload = true) {
  if (!user) return { moved: 0, failed: 0 };
  let pending = records.tasks.filter((t) => !t.is_template && !t.completed && !t.is_fixed && !t.task_date);
  pending = pending.concat(records.tasks.filter((t) => !t.is_template && !t.completed && !t.is_fixed && t.task_date >= monthStart() && t.task_date <= monthEnd()));
  pending = sortedTasks([...new Map(pending.map((t) => [t.id, t])).values()]);

  const startDate = monthStart() < today() ? today() : monthStart();
  const result = await scheduleTasks(pending, { startDate, endDate: monthEnd() });
  $('monthStatus').textContent = `Scheduled ${result.moved} task(s) within your work hours${result.failed ? `; ${result.failed} task(s) need more available time` : ''}. Fixed appointments were preserved.`;
  if (reload) await loadData();
  return result;
}

$('shiftMode').onchange = () => {
  if ($('shiftMode').value === 'day') {
    $('workStart').value = '09:00';
    $('workEnd').value = '17:00';
  } else if ($('shiftMode').value === 'night') {
    $('workStart').value = '21:00';
    $('workEnd').value = '05:00';
  }
};

$('workScheduleForm').onsubmit = async (e) => {
  e.preventDefault();
  const startTime = $('workStart').value;
  const endTime = $('workEnd').value;
  if (!startTime || !endTime || startTime === endTime) {
    msg('workScheduleStatus', 'Choose different start and end times.');
    return;
  }

  const schedule = {
    user_id: user.id,
    shift_mode: $('shiftMode').value,
    start_time: startTime,
    end_time: endTime,
    recovery_minutes: Number($('recoveryMinutes').value),
    working_days: [...document.querySelectorAll('input[name="dayOff"]:not(:checked)')].map((input) => Number(input.value)),
    updated_at: new Date().toISOString()
  };
  const { error } = await supabase.from('work_schedules').upsert(schedule, { onConflict: 'user_id' });
  if (error) {
    msg('workScheduleStatus', error.message);
    return;
  }

  workSchedule = { ...schedule, start_time: startTime, end_time: endTime };
  renderWorkSchedule();
  msg('workScheduleStatus', 'Saved. Updating your schedule…');
  try {
    await syncWorkoutSchedule();
  } catch (error) {
    msg('workScheduleStatus', `Saved, but workouts could not be updated: ${error.message}`);
  }
  await autoPlanMonth(false);
  await loadData();
};

$('generateMonth').onclick = async () => autoPlanMonth();

document.addEventListener('change', async (e) => {
  if (e.target.dataset.complete) {
    const date = e.target.dataset.complete;
    const existing = records.workouts.find((x) => x.workout_date === date);
    await supabase.from('workouts').upsert({
      id: existing?.id,
      user_id: user.id,
      workout_date: date,
      workout_type: existing?.workout_type || plannedWorkout(date)?.name || 'Workout',
      completed: e.target.checked,
      start_time: existing?.start_time || null,
      is_skipped: false
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
      workout_type: existing?.workout_type || plannedWorkout(date)?.name || 'Workout',
      completed: existing?.completed || false,
      start_time: time || null,
      remind_at: time ? new Date(new Date(`${date}T${time}:00`).getTime() - 15 * 60 * 1000).toISOString() : null,
      reminder_sent_at: null,
      reminder_claimed_at: null,
      is_skipped: false
    }, { onConflict: 'user_id,workout_date' });
    await loadData();
  }

  if (e.target.dataset.task) {
    const { error } = await supabase.from('tasks').update({ completed: e.target.checked }).eq('id', e.target.dataset.task).eq('user_id', user.id);
    if (error) {
      alert(error.message);
      await loadData();
      return;
    }
    await loadData();
    if (e.target.checked) {
      const result = await rescheduleRemainingTasks();
      await loadData();
      if (result.moved || result.failed) {
        $('monthStatus').textContent = `${result.moved} remaining task(s) rescheduled from now${result.failed ? `; ${result.failed} need more work time` : ''}.`;
      }
    }
  }
});

document.addEventListener('click', async (e) => {
  const button = e.target.closest('button');
  if (!button) return;

  if (button.dataset.addTaskDate) {
    showEditor('task', null, button.dataset.addTaskDate);
  }

  if (button.dataset.deleteBudget) {
    if (!confirm('Delete this budget entry?')) return;
    const { error } = await supabase.from('budget_entries').delete().eq('id', button.dataset.deleteBudget).eq('user_id', user.id);
    if (error) {
      alert(error.message);
      return;
    }
    await loadData();
  }

  if (button.dataset.editTask) {
    const task = records.tasks.find((x) => x.id === button.dataset.editTask);
    if (task) showEditor('task', task);
  }

  if (button.dataset.editWorkout) {
    const date = button.dataset.editWorkout;
    showEditor('workout', records.workouts.find((x) => x.workout_date === date), date);
  }

  if (button.dataset.remove) {
    if (!confirm('Delete this task?')) return;
    const { error } = await supabase.from('tasks').delete().eq('id', button.dataset.remove).eq('user_id', user.id);
    if (error) {
      alert(error.message);
      return;
    }
    await loadData();
  }

  if (button.dataset.deleteWorkout) {
    if (!confirm('Remove this workout from the calendar?')) return;
    const date = button.dataset.deleteWorkout;
    const entry = records.workouts.find((x) => x.workout_date === date);
    let result;
    if (plannedWorkout(date)) {
      result = await supabase.from('workouts').upsert({
        id: entry?.id,
        user_id: user.id,
        workout_date: date,
        workout_type: entry?.workout_type || plannedWorkout(date).name,
        completed: false,
        start_time: null,
        remind_at: null,
        reminder_sent_at: null,
        reminder_claimed_at: null,
        is_skipped: true
      }, { onConflict: 'user_id,workout_date' });
    } else if (entry) {
      result = await supabase.from('workouts').delete().eq('id', entry.id).eq('user_id', user.id);
    }
    if (result?.error) {
      alert(result.error.message);
      return;
    }
    await loadData();
  }
});

$('cancelEdit').onclick = () => $('editDialog').close();

$('editForm').onsubmit = async (e) => {
  e.preventDefault();
  try {
    if ($('editKind').value === 'task') {
      const taskChanges = {
        title: $('editTaskTitle').value.trim(),
        task_date: $('editTaskDate').value || null,
        due_date: $('editTaskDeadline').value || null,
        due_time: $('editTaskTime').value || null,
        duration_minutes: Number($('editTaskDuration').value) || 60,
        priority: Number($('editTaskPriority').value) || 2,
        is_fixed: $('editTaskFixed').value === 'true',
        completed: $('editTaskCompleted').checked
      };
      const result = $('editId').value
        ? await supabase.from('tasks').update(taskChanges).eq('id', $('editId').value).eq('user_id', user.id)
        : await supabase.from('tasks').insert({ ...taskChanges, user_id: user.id, is_template: false });
      const { error } = result;
      if (error) throw error;
    } else {
      await saveWorkout();
    }
    $('editDialog').close();
    await loadData();
  } catch (error) {
    msg('editMessage', error.message || 'Unable to save changes.');
  }
};

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
  if (b === a) {
    out.textContent = 'Choose different start and end times.';
    return;
  }
  if (b < a) b += 24 * 60;

  const tasks = records.tasks.filter((t) => !t.completed);
  const todayWorkout = workoutPlan.find((x) => x.dow === new Date().getDay());
  const parts = [];
  let cursor = a;
  const planClock = (time) => `${clock(time)}${time >= 1440 ? ' (next day)' : ''}`;

  if (todayWorkout && b - a >= 60) {
    parts.push(`Workout · ${planClock(cursor)}–${planClock(cursor + 60)}`);
    cursor += 70;
  }

  for (const t of tasks.slice(0, 3)) {
    if (cursor + 30 > b) break;
    parts.push(`${t.title} · ${planClock(cursor)}–${planClock(cursor + 30)}`);
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
  const tables = ['workouts', 'tasks', 'water_logs', 'work_schedules', 'monthly_budgets', 'budget_entries'];
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
    for (const table of ['workouts', 'tasks', 'water_logs', 'work_schedules', 'monthly_budgets', 'budget_entries']) {
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

collapseDashboardDetails();
mountAssistant();
mountBudgetPlanner();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(console.error);
}

init();
