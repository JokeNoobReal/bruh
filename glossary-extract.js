// glossary-extract.js — Cập nhật sổ thuật ngữ sau mỗi chương
// Chạy SAU khi đã dịch xong. Không tự gọi API: nhận hàm callAI từ ngoài
// nên cắm streamAIWithRotation sẵn có vào là chạy, khỏi đụng key-pool.

import { resolveAddressAt, setAddressStage, addTerm } from './glossary.js';

/** Bóc JSON ra khỏi phản hồi AI (kể cả khi bị bọc ```json hoặc lẫn chữ thừa) */
function parseJsonLoose(raw) {
  if (!raw) return null;
  let t = String(raw).trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  const s = t.indexOf('{');
  const e = t.lastIndexOf('}');
  if (s === -1 || e === -1 || e <= s) return null;
  try { return JSON.parse(t.slice(s, e + 1)); } catch { return null; }
}

const EXTRACT_PROMPT = `Bạn là Thư Ký Biên Tập, phụ trách duy trì SỔ THUẬT NGỮ của một bộ truyện dài.

Bạn nhận: nguyên tác tiếng Anh của 1 chương, bản dịch tiếng Việt của chương đó, và SỔ THUẬT NGỮ HIỆN CÓ.

NHIỆM VỤ:
A. Tìm tên riêng / địa danh / thuật ngữ XUẤT HIỆN LẦN ĐẦU (chưa có trong sổ). Bỏ qua thứ đã có.
B. Xác định các cặp nhân vật ĐỔI CÁCH XƯNG HÔ trong chương này.

QUY TẮC TỐI QUAN TRỌNG VỀ MỤC B:
1. Xưng hô chỉ đổi khi có SỰ KIỆN CỤ THỂ trong chương làm quan hệ chuyển giai đoạn
   (kết bạn, phản bội, thổ lộ, cùng vào sinh ra tử, biết thân phận thật...).
2. TUYỆT ĐỐI KHÔNG báo đổi chỉ vì bạn thấy cách xưng hô khác "hay hơn" hoặc "tự nhiên hơn".
   Không có sự kiện => KHÔNG đổi. Giữ nguyên là lựa chọn mặc định và đúng đắn.
3. Xưng hô có tính MỘT CHIỀU: "Kane→Elis" và "Elis→Kane" là hai mục riêng, có thể khác nhau
   (ví dụ một bên đã thân, bên kia còn giữ khoảng cách).
4. Mỗi thay đổi BẮT BUỘC nêu "trigger" là tình tiết có thật trong chương. Không bịa.
5. Cặp nào chưa có trong sổ thì đây là lần thiết lập đầu tiên, ghi trigger là "lần đầu xuất hiện".

CHỈ TRẢ VỀ JSON THUẦN, không giải thích, đúng cấu trúc:
{
  "newTerms": {
    "characters": [{"en":"","vi":"","note":""}],
    "places":     [{"en":"","vi":"","note":""}],
    "terms":      [{"en":"","vi":"","note":""}]
  },
  "addressChanges": [
    {"from":"Kane","to":"Elis","self":"tao","other":"mày","stage":"bạn thân","trigger":"cùng sống sót khỏi hầm ngục"}
  ]
}`;

/**
 * @param {object}   glossary   - object từ loadGlossary()
 * @param {number}   chapter    - số chương vừa dịch
 * @param {string}   sourceText - nguyên tác tiếng Anh
 * @param {string}   translated - bản dịch tiếng Việt
 * @param {function} callAI     - async (messages, opts) => string
 */
export async function updateGlossaryFromChapter(glossary, chapter, sourceText, translated, callAI, options = {}) {
  const report = { newTerms: [], addressChanges: [], conflicts: [], skipped: [], error: null };

  const known = {
    characters: glossary.terms.characters.map(t => `${t.en} = ${t.vi}`),
    places:     glossary.terms.places.map(t => `${t.en} = ${t.vi}`),
    terms:      glossary.terms.terms.map(t => `${t.en} = ${t.vi}`),
    address:    Object.entries(resolveAddressAt(glossary, chapter))
                  .map(([pair, s]) => `${pair}: ${s.self} - ${s.other} (${s.stage || 'chưa rõ'})`)
  };

  // Chương dài thì lấy đầu + cuối: tên riêng hay ra ở đầu, chuyển biến quan hệ hay ở cuối
  const clip = (txt, n = 9000) => txt.length <= n
    ? txt
    : `${txt.slice(0, Math.floor(n * 0.45))}\n\n[...lược phần giữa...]\n\n${txt.slice(-Math.floor(n * 0.55))}`;

  let raw;
  try {
    raw = await callAI([
      { role: 'system', content: EXTRACT_PROMPT },
      { role: 'user', content:
`=== SỔ THUẬT NGỮ HIỆN CÓ ===
Nhân vật: ${known.characters.join(' | ') || '(trống)'}
Địa danh: ${known.places.join(' | ') || '(trống)'}
Thuật ngữ: ${known.terms.join(' | ') || '(trống)'}
Xưng hô đang hiệu lực: ${known.address.join(' | ') || '(trống)'}

=== NGUYÊN TÁC CHƯƠNG ${chapter} (EN) ===
${clip(sourceText)}

=== BẢN DỊCH CHƯƠNG ${chapter} (VI) ===
${clip(translated)}

=== JSON:` }
    ], { temperature: 0, fallbackModel: options.fallbackModel });
  } catch (err) {
    report.error = `Không gọi được AI: ${err.message}`;
    return report;   // Lỗi ở bước này KHÔNG được làm hỏng bản dịch
  }

  const data = parseJsonLoose(raw);
  if (!data) {
    report.error = 'AI trả về JSON không hợp lệ, bỏ qua cập nhật sổ.';
    return report;
  }

  // --- Tầng bất biến ---
  for (const kind of ['characters', 'places', 'terms']) {
    for (const item of data.newTerms?.[kind] || []) {
      if (!item?.en || !item?.vi) continue;
      const r = addTerm(glossary, kind, item);
      if (r.added) report.newTerms.push(`${item.en} → ${item.vi}`);
      else if (r.conflict) report.conflicts.push(r.conflict);
    }
  }

  // --- Tầng động ---
  for (const c of data.addressChanges || []) {
    if (!c?.from || !c?.to || !c?.self || !c?.other) continue;
    const pair = `${c.from}→${c.to}`;

    // Chốt chặn: đổi mà không nêu được tình tiết => coi như model tự ý, bỏ qua
    const hasHistory = (glossary.address[pair]?.history || []).length > 0;
    if (hasHistory && (!c.trigger || c.trigger.trim().length < 8)) {
      report.skipped.push(`${pair}: đổi xưng hô nhưng không nêu được tình tiết, đã bỏ qua`);
      continue;
    }

    const r = setAddressStage(glossary, pair, {
      fromChapter: chapter, self: c.self, other: c.other,
      stage: c.stage, trigger: c.trigger
    });

    if (r.changed) {
      const before = r.from ? `${r.from.self}-${r.from.other}` : 'chưa có';
      report.addressChanges.push(`${pair}: ${before} → ${c.self}-${c.other} (${c.trigger})`);
    } else if (r.reason === 'locked') {
      report.skipped.push(`${pair}: bạn đã khóa tay, giữ nguyên`);
    }
  }

  glossary.lastChapter = Math.max(glossary.lastChapter || 0, Number(chapter) || 0);
  return report;
}
