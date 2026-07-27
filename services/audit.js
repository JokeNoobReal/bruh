// services/audit.js — Structured Security Audit Logger with Automatic Redaction (OWASP ASVS V7.2.1 & V7.1.1)

const SENSITIVE_KEYS = new Set([
  'token', 'api_key', 'apikey', 'key', 'secret', 'authorization',
  'password', 'x-api-token', 'cookie', 'set-cookie', 'prompt', 'source',
  'draft', 'newentext', 'sampleencombined', 'samplevicombined'
]);

export function redactSensitiveData(obj) {
  if (!obj || typeof obj !== 'object') return obj;

  if (Array.isArray(obj)) {
    return obj.map(redactSensitiveData);
  }

  const redacted = {};
  for (const [k, v] of Object.entries(obj)) {
    const lowerKey = k.toLowerCase();
    if (SENSITIVE_KEYS.has(lowerKey) || lowerKey.includes('token') || lowerKey.includes('secret') || lowerKey.includes('key')) {
      redacted[k] = '[REDACTED]';
    } else if (typeof v === 'string' && (v.startsWith('sk-') || v.length > 200)) {
      redacted[k] = v.startsWith('sk-') ? '[REDACTED_API_KEY]' : v.slice(0, 50) + '... [TRUNCATED]';
    } else if (typeof v === 'object') {
      redacted[k] = redactSensitiveData(v);
    } else {
      redacted[k] = v;
    }
  }
  return redacted;
}

export function logAuditEvent(event, { level = 'INFO', req = null, category = 'SECURITY', ...details } = {}) {
  const auditEntry = {
    timestamp: new Date().toISOString(),
    event,
    category,
    level,
    ip: req ? (req.ip || req.socket?.remoteAddress || 'unknown') : 'system',
    userAgent: req ? (req.headers['user-agent'] || 'unknown') : 'system',
    method: req ? req.method : undefined,
    url: req ? req.originalUrl || req.url : undefined,
    details: redactSensitiveData(details),
  };

  // Structured JSON output for SIEM / log aggregators
  console.log(JSON.stringify(auditEntry));
  return auditEntry;
}
