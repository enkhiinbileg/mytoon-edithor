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
  // HTTP 401/402 alone does NOT mean a balance is exhausted.
  if (code === 'quota_exceeded' || (!code && /quota_exceeded|insufficient quota|quota exceeded/.test(message))) return 'quota';
  if (error.status === 429 || /rate_limit|concurrent_limit|too_many_concurrent/.test(code)) return 'rate';
  // Authorization, voice restrictions and abuse blocks need user action, not
  // automatic rotation through accounts or an invented "credits exhausted" error.
  if ([400, 401, 402, 403, 404, 422].includes(error.status)) return 'terminal';
  return 'transient';
}

module.exports = { responseError, classifyError };
