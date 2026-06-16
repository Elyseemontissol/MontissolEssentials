const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseISODate(s) {
  if (!DATE_RE.test(s)) throw new Error(`Invalid date: ${s}`);
  const d = new Date(s + 'T00:00:00Z');
  if (isNaN(d.getTime())) throw new Error(`Invalid date: ${s}`);
  return d;
}

export function countWeekdays(startDate, endDate) {
  const start = parseISODate(startDate);
  const end = parseISODate(endDate);
  if (end < start) throw new Error('End date must be on or after start date.');
  let count = 0;
  for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    const day = d.getUTCDay(); // 0 = Sun, 6 = Sat
    if (day !== 0 && day !== 6) count++;
  }
  return count;
}
