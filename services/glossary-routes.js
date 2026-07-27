// services/glossary-routes.js — Express Router cho Sổ Thuật Ngữ (Xem / Sửa / Khóa Tay / Conflicts)
import express from 'express';
import fs from 'fs/promises';
import path from 'path';
import {
  loadGlossary, saveGlossary, withLock, deriveSeriesId
} from './glossary.js';

const router = express.Router();
const DIR = path.join(process.cwd(), 'data', 'glossary');

// GET /api/glossary — Danh sách các bộ truyện có sổ
router.get('/', async (_req, res) => {
  try {
    const files = await fs.readdir(DIR).catch(() => []);
    const list = [];
    for (const f of files.filter(f => f.endsWith('.json'))) {
      try {
        const raw = await fs.readFile(path.join(DIR, f), 'utf-8');
        const g = JSON.parse(raw);
        list.push({
          seriesId: g.seriesId || f.replace(/\.json$/, ''),
          version: g.version || 0,
          lastChapter: g.lastChapter || 0,
          updatedAt: g.updatedAt,
          counts: {
            terms: g.terms?.length || 0,
            honorifics: g.honorifics?.length || 0,
            conflicts: g.conflicts?.length || 0
          }
        });
      } catch {}
    }
    res.json(list);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/glossary/:id — Lấy toàn bộ sổ của 1 bộ truyện
router.get('/:id', (req, res) => {
  try {
    const g = loadGlossary(req.params.id);
    res.json(g);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/glossary/:id/conflicts — Lấy danh sách xung đột thuật ngữ cần người xem
router.get('/:id/conflicts', (req, res) => {
  try {
    const g = loadGlossary(req.params.id);
    res.json(g.conflicts || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/glossary/:id/terms/:tid — Cập nhật / ép thuật ngữ (Sửa tay -> Tự động locked = true)
router.patch('/:id/terms/:tid', async (req, res) => {
  try {
    const seriesId = req.params.id;
    const tid = req.params.tid;

    const updatedGlossary = await withLock(seriesId, async () => {
      const g = loadGlossary(seriesId);
      const term = g.terms.find(x => x.id === tid);
      if (!term) return null;

      // Cập nhật và khóa vĩnh viễn
      Object.assign(term, req.body, { locked: true });
      return await saveGlossary(g);
    });

    if (!updatedGlossary) {
      return res.status(404).json({ error: 'Không tìm thấy thuật ngữ với ID này' });
    }
    res.json(updatedGlossary);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/glossary/:id/terms — Thêm thuật ngữ mới bằng tay (locked = true)
router.post('/:id/terms', async (req, res) => {
  try {
    const seriesId = req.params.id;
    const { en, vi, type = 'other', aliases = [], note = '' } = req.body;
    if (!en || !vi) return res.status(400).json({ error: 'Thiếu en hoặc vi' });

    const updatedGlossary = await withLock(seriesId, async () => {
      const g = loadGlossary(seriesId);
      const existing = g.terms.find(t => t.en.toLowerCase() === en.trim().toLowerCase());
      if (existing) {
        Object.assign(existing, { vi: vi.trim(), type, aliases, note, locked: true });
      } else {
        g.terms.push({
          id: 't_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
          en: en.trim(),
          vi: vi.trim(),
          type,
          aliases: Array.isArray(aliases) ? aliases : [],
          note,
          locked: true,
          chaptersSeen: [g.lastChapter || 0],
          count: 1
        });
      }
      return await saveGlossary(g);
    });

    res.json(updatedGlossary);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/glossary/:id/terms/:tid — Xóa thuật ngữ
router.delete('/:id/terms/:tid', async (req, res) => {
  try {
    const seriesId = req.params.id;
    const tid = req.params.tid;

    const updatedGlossary = await withLock(seriesId, async () => {
      const g = loadGlossary(seriesId);
      const idx = g.terms.findIndex(x => x.id === tid);
      if (idx === -1) return null;

      g.terms.splice(idx, 1);
      return await saveGlossary(g);
    });

    if (!updatedGlossary) return res.status(404).json({ error: 'Không tìm thấy thuật ngữ' });
    res.json(updatedGlossary);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
