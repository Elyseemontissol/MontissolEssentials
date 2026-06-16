import { Redis } from '@upstash/redis';

const _client = Redis.fromEnv();

// Narrow interface — only the operations the PTO feature uses.
export const redis = {
  get:      (...args) => _client.get(...args),
  set:      (...args) => _client.set(...args),
  getdel:   (...args) => _client.getdel(...args),
  del:      (...args) => _client.del(...args),
  sadd:     (...args) => _client.sadd(...args),
  srem:     (...args) => _client.srem(...args),
  smembers: (...args) => _client.smembers(...args),
  lpush:    (...args) => _client.lpush(...args),
  lrange:   (...args) => _client.lrange(...args),
  ltrim:    (...args) => _client.ltrim(...args),
  zadd:     (...args) => _client.zadd(...args),
  zrange:   (...args) => _client.zrange(...args),
  zremrangebyscore: (...args) => _client.zremrangebyscore(...args),
};

export const ANNUAL_DAYS = 5;
export const REQUEST_TTL_SECONDS = 72 * 60 * 60;

export const KEYS = {
  employee:        (id) => `pto:employee:${id}`,
  employees:       'pto:employees',
  request:         (id) => `pto:request:${id}`,
  requests:        'pto:requests',
  requestsByEmp:   (employeeId) => `pto:requests:by-employee:${employeeId}`,
  decisionClaim:   (requestId) => `pto:decision-claim:${requestId}`,
  rateLimitLogin:  (nameKey) => `pto:rate:login:${nameKey}`,
  rateLimitIp:     (ip) => `pto:rate:ip:${ip}`,
};

export function normalizeName(s) {
  return String(s || '').toLowerCase().trim().replace(/\s+/g, ' ');
}
