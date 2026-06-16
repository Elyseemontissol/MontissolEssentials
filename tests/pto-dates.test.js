import { test } from 'node:test';
import assert from 'node:assert/strict';
import { countWeekdays } from '../api/_lib/pto-dates.js';

test('same-day weekday returns 1', () => {
  // 2026-06-15 is a Monday
  assert.equal(countWeekdays('2026-06-15', '2026-06-15'), 1);
});

test('same-day weekend returns 0', () => {
  // 2026-06-13 is a Saturday
  assert.equal(countWeekdays('2026-06-13', '2026-06-13'), 0);
});

test('full Mon-Fri returns 5', () => {
  // Mon 2026-06-15 to Fri 2026-06-19
  assert.equal(countWeekdays('2026-06-15', '2026-06-19'), 5);
});

test('Mon to following Mon returns 6 (skips Sat+Sun)', () => {
  // Mon 2026-06-15 to Mon 2026-06-22
  assert.equal(countWeekdays('2026-06-15', '2026-06-22'), 6);
});

test('Sat to Sun returns 0', () => {
  assert.equal(countWeekdays('2026-06-13', '2026-06-14'), 0);
});

test('Fri to Mon returns 2 (Fri + Mon, skip weekend)', () => {
  // Fri 2026-06-19 to Mon 2026-06-22
  assert.equal(countWeekdays('2026-06-19', '2026-06-22'), 2);
});

test('end before start throws', () => {
  assert.throws(() => countWeekdays('2026-06-19', '2026-06-15'));
});

test('invalid date format throws', () => {
  assert.throws(() => countWeekdays('not-a-date', '2026-06-15'));
  assert.throws(() => countWeekdays('2026-06-15', 'bad'));
});
