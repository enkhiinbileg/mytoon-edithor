'use strict';

function responseError(status, body, retryAfter) {
  const detail = body?.detail;
  const code = typeof detail === 'object' ? detail?.status || detail?.code || '' : body?.code || '';
  const message = typeof detail === 'string' ? detail : detail?.message || body?.message || '';
  const error = new Error(`ElevenLabs (${status}${code ? ` / ${code}` : ''})${message ? `: ${message}` : ''}`);
  error.status = status;
  error.code = code;
  const seconds = Number(retryAfter);
  error.retryAfterMs = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : Math.max(0, Date.parse(retryAfter) - Date.now()) || 0;
  return error;
}

function classifyError(error) {
  const code = String(error.code || '').toLowerCase();
  const message = String(error.message || error).toLowerCase();
  if (
    error.status === 402 ||
    code === 'quota_exceeded' ||
    /quota_exceeded|insufficient quota|quota exceeded|not enough credits|insufficient_credits|exceeded.*quota/.test(code) ||
    /quota_exceeded|insufficient quota|quota exceeded|not enough credits|insufficient_credits|exceeded.*quota|credit.*limit/.test(message)
  ) return 'quota';
  if (error.status === 429 || /rate_limit|concurrent_limit|too_many_concurrent/.test(code)) return 'rate';
  if (code === 'detected_unusual_activity' || /unusual_activity|blocked|banned/.test(message)) return 'terminal';
  if ([401, 403, 404, 422].includes(error.status)) return 'terminal';
  return 'transient';
}

module.exports = { responseError, classifyError };
