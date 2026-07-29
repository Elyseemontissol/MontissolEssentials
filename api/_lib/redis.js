import { Redis } from '@upstash/redis';

const _client = Redis.fromEnv();

// Narrow interface exposing only the Redis operations this app uses.
export const redis = {
  get:    (...args) => _client.get(...args),
  set:    (...args) => _client.set(...args),
  getdel: (...args) => _client.getdel(...args),
  lrange: (...args) => _client.lrange(...args),
  lpush:  (...args) => _client.lpush(...args),
  ltrim:  (...args) => _client.ltrim(...args),
};

export const KEYS = {
  draft: (id) => `fb:draft:${id}`,
  nextTheme: 'fb:next_theme',
  history: 'fb:history',
  recruitingNextRole: 'fb:recruiting_next_role',
};

export const THEMES = [
  'business_inspiration',
  'employee_culture',
  'why_work_here',
  'recruiting',
];
export const JOB_ROLES = [
  'janitorial-tech',
  'industrial-cleaning',
  'maintenance-tech',
  'qc-compliance',
  'qc-inspector',
  'site-supervisor',
];
