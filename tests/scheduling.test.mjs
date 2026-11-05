import test from 'node:test';
import assert from 'node:assert/strict';
import { findAvailableSlot, workingIntervals, workoutGuidance } from '../public/scheduling.mjs';

const daySchedule = {
  shift_mode: 'day',
  start_time: '09:00',
  end_time: '17:00',
  recovery_minutes: 60,
  working_days: [1, 2, 3, 4, 5]
};

const nightSchedule = {
  shift_mode: 'night',
  start_time: '21:00',
  end_time: '05:00',
  recovery_minutes: 60,
  working_days: [1, 2, 3, 4, 5]
};

test('day shift exposes only selected weekdays', () => {
  assert.deepEqual(workingIntervals(daySchedule, '2026-11-02'), [[540, 1020]]);
  assert.deepEqual(workingIntervals(daySchedule, '2026-11-07'), []);
});

test('night shift carries the previous workday through midnight', () => {
  assert.deepEqual(workingIntervals(nightSchedule, '2026-11-03'), [[0, 300], [1260, 1440]]);
});

test('a day off still includes an overnight shift carried from the previous workday', () => {
  const schedule = { ...nightSchedule, working_days: [1, 2, 3, 4] };
  assert.deepEqual(workingIntervals(schedule, '2026-11-06'), [[0, 300]]);
});

test('day shift workout guidance includes the configured recovery buffer', () => {
  const result = workoutGuidance(daySchedule, '2026-11-04', new Date('2026-11-04T12:00:00'));
  assert.equal(result.workoutTime, '18:00');
  assert.match(result.restLabel, /REST/);
});

test('night shift workout is suggested after duty and recovery, not before duty', () => {
  const afterShift = workoutGuidance(nightSchedule, '2026-11-03', new Date('2026-11-03T02:00:00'));
  assert.equal(afterShift.workoutTime, '06:00');
  assert.match(afterShift.restLabel, /REST/);

  const beforeShift = workoutGuidance(nightSchedule, '2026-11-02', new Date('2026-11-02T12:00:00'));
  assert.equal(beforeShift.workoutTime, '');
  assert.match(beforeShift.restLabel, /WORK DUTY/);
  assert.doesNotMatch(beforeShift.restLabel, /Pre-shift/);
});

test('recovery that ends after midnight does not suggest a same-day workout', () => {
  const schedule = { ...daySchedule, end_time: '23:00', recovery_minutes: 120 };
  const result = workoutGuidance(schedule, '2026-11-04', new Date('2026-11-04T12:00:00'));
  assert.equal(result.workoutTime, '');
  assert.match(result.restLabel, /continue tomorrow/);
});

test('slot finder skips occupied intervals and respects the shift boundary', () => {
  const slot = findAvailableSlot(daySchedule, '2026-11-03', 60, [[540, 600]]);
  assert.deepEqual(slot, { date: '2026-11-03', start: 600, end: 660 });
  assert.equal(findAvailableSlot(daySchedule, '2026-11-07', 60), null);
});