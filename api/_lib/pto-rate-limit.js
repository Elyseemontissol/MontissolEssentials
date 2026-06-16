// Sliding-window rate limiter using a Redis sorted set.
// Each attempt is added with its timestamp as the score; we prune
// entries older than `windowSeconds` and count what remains.

export async function checkAndRecordAttempt(redis, key, max, windowSeconds, nowMs = Date.now()) {
  const windowMs = windowSeconds * 1000;
  const cutoff = nowMs - windowMs;
  await redis.zremrangebyscore(key, 0, cutoff);
  const current = await redis.zrange(key, 0, -1);
  if (current.length >= max) {
    return { allowed: false, remaining: 0, retryAfterSec: windowSeconds };
  }
  await redis.zadd(key, { score: nowMs, member: `${nowMs}-${Math.random()}` });
  return { allowed: true, remaining: max - current.length - 1, retryAfterSec: 0 };
}

export async function clearAttempts(redis, key) {
  await redis.del(key);
}
