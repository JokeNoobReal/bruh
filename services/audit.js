// services/audit.js — Structured Security Audit Logger (OWASP ASVS V7.2.1)

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
    details,
  };

  // Structured JSON output for SIEM / log aggregators
  console.log(JSON.stringify(auditEntry));
  return auditEntry;
}
