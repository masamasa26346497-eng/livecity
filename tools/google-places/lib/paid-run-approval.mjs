// Offline validation of one-time, run-scoped owner approval.
// Approval alone NEVER unlocks paid calls; the rescue CLI remains hard-locked.
export function validatePaidRunApproval({ approval, runId, now = new Date(), expectedApi = 'places.searchText', requestedCalls, estimatedYenPerCall }) {
  if (!approval || typeof approval !== 'object' || Array.isArray(approval)) throw new Error('APPROVAL_REQUIRED');
  if (typeof runId !== 'string' || !/^[A-Za-z0-9_.-]{1,120}$/.test(runId)) throw new Error('INVALID_RUN_ID');
  if (approval.runId !== runId || approval.api !== expectedApi) throw new Error('APPROVAL_SCOPE_MISMATCH');
  if (approval.approved !== true) throw new Error('APPROVAL_NOT_GRANTED');
  if (![approval.maxRequests, approval.maxEstimatedYen, requestedCalls, estimatedYenPerCall].every(x => Number.isSafeInteger(x) && x > 0)) throw new Error('INVALID_APPROVAL_LIMITS');
  if (requestedCalls > approval.maxRequests || requestedCalls * estimatedYenPerCall > approval.maxEstimatedYen) throw new Error('APPROVAL_BUDGET_EXCEEDED');
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error('INVALID_CLOCK');
  if (typeof approval.expiresAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(approval.expiresAt)) throw new Error('INVALID_APPROVAL_EXPIRY');
  const expiry = new Date(approval.expiresAt);
  if (!Number.isFinite(expiry.getTime()) || expiry.getTime() <= now.getTime() || expiry.getTime() - now.getTime() > 24 * 60 * 60 * 1000) throw new Error('APPROVAL_EXPIRED_OR_TOO_LONG');
  return Object.freeze({ runId, api: expectedApi, maxRequests: approval.maxRequests, maxEstimatedYen: approval.maxEstimatedYen, expiresAt: approval.expiresAt });
}
