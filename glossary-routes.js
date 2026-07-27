// glossary-routes.js — Xem / sửa / khóa sổ thuật ngữ bằng tay
// Mount trong server.js SAU express.json():
//   import glossaryRoutes from './glossary-routes.js';
//   app.use('/api/glossary', glossaryRoutes);

import express from 'express';
import fs from 'fs/promises';
import path from 'path';
import {
  loadGlossary, saveGlossary, renderForPrompt,
  resolveAddressAt, setAddressStage, GLOSSARY_DIR
} from './glossary.js';

const router = express.Router();
const KINDS = ['characters', 'places', 'terms'];

// --- Khóa ghi theo từng bộ: chặn 2 request cùng load-sửa-save gây mất dữ liệu ---
const locks = new Map();
async function withSeries(series, fn) {
  const prev = locks.get(series) || Promise.resolve();
  let release;
  const next = new Promise(r => (release = r));
  locks.set(series, prev.then(() => next));
  try {
    await prev;
    const g = await loadGlossary(series);
    const result = await fn(g);
    await saveGlossary(series, g);
    return result;
  } finally {
    release();
    if (locks.get(series) === next) locks.delete(series);
  }
}

const findTerm = (g, kind, en) =>
  g.terms[kind]?.find(t => t.en.trim().toLowerCase() === String(en).trim().toLowerCase());

// ============ ĐỌC ============

/** GET /api/glossary — danh sách các bộ truyện đã có sổ */
router.get('/', async (_req, res) => {
  try {
    const files = await fs.readdir(GLOSSARY_DIR).catch(() => []);
    const list = [];
    for (const f of files.filter(f => f.endsWith('.json'))) {
      try {
        const g = JSON.parse(await fs.readFile(path.join(GLOSSARY_DIR, f), 'utf-8'));
        list.push({
          slug: f.replace(/\.json$/, ''),
          series: g.series,
          lastChapter: g.lastChapter || 0,
          updatedAt: g.updatedAt,
          counts: {
            characters: g.terms?.characters?.length || 0,
            places: g.terms?.places?.length || 0,
            terms: g.terms?.terms?.length || 0,
            addressPairs: Object.keys(g.address || {}).length
          }
        });
      } catch { /* file hỏng thì bỏ qua, đừng làm sập cả danh sách */ }
    }
    list.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    res.json({ series: list });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** GET /api/glossary/:series — toàn bộ sổ của 1 bộ */
router.get('/:series', async (req, res) => {
  try {
    res.json(await loadGlossary(req.params.series));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** GET /api/glossary/:series/at/:chapter — trạng thái hiệu lực + xem trước khối nhét vào prompt */
router.get('/:series/at/:chapter', async (req, res) => {
  try {
    const g = await loadGlossary(req.params.series);
    const ch = Number(req.params.chapter) || 0;
    res.json({
      chapter: ch,
      address: resolveAddressAt(g, ch),
      promptPreview: renderForPrompt(g, ch)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============ TẦNG BẤT BIẾN ============

/**
 * PATCH /api/glossary/:series/term
 * body: { kind, en, vi, note, locked }
 * Sửa "vi" ở đây là cách bạn ép lại tên nhân vật AI dịch lệch.
 */
router.patch('/:series/term', async (req, res) => {
  const { kind, en, vi, note, locked } = req.body || {};
  if (!KINDS.includes(kind)) return res.status(400).json({ error: `kind phải là: ${KINDS.join(', ')}` });
  if (!en?.trim()) return res.status(400).json({ error: 'Thiếu "en"' });

  try {
    const out = await withSeries(req.params.series, (g) => {
      let t = findTerm(g, kind, en);
      if (!t) {
        t = { en: en.trim(), vi: '', note: '', locked: false };
        g.terms[kind].push(t);
      }
      if (vi !== undefined) t.vi = String(vi).trim();
      if (note !== undefined) t.note = String(note);
      if (locked !== undefined) t.locked = Boolean(locked);
      return t;
    });
    res.json({ ok: true, term: out });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** DELETE /api/glossary/:series/term — body: { kind, en } */
router.delete('/:series/term', async (req, res) => {
  const { kind, en } = req.body || {};
  if (!KINDS.includes(kind) || !en?.trim()) return res.status(400).json({ error: 'Thiếu kind hoặc en' });
  try {
    const removed = await withSeries(req.params.series, (g) => {
      const key = en.trim().toLowerCase();
      const before = g.terms[kind].length;
      g.terms[kind] = g.terms[kind].filter(t => t.en.trim().toLowerCase() !== key);
      return before !== g.terms[kind].length;
    });
    res.json({ ok: removed, removed });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============ TẦNG ĐỘNG (XƯNG HÔ) ============

/**
 * PUT /api/glossary/:series/address — thêm/sửa 1 MỐC chuyển giai đoạn
 * body: { from, to, fromChapter, self, other, stage, trigger, both }
 * both = true → tạo luôn chiều ngược lại với cặp xưng hô đảo ngược.
 */
router.put('/:series/address', async (req, res) => {
  const { from, to, fromChapter, self, other, stage, trigger, both } = req.body || {};
  if (!from || !to || !self || !other) return res.status(400).json({ error: 'Thiếu from/to/self/other' });
  const ch = Number(fromChapter);
  if (!Number.isFinite(ch) || ch < 0) return res.status(400).json({ error: 'fromChapter không hợp lệ' });

  try {
    const out = await withSeries(req.params.series, (g) => {
      const results = {};
      const apply = (pair, s, o) => {
        // Sửa tay thì được phép ghi đè cả mốc đang locked
        const hist = g.address[pair]?.history;
        const cur = hist?.filter(h => h.fromChapter <= ch).pop();
        const wasLocked = cur?.locked;
        if (cur) cur.locked = false;
        const r = setAddressStage(g, pair, {
          fromChapter: ch, self: s, other: o,
          stage, trigger: trigger || '(sửa tay)'
        });
        if (cur && wasLocked) cur.locked = true;
        results[pair] = r;
      };
      apply(`${from}→${to}`, self, other);
      if (both) apply(`${to}→${from}`, other, self);
      return results;
    });
    res.json({ ok: true, applied: out });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * PATCH /api/glossary/:series/address/lock — khóa / mở khóa một cặp xưng hô
 * Khóa rồi thì bước trích xuất tự động sẽ không bao giờ đụng vào nữa.
 * body: { from, to, fromChapter?, locked }
 */
router.patch('/:series/address/lock', async (req, res) => {
  const { from, to, fromChapter, locked = true } = req.body || {};
  if (!from || !to) return res.status(400).json({ error: 'Thiếu from/to' });

  try {
    const out = await withSeries(req.params.series, (g) => {
      const pair = `${from}→${to}`;
      const hist = g.address[pair]?.history;
      if (!hist?.length) throw new Error(`Chưa có cặp "${pair}" trong sổ`);
      // Không nêu chương → khóa mốc mới nhất
      const target = fromChapter !== undefined
        ? hist.find(h => h.fromChapter === Number(fromChapter))
        : hist[hist.length - 1];
      if (!target) throw new Error(`Không tìm thấy mốc tại chương ${fromChapter}`);
      target.locked = Boolean(locked);
      return { pair, stage: target };
    });
    res.json({ ok: true, ...out });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/** DELETE /api/glossary/:series/address/stage — xóa 1 mốc sai. body: { from, to, fromChapter } */
router.delete('/:series/address/stage', async (req, res) => {
  const { from, to, fromChapter } = req.body || {};
  if (!from || !to || fromChapter === undefined) return res.status(400).json({ error: 'Thiếu from/to/fromChapter' });

  try {
    const out = await withSeries(req.params.series, (g) => {
      const pair = `${from}→${to}`;
      const entry = g.address[pair];
      if (!entry) throw new Error(`Không có cặp "${pair}"`);
      const before = entry.history.length;
      entry.history = entry.history.filter(h => h.fromChapter !== Number(fromChapter));
      if (entry.history.length === 0) delete g.address[pair];
      return { removed: before !== entry.history.length, remaining: entry.history?.length ?? 0 };
    });
    res.json({ ok: true, ...out });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

export default router;
