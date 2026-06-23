import { test } from 'node:test';
import assert from 'node:assert/strict';

import { scanOpportunities, isScanFailure } from '../api/sam-scraper.js';

const WINDOW = { postedFrom: '06/15/2026', postedTo: '06/22/2026' };

test('total failure: when every request throws (e.g. invalid API key), the scan flags failure rather than zero results', async () => {
  const fetchFn = async () => {
    throw new Error('SAM.gov API error (401): API_KEY_INVALID');
  };

  const result = await scanOpportunities({ fetchFn, ...WINDOW });

  assert.equal(result.opportunities.length, 0);
  assert.ok(result.totalRequests > 0, 'should make at least one request');
  assert.equal(result.failedRequests, result.totalRequests, 'all requests failed');
  assert.equal(isScanFailure(result), true);
});

test('genuine zero: when every request succeeds but returns no data, the scan is NOT flagged as failure', async () => {
  const fetchFn = async () => ({ opportunitiesData: [] });

  const result = await scanOpportunities({ fetchFn, ...WINDOW });

  assert.equal(result.opportunities.length, 0);
  assert.equal(result.failedRequests, 0);
  assert.equal(isScanFailure(result), false);
});

test('partial failure: some requests fail but results come back — not flagged as total failure', async () => {
  let calls = 0;
  const fetchFn = async () => {
    calls++;
    if (calls % 2 === 0) throw new Error('SAM.gov API error (500): boom');
    return {
      opportunitiesData: [
        { noticeId: `n${calls}`, title: 'Janitorial Services Contract', postedDate: '2026-06-20' },
      ],
    };
  };

  const result = await scanOpportunities({ fetchFn, ...WINDOW });

  assert.ok(result.opportunities.length > 0, 'should still collect successful results');
  assert.ok(result.failedRequests > 0, 'some requests failed');
  assert.ok(result.failedRequests < result.totalRequests, 'but not all');
  assert.equal(isScanFailure(result), false);
});
