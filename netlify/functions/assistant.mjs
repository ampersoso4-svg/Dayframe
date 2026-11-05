const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
});

const validDate = (value) => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T12:00:00Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
};

const validTime = (value) => {
  if (typeof value !== 'string' || !/^\d{2}:\d{2}$/.test(value)) return false;
  const [hour, minute] = value.split(':').map(Number);
  return hour < 24 && minute < 60;
};

export function validateMessages(messages) {
  if (!Array.isArray(messages) || messages.length < 1 || messages.length > 12) {
    throw new Error('Send between 1 and 12 messages.');
  }

  return messages.map((message) => {
    if (!message || !['user', 'assistant'].includes(message.role) || typeof message.content !== 'string') {
      throw new Error('Messages must contain only user or assistant text.');
    }
    const content = message.content.trim();
    if (!content || content.length > 2000) throw new Error('Each message must be 1–2000 characters.');
    return { role: message.role, content };
  });
}

export function validateAssistantResult(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.message !== 'string') {
    throw new Error('The assistant returned an invalid response.');
  }
  if (!Array.isArray(value.actions) || value.actions.length > 5) throw new Error('The assistant returned too many actions.');

  let scheduleCount = 0;
  const actions = value.actions.map((action) => {
    if (!action || typeof action !== 'object') throw new Error('Invalid suggested action.');

    if (action.type === 'create_task') {
      const title = typeof action.title === 'string' ? action.title.trim() : '';
      const duration = Number(action.duration_minutes ?? 60);
      const priority = Number(action.priority ?? 2);
      const taskDate = action.task_date ?? null;
      const dueDate = action.due_date ?? null;
      const dueTime = action.due_time ?? null;
      if (!title || title.length > 160) throw new Error('A task title must be 1–160 characters.');
      if (!Number.isInteger(duration) || duration < 15 || duration > 480) throw new Error('Task duration must be 15–480 minutes.');
      if (![1, 2, 3].includes(priority)) throw new Error('Task priority must be high, medium, or low.');
      if (taskDate !== null && !validDate(taskDate)) throw new Error('Task date is invalid.');
      if (dueDate !== null && !validDate(dueDate)) throw new Error('Task deadline is invalid.');
      if (dueTime !== null && !validTime(dueTime)) throw new Error('Task time is invalid.');
      if (action.is_fixed !== undefined && typeof action.is_fixed !== 'boolean') throw new Error('Fixed status must be true or false.');

      return {
        type: 'create_task',
        title,
        task_date: taskDate,
        due_date: dueDate,
        due_time: dueTime,
        duration_minutes: duration,
        priority,
        is_fixed: action.is_fixed === true
      };
    }

    if (action.type === 'set_work_schedule') {
      scheduleCount += 1;
      const days = action.working_days;
      const recovery = Number(action.recovery_minutes ?? 60);
      if (!['day', 'night', 'custom'].includes(action.shift_mode)) throw new Error('Shift must be day, night, or custom.');
      if (!validTime(action.start_time) || !validTime(action.end_time) || action.start_time === action.end_time) {
        throw new Error('Work hours must have different valid start and end times.');
      }
      if (!Number.isInteger(recovery) || recovery < 0 || recovery > 240) throw new Error('Recovery must be 0–240 minutes.');
      if (!Array.isArray(days) || days.some((day) => !Number.isInteger(day) || day < 0 || day > 6)) {
        throw new Error('Working days must use weekday numbers 0–6.');
      }
      if (new Set(days).size !== days.length) throw new Error('Working days cannot contain duplicates.');
      return {
        type: 'set_work_schedule',
        shift_mode: action.shift_mode,
        start_time: action.start_time,
        end_time: action.end_time,
        recovery_minutes: recovery,
        working_days: days
      };
    }

    throw new Error('The assistant suggested an unsupported action.');
  });
  if (scheduleCount > 1) throw new Error('Only one work schedule can be changed at a time.');
  return actions;
}

function safeContext(context = {}) {
  const schedule = context.workSchedule || {};
  return {
    today: validDate(context.today) ? context.today : new Date().toISOString().slice(0, 10),
    timezone: typeof context.timezone === 'string' ? context.timezone.slice(0, 64) : 'unknown',
    workSchedule: {
      shift_mode: ['day', 'night', 'custom'].includes(schedule.shift_mode) ? schedule.shift_mode : 'day',
      start_time: validTime(schedule.start_time) ? schedule.start_time : '09:00',
      end_time: validTime(schedule.end_time) ? schedule.end_time : '17:00',
      recovery_minutes: Number.isInteger(schedule.recovery_minutes) ? Math.min(240, Math.max(0, schedule.recovery_minutes)) : 60,
      working_days: Array.isArray(schedule.working_days) ? schedule.working_days.filter((day) => Number.isInteger(day) && day >= 0 && day <= 6).slice(0, 7) : [1, 2, 3, 4, 5]
    }
  };
}

export default async function handler(request) {
  if (request.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);

  const supabaseUrl = process.env.SUPABASE_URL?.replace(/\/+$/, '');
  const supabaseKey = process.env.SUPABASE_ANON_KEY;
  const aiKey = process.env.AI_API_KEY;
  if (!supabaseUrl || !supabaseKey) return json({ error: 'Supabase function settings are not configured.' }, 503);
  if (!aiKey) return json({ error: 'AI is not configured yet. Add AI_API_KEY in Netlify environment variables.' }, 503);

  const token = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
  if (!token) return json({ error: 'Sign in to use the assistant.' }, 401);

  try {
    const userResponse = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: { apikey: supabaseKey, Authorization: `Bearer ${token}` }
    });
    if (!userResponse.ok) return json({ error: 'Your session expired. Sign in again.' }, 401);

    const body = await request.json();
    const messages = validateMessages(body.messages);
    const context = safeContext(body.context);
    const systemPrompt = `You are Dayframe, a concise personal task and work-schedule assistant. Use the user's local date, time zone, and current shift profile below. Ask a short follow-up question if essential information is missing. Do not invent dates, deadlines, or work hours. Return ONLY a JSON object with {"message": string, "actions": array}. Actions may only be create_task with title, task_date (YYYY-MM-DD or null), due_date (YYYY-MM-DD or null), due_time (HH:MM or null), duration_minutes (15-480), priority (1 high, 2 medium, 3 low), is_fixed (boolean); or set_work_schedule with shift_mode (day/night/custom), start_time, end_time (HH:MM; end earlier than start means overnight), recovery_minutes (0-240), working_days (weekday numbers Sunday=0 through Saturday=6). Use actions: [] when clarifying or chatting. If changing a schedule, include every schedule field. Current context: ${JSON.stringify(context)}`;
    const endpoint = process.env.AI_ENDPOINT || 'https://api.openai.com/v1/chat/completions';
    const aiResponse = await fetch(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${aiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: process.env.AI_MODEL || 'gpt-4o-mini',
        messages: [{ role: 'system', content: systemPrompt }, ...messages],
        response_format: { type: 'json_object' },
        temperature: 0.2
      })
    });
    if (!aiResponse.ok) {
      console.error('AI provider returned status', aiResponse.status);
      let reason = 'The AI provider could not complete the request.';
      if ([401, 403].includes(aiResponse.status)) reason = 'The AI provider rejected the API key.';
      else if (aiResponse.status === 404) reason = 'The AI model or endpoint was not found.';
      else if (aiResponse.status === 429) reason = 'The AI provider rate limit or usage quota was reached.';
      return json({ error: `${reason} (HTTP ${aiResponse.status}). Check AI_API_KEY, AI_ENDPOINT, AI_MODEL, and API billing.` }, 502);
    }

    const completion = await aiResponse.json();
    const content = completion.choices?.[0]?.message?.content;
    if (typeof content !== 'string') return json({ error: 'The AI provider returned an empty response.' }, 502);

    try {
      const result = JSON.parse(content);
      const actions = validateAssistantResult(result);
      return json({ message: result.message.trim().slice(0, 2000), actions });
    } catch (error) {
      console.error('Invalid assistant response:', error.message);
      return json({ error: 'The assistant returned an invalid suggestion. Please try rephrasing.' }, 502);
    }
  } catch (error) {
    console.error('Assistant request failed:', error);
    return json({ error: 'The assistant request failed. Please try again.' }, 500);
  }
}