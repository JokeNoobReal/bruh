// services/glossary-routes.js — Express Router cho Sổ Thuật Ngữ với Tenant Isolation & Strict Field Validation
import express from 'express';
import fs from 'fs/promises';
import path from 'path';
import {
  loadGlossary, saveGlossary, withLock, deriveSeriesId
} from './glossary.js';

const router = express.Router();
const DIR = path.join(process.cwd(), 'data', 'glossary');

function tenantSeriesId(req, rawId) {
  const tenant = String(req.tenantId || 'default')
    .replace(/[^a-zA-Z0-9_-]/g, '')
    .slice(0, 32);

  const series = deriveSeriesId(rawId);
  return `${tenant}__${series}`;
}

// GET /api/glossary — Danh sách các bộ truyện thuộc Tenant này
router.get('/', async (req, res) => {
  try {
    const tenantPrefix = String(req.tenantId || 'default').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32) + '__';
    const files = await fs.readdir(DIR).catch(() => []);
    const list = [];

    for (const f of files.filter(f => f.endsWith('.json') && f.startsWith(tenantPrefix))) {
      try {
        const raw = await fs.readFile(path.join(DIR, f), 'utf-8');
        const g = JSON.parse(raw);
        list.push({
          seriesId: g.seriesId || f.replace(/\.json$/, '').replace(tenantPrefix, ''),
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

// GET /api/glossary/:id — Lấy sổ theo Tenant
router.get('/:id', (req, res) => {
  try {
    const seriesId = tenantSeriesId(req, req.params.id);
    const g = loadGlossary(seriesId);
    res.json(g);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/glossary/:id/conflicts
router.get('/:id/conflicts', (req, res) => {
  try {
    const seriesId = tenantSeriesId(req, req.params.id);
    const g = loadGlossary(seriesId);
    res.json(g.conflicts || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/glossary/:id/terms/:tid — Cập nhật với Field Whitelist Validation
router.patch('/:id/terms/:tid', async (req, res) => {
  try {
    const seriesId = tenantSeriesId(req, req.params.id);
    const tid = req.params.tid;
    const { vi, type, aliases, note } = req.body;

    if (
      typeof vi !== 'string' ||
      vi.trim().length === 0 ||
      vi.length > 500 ||
      !['character', 'place', 'skill', 'item', 'org', 'title', 'other'].includes(type)
    ) {
      return res.status(400).json({ error: 'Dữ liệu thuật ngữ không hợp lệ' });
    }

    const updatedGlossary = await withLock(seriesId, async () => {
      const g = loadGlossary(seriesId);
      const term = g.terms.find(x => x.id === tid);
      if (!term) return null;

      Object.assign(term, {
        vi: vi.trim(),
        type,
        aliases: Array.isArray(aliases)
          ? aliases.filter(x => typeof x === 'string').slice(0, 20)
          : [],
        note: String(note || '').slice(0, 1000),
        locked: true
      });
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

// POST /api/glossary/:id/terms — Thêm thuật ngữ mới với Whitelist Validation
router.post('/:id/terms', async (req, res) => {
  try {
    const seriesId = tenantSeriesId(req, req.params.id);
    const { en, vi, type = 'other', aliases = [], note = '' } = req.body;
    if (!en || typeof en !== 'string' || !vi || typeof vi !== 'string') {
      return res.status(400).json({ error: 'Thiếu hoặc sai kiểu en hoặc vi' });
    }

    const safeType = ['character', 'place', 'skill', 'item', 'org', 'title', 'other'].includes(type) ? type : 'other';

    const updatedGlossary = await withLock(seriesId, async () => {
      const g = loadGlossary(seriesId);
      const existing = g.terms.find(t => t.en.toLowerCase() === en.trim().toLowerCase());
      if (existing) {
        Object.assign(existing, {
          vi: vi.trim(),
          type: safeType,
          aliases: Array.isArray(aliases) ? aliases.filter(x => typeof x === 'string').slice(0, 20) : [],
          note: String(note || '').slice(0, 1000),
          locked: true
        });
      } else {
        g.terms.push({
          id: 't_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
          en: en.trim().slice(0, 300),
          vi: vi.trim().slice(0, 500),
          type: safeType,
          aliases: Array.isArray(aliases) ? aliases.filter(x => typeof x === 'string').slice(0, 20) : [],
          note: String(note || '').slice(0, 1000),
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

// DELETE /api/glossary/:id/terms/:tid
router.delete('/:id/terms/:tid', async (req, res) => {
  try {
    const seriesId = tenantSeriesId(req, req.params.id);
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
