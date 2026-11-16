import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePaidRunApproval } from '../tools/google-places/lib/paid-run-approval.mjs';

const now = new Date('2026-10-09T00:00:00Z');
const approval = { approved: true, runId: 'run-001', api: 'places.searchText', maxRequests: 3, maxEstimatedYen: 30, expiresAt: '2026-10-09T01:00:00Z' };
const opts = { approval, runId: 'run-001', now, requestedCalls: 3, estimatedYenPerCall: 10 };
test('one-run approval accepts exact scope and budget', () => {
  assert.equal(validatePaidRunApproval(opts).maxRequests, 3);
});
test('missing, rejected, reused or expired approval fails closed', () => {
  assert.throws(() => validatePaidRunApproval({ ...opts, approval: null }), /APPROVAL_REQUIRED/);
  assert.throws(() => validatePaidRunApproval({ ...opts, approval: { ...approval, approved: false } }), /APPROVAL_NOT_GRANTED/);
  assert.throws(() => validatePaidRunApproval({ ...opts, runId: 'run-002' }), /APPROVAL_SCOPE_MISMATCH/);
  assert.throws(() => validatePaidRunApproval({ ...opts, now: new Date('2026-10-09T01:00:00Z') }), /APPROVAL_EXPIRED/);
  assert.throws(() => validatePaidRunApproval({ ...opts, approval: { ...approval, expiresAt: '2026-10-11T00:00:00Z' } }), /APPROVAL_EXPIRED/);
});
test('request and yen limits are independent hard ceilings', () => {
  assert.throws(() => validatePaidRunApproval({ ...opts, requestedCalls: 4 }), /APPROVAL_BUDGET_EXCEEDED/);
  assert.throws(() => validatePaidRunApproval({ ...opts, estimatedYenPerCall: 11 }), /APPROVAL_BUDGET_EXCEEDED/);
  assert.throws(() => validatePaidRunApproval({ ...opts, approval: { ...approval, maxEstimatedYen: 0 } }), /INVALID_APPROVAL_LIMITS/);
});
