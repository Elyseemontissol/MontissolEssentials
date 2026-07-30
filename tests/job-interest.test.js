import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateInterest } from '../api/jobs.js';

const valid = {
  projectId: 'hop-brook-lake',
  name: 'Jordan Smith',
  email: 'jordan@example.com',
  phone: '(203) 555-0182',
  experience: 'Three years of custodial and facility cleaning experience.',
  canPerform: 'yes',
  workConstraints: '',
};

test('validates a complete Hop Brook Lake interest form', () => {
  const result = validateInterest(valid);
  assert.equal(result.error, undefined);
  assert.match(result.data.project, /Hop Brook Lake/);
});

test('requires every applicant field', () => {
  for (const field of ['name', 'email', 'phone', 'experience', 'canPerform']) {
    const result = validateInterest({ ...valid, [field]: '' });
    assert.match(result.error, /required|more about/i);
  }
});

test('requires a yes or no essential-duties answer', () => {
  assert.match(validateInterest({ ...valid, canPerform: 'maybe' }).error, /essential duties/i);
});

test('rejects invalid email and phone values', () => {
  assert.match(validateInterest({ ...valid, email: 'wrong' }).error, /email/i);
  assert.match(validateInterest({ ...valid, phone: 'abc' }).error, /phone/i);
});

test('rejects unknown project identifiers', () => {
  assert.match(validateInterest({ ...valid, projectId: 'other' }).error, /not available/i);
});
