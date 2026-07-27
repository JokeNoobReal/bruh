// services/glossary.js — Sustainable Multi-Chapter Glossary System
import fs from 'fs';
import path from 'path';

const DIR = path.join(process.cwd(), 'data', 'glossary');
const HISTORY_DIR = path.join(DIR, 'history');
const MAX_HISTORY = 10;

// Khởi tạo thư mục chứa dữ liệu
if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true });
if (!fs.existsSync(HISTORY_DIR)) fs.mkdirSync(HISTORY_DIR, { recursive: true });

// ─────────────────────────────────────────────
// Khóa theo bộ truyện: chặn 2 request cùng ghi đè nhau
// ─────────────────────────────────────────────
const locks = new Map();

export function withLock(seriesId, fn) {
  const prev = locks.get(seriesId) || Promise.resolve();
  const next = prev.then(fn, fn);
  locks.set(seriesId, next.catch(() => {}));
  return next;
}

// ─────────────────────────────────────────────
// Định danh bộ truyện từ URL hoặc Tên chuỗi
// ─────────────────────────────────────────────
export function deriveSeriesId(urlOrName) {
  if (!urlOrName) return 'default';
  try {
    if (urlOrName.startsWith('http://') || urlOrName.startsWith('https://')) {
      const u = new URL(urlOrName.trim());
      const slug = u.pathname
        .split('/')
        .filter(Boolean)
        .find(s => s.length > 3 && !/^chapter|^chuong|^\d+$/i.test(s)) || 'default';
      return `${u.hostname}__${slug}`.replace(/[^a-z0-9_.-]/gi, '_').slice(0, 120);
    }
  } catch {
    // Không phải URL -> dùng làm chuỗi trực tiếp
  }
  return String(urlOrName).trim().toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/[^a-z0-9_.-]+/g, '-')
    .slice(0, 120) || 'default';
}

// ─────────────────────────────────────────────
// Đọc / ghi file Glossary nguyên tử (Atomic Write)
// ─────────────────────────────────────────────
function emptyGlossary(seriesId) {
  return {
    seriesId,
    version: 0,
    updatedAt: null,
    lastChapter: 0,
    terms: [],
    honorifics: [],
    styleNotes: [],
    conflicts: []
  };
}

export function loadGlossary(seriesId) {
  const cleanId = deriveSeriesId(seriesId);
  const p = path.join(DIR, `${cleanId}.json`);
  if (!fs.existsSync(p)) return emptyGlossary(cleanId);
  try {
    const g = JSON.parse(fs.readFileSync(p, 'utf8'));
    return { ...emptyGlossary(cleanId), ...g };
  } catch (e) {
    console.warn(`⚠️ Glossary hỏng (${cleanId}), thử khôi phục từ history...`);
    return restoreLatest(cleanId) || emptyGlossary(cleanId);
  }
}

export async function saveGlossary(g) {
  g.version = (g.version || 0) + 1;
  g.updatedAt = new Date().toISOString();

  const cleanId = deriveSeriesId(g.seriesId);
  g.seriesId = cleanId;
  const p = path.join(DIR, `${cleanId}.json`);
  const body = JSON.stringify(g, null, 2);

  // Ghi nguyên tử: tmp -> rename
  const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
  await fs.promises.writeFile(tmp, body, 'utf8');
  await fs.promises.rename(tmp, p);

  // Sao lưu phiên bản
  const hp = path.join(HISTORY_DIR, `${cleanId}.v${g.version}.json`);
  await fs.promises.writeFile(hp, body, 'utf8');
  pruneHistory(cleanId);

  return g;
}

function historyFiles(seriesId) {
  const cleanId = deriveSeriesId(seriesId);
  if (!fs.existsSync(HISTORY_DIR)) return [];
  return fs.readdirSync(HISTORY_DIR)
    .filter(f => f.startsWith(`${cleanId}.v`))
    .map(f => ({ f, v: parseInt(f.match(/\.v(\d+)\.json$/)?.[1] || '0', 10) }))
    .sort((a, b) => b.v - a.v);
}

function pruneHistory(seriesId) {
  for (const { f } of historyFiles(seriesId).slice(MAX_HISTORY)) {
    try { fs.unlinkSync(path.join(HISTORY_DIR, f)); } catch {}
  }
}

export function restoreLatest(seriesId) {
  for (const { f } of historyFiles(seriesId)) {
    try {
      return JSON.parse(fs.readFileSync(path.join(HISTORY_DIR, f), 'utf8'));
    } catch {}
  }
  return null;
}

// Khớp thuật ngữ an toàn với Unicode, hỗ trợ tiếng Việt có dấu
const esc = (value) =>
  String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function wordRegex(name, flags = 'gi') {
  const safeFlags = flags.includes('u') ? flags : `${flags}u`;

  return new RegExp(
    `(?<![\\p{L}\\p{N}])${esc(name)}(?![\\p{L}\\p{N}])`,
    safeFlags
  );
}

export function namesOf(term) {
  return [term.en, ...(term.aliases || [])].filter(Boolean);
}

export function appearsIn(text, term) {
  if (!text || !term) return false;

  return namesOf(term).some((name) =>
    wordRegex(name, 'i').test(String(text))
  );
}

// ─────────────────────────────────────────────
// Chọn phần liên quan (đừng nhồi cả 400 mục vào prompt)
// ─────────────────────────────────────────────
export function selectRelevant(g, sourceText, { coreLimit = 25 } = {}) {
  const hit = g.terms.filter(t => appearsIn(sourceText, t));
  const core = g.terms
    .filter(t => ['character', 'place', 'title'].includes(t.type))
    .sort((a, b) => (b.count || 0) - (a.count || 0))
    .slice(0, coreLimit);

  const seen = new Set();
  const terms = [];
  for (const t of [...hit, ...core]) {
    if (seen.has(t.id)) continue;
    seen.add(t.id);
    terms.push(t);
  }

  const names = new Set(terms.flatMap(namesOf));
  const honorifics = g.honorifics.filter(h => names.has(h.a) && names.has(h.b));

  return { terms, honorifics };
}

// ─────────────────────────────────────────────
// Render vào prompt như một hợp đồng
// ─────────────────────────────────────────────
export function renderGlossary(terms, honorifics, styleNotes = []) {
  if (!terms.length && !honorifics.length) {
    return `═══ 📋 GLOSSARY ═══\n(Chương đầu tiên của bộ — chưa có dữ liệu chốt.)\n`;
  }

  const t = terms.map(x =>
    `| ${x.en}${x.aliases?.length ? ` (${x.aliases.join(', ')})` : ''} | ${x.vi} | ${x.type}${x.note ? ' - ' + x.note : ''} |`
  ).join('\n');

  const h = honorifics.map(x =>
    `| ${x.a} → ${x.b} | xưng "${x.aSelf}", gọi "${x.aCallsB}" | ${x.stage} |\n` +
    `| ${x.b} → ${x.a} | xưng "${x.bSelf}", gọi "${x.bCallsA}" | ${x.stage} |`
  ).join('\n');

  return `
═══ 📋 GLOSSARY ĐÃ CHỐT (BẮT BUỘC TUÂN THỦ) ═══
| Tiếng Anh | Tiếng Việt | Loại |
${t || '(trống)'}

═══ 💬 XƯNG HÔ ĐÃ CHỐT ═══
| Cặp | Cách xưng hô | Giai đoạn |
${h || '(trống)'}

${styleNotes.length ? `═══ 🎭 GHI CHÚ VĂN PHONG ═══\n- ${styleNotes.join('\n- ')}\n` : ''}
QUY TẮC BẤT DI BẤT DỊCH:
1. Mọi thuật ngữ trong bảng PHẢI dịch đúng như bảng. Không sáng tạo biến thể.
2. Cặp xưng hô đã chốt PHẢI giữ nguyên suốt chương.
3. Nếu tình tiết chương này khiến quan hệ thay đổi rõ rệt, VẪN DỊCH THEO BẢNG,
   rồi ghi chú riêng ở CUỐI BẢN DỊCH theo mẫu:
   [ĐỀ XUẤT ĐỔI XƯNG HÔ] A→B: <cặp mới> vì <trích dẫn câu làm bằng chứng>
4. Thuật ngữ mới chưa có trong bảng: cứ dịch bình thường, hệ thống sẽ thu thập sau.
`.trim();
}

// ─────────────────────────────────────────────
// Trích xuất thuật ngữ mới sau khi dịch xong
// ─────────────────────────────────────────────
const EXTRACT_SYSTEM = `Bạn là công cụ trích xuất thuật ngữ. CHỈ trả về JSON hợp lệ, không giải thích, không markdown.

So sánh [BẢN GỐC] và [BẢN DỊCH]. Tìm danh từ riêng và thuật ngữ đặc thù
(tên người, địa danh, kỹ năng/phép thuật, tổ chức, danh hiệu, vật phẩm).

BỎ QUA mọi mục đã có trong [GLOSSARY HIỆN TẠI].

Schema bắt buộc:
{
  "newTerms": [
    { "en": "...", "vi": "...", "type": "character|place|skill|item|org|title|other",
      "aliases": [], "note": "", "confidence": 0.0 }
  ],
  "honorificProposals": [
    { "a": "...", "b": "...", "aSelf": "...", "aCallsB": "...",
      "bSelf": "...", "bCallsA": "...", "stage": "xa lạ|kẻ thù|đồng minh|bạn bè|thân thiết",
      "reason": "TRÍCH DẪN NGUYÊN VĂN một câu trong chương làm bằng chứng" }
  ]
}

Không có bằng chứng trích dẫn thì KHÔNG đề xuất xưng hô.`;

function parseJsonLoose(raw) {
  if (!raw) return null;
  let s = String(raw).trim()
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/, '')
    .trim();
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a === -1 || b === -1) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch { return null; }
}

export async function extractTerms(callAI, g, sourceText, translatedText) {
  const known = g.terms.map(t => `${t.en} = ${t.vi}`).join('\n') || '(trống)';

  const raw = await callAI([
    { role: 'system', content: EXTRACT_SYSTEM },
    { role: 'user', content:
`=== GLOSSARY HIỆN TẠI ===
${known}

=== BẢN GỐC ===
${sourceText}

=== BẢN DỊCH ===
${translatedText}

=== JSON:` }
  ], { temperature: 0 });

  const parsed = parseJsonLoose(raw);
  return {
    newTerms: Array.isArray(parsed?.newTerms) ? parsed.newTerms : [],
    honorificProposals: Array.isArray(parsed?.honorificProposals) ? parsed.honorificProposals : []
  };
}

// ─────────────────────────────────────────────
// Trộn: bản cũ luôn thắng, xung đột thì ghi log
// ─────────────────────────────────────────────
const VALID_TYPES = ['character', 'place', 'skill', 'item', 'org', 'title', 'other'];

function findTerm(g, name) {
  const n = String(name).toLowerCase();
  return g.terms.find(t => namesOf(t).some(x => x.toLowerCase() === n));
}

export function mergeTerms(g, newTerms, chapter, { minConfidence = 0.6, autoLockAfter = 3 } = {}) {
  const added = [], conflicts = [];

  for (const c of newTerms) {
    if (!c?.en || !c?.vi) continue;
    if ((c.confidence ?? 1) < minConfidence) continue;
    if (String(c.en).length > 80) continue;

    const existing = findTerm(g, c.en);

    if (!existing) {
      const term = {
        id: 't_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        en: String(c.en).trim(),
        vi: String(c.vi).trim(),
        aliases: Array.isArray(c.aliases) ? c.aliases.filter(Boolean) : [],
        type: VALID_TYPES.includes(c.type) ? c.type : 'other',
        note: c.note || '',
        locked: false,
        chaptersSeen: [chapter],
        count: 1
      };
      g.terms.push(term);
      added.push(term);
      continue;
    }

    if (existing.vi.toLowerCase() === String(c.vi).trim().toLowerCase()) {
      existing.count = (existing.count || 0) + 1;
      if (!existing.chaptersSeen.includes(chapter)) existing.chaptersSeen.push(chapter);
      if (existing.chaptersSeen.length >= autoLockAfter) existing.locked = true;
    } else {
      const conflict = {
        chapter,
        en: existing.en,
        kept: existing.vi,
        rejected: String(c.vi).trim(),
        at: new Date().toISOString()
      };
      g.conflicts.push(conflict);
      conflicts.push(conflict);
    }
  }

  if (g.conflicts.length > 200) g.conflicts = g.conflicts.slice(-200);
  return { added, conflicts };
}

export function mergeHonorifics(g, proposals, chapter) {
  const applied = [];

  for (const p of proposals) {
    if (!p?.a || !p?.b || !p?.reason || String(p.reason).length < 15) continue;

    const cur = g.honorifics.find(h =>
      (h.a === p.a && h.b === p.b) || (h.a === p.b && h.b === p.a)
    );

    if (!cur) {
      g.honorifics.push({
        a: p.a, b: p.b,
        aSelf: p.aSelf || 'tôi', aCallsB: p.aCallsB || 'cậu',
        bSelf: p.bSelf || 'tôi', bCallsA: p.bCallsA || 'cậu',
        stage: p.stage || 'xa lạ',
        sinceChapter: chapter,
        locked: false,
        history: []
      });
      applied.push(p);
      continue;
    }

    if (cur.locked) continue;

    const changed = cur.aCallsB !== p.aCallsB || cur.aSelf !== p.aSelf || cur.stage !== p.stage;
    // Chống lật qua lật lại: cần cách lần đổi trước ít nhất 3 chương
    if (changed && chapter - (cur.sinceChapter || 0) >= 3) {
      cur.history.push({
        chapter: cur.sinceChapter, aSelf: cur.aSelf,
        aCallsB: cur.aCallsB, stage: cur.stage
      });
      Object.assign(cur, {
        aSelf: p.aSelf || cur.aSelf,
        aCallsB: p.aCallsB || cur.aCallsB,
        bSelf: p.bSelf || cur.bSelf,
        bCallsA: p.bCallsA || cur.bCallsA,
        stage: p.stage || cur.stage,
        sinceChapter: chapter
      });
      applied.push(p);
    }
  }

  return applied;
}

// ─────────────────────────────────────────────
// Kiểm tra cưỡng chế: audit & enforce hard regex replacement
// ─────────────────────────────────────────────
export function auditGlossary(sourceText, translatedText, terms) {
  const lower = translatedText.toLowerCase();
  return terms.filter(t =>
    appearsIn(sourceText, t) && !lower.includes(t.vi.toLowerCase())
  );
}

/** Sửa cứng bằng regex — chỉ an toàn với danh từ riêng 1:1 */
export function enforceHard(translatedText, violations) {
  let out = translatedText;
  const fixed = [], remaining = [];

  for (const t of violations) {
    if (!['character', 'place', 'title', 'org'].includes(t.type)) {
      remaining.push(t);
      continue;
    }
    let touched = false;
    for (const n of namesOf(t)) {
      const re = wordRegex(n, 'g');
      if (re.test(out)) {
        out = out.replace(re, t.vi);
        touched = true;
      }
    }
    (touched ? fixed : remaining).push(t);
  }

  return { text: out, fixed, remaining };
}

/** Prompt sửa hẹp cho phần regex không xử lý được */
export function buildFixPrompt(violations) {
  return `Bạn là biên tập viên. Bản dịch dưới đây dùng SAI một số thuật ngữ bắt buộc.

CẦN SỬA:
${violations.map(t => `- "${t.en}" PHẢI là "${t.vi}"`).join('\n')}

QUY TẮC:
1. CHỈ sửa đúng các thuật ngữ trên. Giữ nguyên 100% phần còn lại.
2. KHÔNG viết lại câu, KHÔNG tóm tắt, KHÔNG thêm bớt.
3. Chỉ trả về toàn văn bản đã sửa.`;
}

/** Model nuốt nội dung là chuyện thường ngày — canh bằng tỉ lệ độ dài */
export function checkLength(sourceText, translatedText, min = 0.7) {
  const ratio = translatedText.length / Math.max(1, sourceText.length);
  return { ratio, ok: ratio >= min };
}

// ─────────────────────────────────────────────
// Khởi tạo từ cặp mẫu EN↔VI (chương đầu)
// ─────────────────────────────────────────────
export async function seedFromSamples(callAI, g, pairs) {
  if (!pairs || !pairs.length) return g;
  const body = pairs.map((p, i) =>
    `=== CẶP MẪU ${i + 1} ===\n[EN]\n${p.en}\n\n[VI]\n${p.vi}`
  ).join('\n\n');

  const { newTerms, honorificProposals } = await extractTerms(callAI, g, body, '(xem cặp mẫu)');

  // Đến từ bản dịch người thật -> chốt luôn
  mergeTerms(g, newTerms, 0, { minConfidence: 0.4, autoLockAfter: 1 });
  mergeHonorifics(g, honorificProposals, 0);
  g.terms.forEach(t => { t.locked = true; });
  g.honorifics.forEach(h => { h.locked = true; });

  return g;
}
