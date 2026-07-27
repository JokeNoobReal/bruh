// glossary.js — Kho thuật ngữ 2 tầng cho từng bộ truyện
// Tầng bất biến: tên riêng / địa danh / thuật ngữ (khóa cứng, chương nào cũng như nhau)
// Tầng động:    xưng hô theo cặp nhân vật, tiến hóa theo cốt truyện

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const GLOSSARY_DIR = path.join(process.cwd(), 'data', 'glossary');

/** Chuẩn hóa tên bộ truyện thành tên file an toàn */
export function slugify(seriesName) {
  const s = String(seriesName || '').trim().toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')  // bỏ dấu tiếng Việt
    .replace(/đ/g, 'd')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return s || 'untitled';
}

function emptyGlossary(seriesName) {
  return {
    series: seriesName,
    version: 1,
    updatedAt: null,
    lastChapter: 0,
    // TẦNG BẤT BIẾN
    terms: {
      characters: [],  // { en, vi, note, locked }
      places:     [],
      terms:      []
    },
    // TẦNG ĐỘNG — key "A→B" (một chiều, vì A gọi B khác B gọi A)
    // { "Kane→Elis": { history: [ {fromChapter, self, other, stage, trigger, locked} ] } }
    address: {}
  };
}

function filePath(seriesName) {
  return path.join(GLOSSARY_DIR, `${slugify(seriesName)}.json`);
}

/** Đọc glossary. Chưa có thì trả về bản rỗng. */
export async function loadGlossary(seriesName) {
  try {
    const raw = await fs.readFile(filePath(seriesName), 'utf-8');
    const data = JSON.parse(raw);
    return { ...emptyGlossary(seriesName), ...data };
  } catch (err) {
    if (err.code === 'ENOENT') return emptyGlossary(seriesName);
    throw new Error(`Glossary hỏng (${seriesName}): ${err.message}`);
  }
}

/** Ghi glossary an toàn: ghi file tạm rồi rename, tránh mất dữ liệu khi crash giữa chừng */
export async function saveGlossary(seriesName, glossary) {
  await fs.mkdir(GLOSSARY_DIR, { recursive: true });
  const target = filePath(seriesName);
  const tmp = `${target}.tmp`;
  const payload = { ...glossary, series: seriesName, updatedAt: new Date().toISOString() };
  await fs.writeFile(tmp, JSON.stringify(payload, null, 2), 'utf-8');
  await fs.rename(tmp, target);
  return payload;
}

/**
 * TRUY VẤN QUAN TRỌNG NHẤT:
 * Lấy trạng thái xưng hô ĐANG HIỆU LỰC tại một chương cụ thể.
 * Dịch chương 30 thì chỉ nạp mốc mới nhất <= 30, không nạp cả lịch sử.
 */
export function resolveAddressAt(glossary, chapter) {
  const result = {};
  for (const [pair, entry] of Object.entries(glossary.address || {})) {
    const applicable = (entry.history || [])
      .filter(h => Number(h.fromChapter) <= Number(chapter))
      .sort((a, b) => a.fromChapter - b.fromChapter);
    if (applicable.length) {
      result[pair] = applicable[applicable.length - 1];
    }
  }
  return result;
}

/**
 * Ghi một mốc chuyển giai đoạn xưng hô.
 * Bỏ qua nếu mốc hiện hành đã bị người dùng khóa tay (locked).
 */
export function setAddressStage(glossary, pair, { fromChapter, self, other, stage, trigger }) {
  if (!glossary.address[pair]) glossary.address[pair] = { history: [] };
  const hist = glossary.address[pair].history;

  const current = hist.filter(h => h.fromChapter <= fromChapter).pop();
  if (current?.locked) return { changed: false, reason: 'locked' };

  // Không đổi gì thì đừng tạo mốc rác
  if (current && current.self === self && current.other === other) {
    return { changed: false, reason: 'unchanged' };
  }

  // Ghi đè nếu đã có mốc đúng chương đó
  const existingIdx = hist.findIndex(h => h.fromChapter === fromChapter);
  const record = { fromChapter, self, other, stage: stage || '', trigger: trigger || '' };
  if (existingIdx >= 0) hist[existingIdx] = { ...hist[existingIdx], ...record };
  else hist.push(record);

  hist.sort((a, b) => a.fromChapter - b.fromChapter);
  return { changed: true, from: current || null, to: record };
}

/** Thêm thuật ngữ tầng bất biến. Đã tồn tại thì giữ bản cũ (ưu tiên tính nhất quán). */
export function addTerm(glossary, kind, { en, vi, note }) {
  const bucket = glossary.terms[kind];
  if (!bucket) throw new Error(`Loại thuật ngữ không hợp lệ: ${kind}`);
  const key = String(en || '').trim().toLowerCase();
  if (!key) return { added: false };

  const found = bucket.find(t => t.en.trim().toLowerCase() === key);
  if (found) {
    if (found.vi !== vi && !found.locked) {
      return { added: false, conflict: { en, existing: found.vi, proposed: vi } };
    }
    return { added: false };
  }
  bucket.push({ en: en.trim(), vi: String(vi || '').trim(), note: note || '', locked: false });
  return { added: true };
}

/** Xuất glossary thành text để nhét vào prompt. Chỉ lấy phần hiệu lực tại chương đang dịch. */
export function renderForPrompt(glossary, chapter) {
  const { characters, places, terms } = glossary.terms;
  const lines = [];

  const table = (title, rows) => {
    if (!rows.length) return;
    lines.push(`═══ ${title} ═══`);
    for (const r of rows) lines.push(`| ${r.en} | ${r.vi} |${r.note ? ` ${r.note}` : ''}`);
    lines.push('');
  };

  table('📋 TÊN NHÂN VẬT (BẮT BUỘC DÙNG ĐÚNG)', characters);
  table('🗺️ ĐỊA DANH', places);
  table('⚔️ THUẬT NGỮ', terms);

  const active = resolveAddressAt(glossary, chapter);
  const pairs = Object.entries(active);
  if (pairs.length) {
    lines.push(`═══ 💬 XƯNG HÔ HIỆU LỰC TẠI CHƯƠNG ${chapter} ═══`);
    for (const [pair, s] of pairs) {
      lines.push(`| ${pair} | ${s.self} - ${s.other} |${s.stage ? ` (${s.stage})` : ''}`);
    }
    lines.push('⚠️ Giữ nguyên các cặp xưng hô trên xuyên suốt. KHÔNG tự ý đổi.');
    lines.push('');
  }

  return lines.join('\n').trim();
}
