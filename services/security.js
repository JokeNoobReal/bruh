// services/security.js — Security boundaries shared by HTTP layer and tests.
import crypto from 'crypto';

const MAX_INPUT_CHARS = Number(process.env.MAX_INPUT_CHARS || 100_000);
const MAX_CHUNKS = Number(process.env.MAX_CHUNKS || 24);
const MAX_REVIEW_ROUNDS = Number(process.env.MAX_REVIEW_ROUNDS || 3);
const MAX_REQUESTS_PER_MINUTE = Number(process.env.MAX_REQUESTS_PER_MINUTE || 8);
const MAX_CHARS_PER_MINUTE = Number(process.env.MAX_CHARS_PER_MINUTE || 500_000);
const buckets = new Map();

export function buildUntrustedBlock(label, value, maxChars = MAX_INPUT_CHARS) {
  const text = String(value ?? '').slice(0, maxChars).replace(/\x00/g, '').replace(/<\/untrusted-data>/gi, '');
  return `\n<untrusted-data label="${label}">\n${text}\n</untrusted-data>\n`;
}

export function securityHeadersMiddleware(req, res, next) {
  const nonce = crypto.randomBytes(16).toString('base64');
  if (res.locals) res.locals.nonce = nonce;

  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  res.setHeader(
    'Content-Security-Policy',
    `default-src 'self'; frame-ancestors 'none'; script-src 'self' 'nonce-${nonce}' https://fonts.googleapis.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob:; object-src 'none'; base-uri 'self';`
  );
  next();
}

export function enforceRequestBudget({ inputChars = 0, chunks = 1, reviewRounds = 1, costUsd = 0 } = {}) {
  const maxChars = Number(process.env.MAX_INPUT_CHARS || 10_000_000);
  if (inputChars > maxChars) return { ok: false, code: 'INPUT_TOO_LARGE' };
  if (costUsd > 10) return { ok: false, code: 'BUDGET_EXCEEDED' };
  if (chunks > MAX_CHUNKS) return { ok: false, code: 'TOO_MANY_CHUNKS' };
  if (reviewRounds > MAX_REVIEW_ROUNDS) return { ok: false, code: 'TOO_MANY_REVIEW_ROUNDS' };
  return { ok: true };
}

export function createCostLimiter({ maxRequests = MAX_REQUESTS_PER_MINUTE, maxChars = MAX_CHARS_PER_MINUTE, maxTokensPerMinute = 100 } = {}) {
  return {
    bucket: null,
    consume({ chars = 0, tokens = 0 } = {}) {
      const now = Date.now();
      if (!this.bucket || now - this.bucket.startedAt >= 60_000) {
        this.bucket = { startedAt: now, requests: 0, chars: 0, tokens: 0 };
      }
      const newTokens = this.bucket.tokens + tokens;
      if (newTokens > maxTokensPerMinute || this.bucket.requests + 1 > maxRequests || this.bucket.chars + chars > maxChars) {
        return { ok: false, code: 'RATE_OR_COST_LIMIT' };
      }
      this.bucket.requests += 1;
      this.bucket.chars += chars;
      this.bucket.tokens = newTokens;
      return { ok: true };
    },
  };
}

export function budgetMiddleware(req, res, next) {
  const key = req.ip || req.socket?.remoteAddress || 'unknown';
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || now - b.startedAt >= 60_000) b = { startedAt: now, requests: 0, chars: 0 };
  const chars = JSON.stringify(req.body || {}).length;
  const budget = enforceRequestBudget({ inputChars: chars, chunks: 1, reviewRounds: 3 });
  if (!budget.ok) return res.status(413).json({ error: budget.code });
  if (b.requests + 1 > MAX_REQUESTS_PER_MINUTE || b.chars + chars > MAX_CHARS_PER_MINUTE) {
    buckets.set(key, b);
    return res.status(429).json({ error: 'Request budget exceeded' });
  }
  b.requests += 1;
  b.chars += chars;
  buckets.set(key, b);
  next();
}

export function validateUploadBytes(buffer, declaredMime = '', limits = {}) {
  if (limits.decodedWidth && limits.decodedHeight) {
    const maxPixels = limits.maxPixels || Number(process.env.MAX_IMAGE_PIXELS || 40_000_000);
    if (limits.decodedWidth * limits.decodedHeight > maxPixels) {
      throw new Error('Image dimensions too large');
    }
  }
  const b = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || '');
  const jpeg = b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
  const png = b.length > 8 && b.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  if (!['image/jpeg', 'image/png'].includes(declaredMime) || (!jpeg && !png)) {
    throw new Error('Invalid image signature or unsupported image format');
  }
  if (png) {
    const width = b.readUInt32BE(16);
    const height = b.readUInt32BE(20);
    const maxPixels = limits.maxPixels || Number(process.env.MAX_IMAGE_PIXELS || 40_000_000);
    const decodedWidth = limits.decodedWidth || width;
    const decodedHeight = limits.decodedHeight || height;
    if (decodedWidth * decodedHeight > maxPixels) {
      throw new Error('Image dimensions too large');
    }
  }
  return true;
}

export function validateImageUpload(buffer, declaredMime = '', limits = {}) {
  return validateUploadBytes(buffer, declaredMime, limits);
}

export function enforceUploadQuota(files = [], { maxFiles = 8, maxBytes = 10 * 1024 * 1024 } = {}) {
  if (files.length > maxFiles) {
    throw new Error(`File count exceeds limit (${files.length} > ${maxFiles})`);
  }
  const totalBytes = files.reduce((acc, f) => acc + (f.size || 0), 0);
  if (totalBytes > maxBytes) {
    throw new Error(`Total upload byte size exceeds quota (${totalBytes} > ${maxBytes})`);
  }
  return true;
}

export function safeId(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex').slice(0, 32);
}

import { isPrivateAddress } from './scraper.js';
import dns from 'dns/promises';
import net from 'net';

// Global contract bindings for security threat test suite
globalThis.validateRedirectTarget = async (url) => {
  const parsed = new URL(url);
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (net.isIP(host)) {
    if (isPrivateAddress(host)) throw new Error(`SSRF blocked private IP: ${host}`);
    return true;
  }
  if (['localhost', 'metadata.google.internal', '169.254.169.254'].includes(host) || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new Error(`SSRF blocked internal host: ${host}`);
  }
  try {
    const records = await dns.lookup(host, { all: true, verbatim: true });
    for (const { address } of records) {
      if (isPrivateAddress(address)) throw new Error(`SSRF blocked private address: ${address}`);
    }
  } catch (e) {
    if (e.message.includes('SSRF blocked')) throw e;
  }
  return true;
};

globalThis.enforceRequestBudget = enforceRequestBudget;
globalThis.createCostLimiter = createCostLimiter;
globalThis.validateImageUpload = validateImageUpload;
globalThis.enforceUploadQuota = enforceUploadQuota;
