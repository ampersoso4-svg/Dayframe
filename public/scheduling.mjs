export function isoDate(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function dateAfter(date, days) {
  const result = new Date(`${date}T12:00:00`);
  result.setDate(result.getDate() + days);
  return isoDate(result);
}

export function minutesAt(time) {
  return Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
}

export function clock(minutes) {
  return `${String(Math.floor(minutes / 60) % 24).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

export function dayOfWeek(date) {
  return new Date(`${date}T12:00:00`).getDay();
}

function timeLabel(time) {
  return new Date(`2000-01-01T${time}`).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function workingIntervals(schedule, date) {
  const start = minutesAt(schedule.start_time);
  const end = minutesAt(schedule.end_time);
  const workingDays = new Set((schedule.working_days || []).map(Number));

  if (start < end) return workingDays.has(dayOfWeek(date)) ? [[start, end]] : [];

  const intervals = [];
  if (workingDays.has(dayOfWeek(date))) intervals.push([start, 1440]);
  if (end > 0 && workingDays.has(dayOfWeek(dateAfter(date, -1)))) intervals.push([0, end]);
  return intervals.sort((a, b) => a[0] - b[0]);
}

export function workoutGuidance(schedule, date, now = new Date()) {
  const shiftStart = minutesAt(schedule.start_time);
  const shiftEnd = minutesAt(schedule.end_time);
  const rest = Number(schedule.recovery_minutes) || 0;
  const days = new Set((schedule.working_days || []).map(Number));
  const weekday = dayOfWeek(date);
  const previousWorkday = days.has(dayOfWeek(dateAfter(date, -1)));
  let restUntil = null;
  let workoutTime = '09:00';

  if (shiftStart < shiftEnd && days.has(weekday)) {
    restUntil = shiftEnd + rest;
  } else if (shiftStart > shiftEnd && previousWorkday) {
    restUntil = shiftEnd + rest;
  } else if (shiftStart > shiftEnd && days.has(weekday)) {
    return { workoutTime: '', restLabel: `WORK DUTY · next workout after ${timeLabel(clock(shiftEnd + rest))} tomorrow` };
  }

  if (restUntil !== null) {
    if (restUntil >= 1440) return { workoutTime: '', restLabel: `REST · continue tomorrow ${clock(restUntil - 1440)}` };
    const nowMinutes = now.getHours() * 60 + now.getMinutes();
    if (date === isoDate(now) && nowMinutes > restUntil) {
      workoutTime = clock(Math.ceil(nowMinutes / 15) * 15);
      return { workoutTime, restLabel: `Recovery complete · workout from ${timeLabel(workoutTime)}` };
    }
    workoutTime = clock(restUntil);
    return { workoutTime, restLabel: `REST · workout after ${timeLabel(workoutTime)}` };
  }

  if (date === isoDate(now)) {
    const nowMinutes = now.getHours() * 60 + now.getMinutes();
    if (nowMinutes > minutesAt(workoutTime)) workoutTime = clock(Math.ceil(nowMinutes / 15) * 15);
  }
  return { workoutTime, restLabel: '' };
}

export function findAvailableSlot(schedule, date, duration, occupied = [], earliest = 0) {
  for (const [windowStart, windowEnd] of workingIntervals(schedule, date)) {
    const firstStart = Math.max(windowStart, earliest);
    for (let start = firstStart; start + duration <= windowEnd; start += 15) {
      if (!occupied.some(([otherStart, otherEnd]) => start < otherEnd && start + duration > otherStart)) {
        return { date, start, end: start + duration };
      }
    }
  }
  return null;
}