import 'dotenv/config';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import multer from 'multer';
import { execFile, spawn } from 'child_process';
import fs from 'fs';
import rateLimit from 'express-rate-limit';
import axios from 'axios';
import * as cheerio from 'cheerio';

import * as G from './services/glossary.js';
import glossaryRoutes from './services/glossary-routes.js';
import { streamAIWithRotation, callAIQuiet, getAIClient } from './services/ai.js';
import { fetchTextFromUrl, fetchMultipleUrls, fetchPairSamples, validateResolvedHost } from './services/scraper.js';
import { requireApiAuth, configureCors } from './services/auth.js';
import { startAutoCleanupCron } from './services/cleanup.js';
import { ocrWorker, warmupOcrWorker } from './services/ocr-worker.js';

import { assertPromptBudget, buildTranslationMessages, buildReviewMessages } from './services/prompt-guard.js';
import { budgetMiddleware, validateUploadBytes, securityHeadersMiddleware } from './services/security.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(securityHeadersMiddleware);
app.use(configureCors());
app.use(express.json({ limit: '50mb' }));

// Liveness & Readiness Probes (OWASP ASVS V13.1.1)
app.get('/healthz', (req, res) => {
  res.status(200).json({ status: 'ok', uptime: process.uptime(), timestamp: new Date().toISOString() });
});

app.get('/readyz', (req, res) => {
  const ocrReady = ocrWorker && ocrWorker.proc && !ocrWorker.proc.killed;
  res.status(ocrReady ? 200 : 503).json({
    status: ocrReady ? 'ready' : 'degraded',
    ocrWorkerReady: Boolean(ocrReady),
    timestamp: new Date().toISOString()
  });
});

const limiter = rateLimit({ windowMs: 60 * 1000, max: 100, message: { error: 'Quá nhiều request. Vui lòng chờ 1 phút.' } });
app.use('/api/', limiter);
app.use('/api/', requireApiAuth);
app.use('/api/translate-stream', budgetMiddleware);
app.use('/api/chat-minimax', budgetMiddleware);
app.use('/api/glossary', glossaryRoutes);
app.use(express.static(path.join(__dirname, 'public')));

// Đảm bảo thư mục uploads và public tồn tại
if (!fs.existsSync('uploads')) fs.mkdirSync('uploads');
if (!fs.existsSync('public')) fs.mkdirSync('public');

startAutoCleanupCron();
warmupOcrWorker();

const ALLOWED_MODELS = new Set([
  'deepseek/deepseek-v4-pro',
  'deepseek/deepseek-v4-flash',
  'minimax/minimax-m3',
  'nvidia/nemotron'
]);

const upload = multer({
  dest: 'uploads/',
  limits: { fileSize: 10 * 1024 * 1024, files: 8, fields: 20 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Chỉ chấp nhận file ảnh!'), false);
  }
});

async function validateUploadedFiles(files = []) {
  for (const file of files) {
    const bytes = await fs.promises.readFile(file.path);
    validateUploadBytes(bytes, file.mimetype);
  }
}

// Global Process Fatal Error Handlers (Fail Fast & Restart)
process.on('uncaughtException', (err) => {
  console.error('[fatal]', err);
  process.exit(1);
});

process.on('unhandledRejection', (err) => {
  console.error('[fatal-promise]', err);
  process.exit(1);
});

function cleanDuplicateTranslation(text) {
  if (!text || text.length < 500) return text;

  const len = text.length;
  const halfLen = Math.floor(len / 2);
  const firstHalf = text.substring(0, halfLen).trim();
  const secondHalf = text.substring(halfLen).trim();

  if (firstHalf.length > 300 && secondHalf.startsWith(firstHalf.substring(0, 200))) {
    console.warn("⚠️ Phát hiện bản dịch bị lặp lại 2 lần trong 1 phản hồi. Đã tự động cắt bớt đoạn lặp trùng!");
    return firstHalf;
  }

  const lines = text.split('\n\n');
  if (lines.length >= 4) {
    const halfIndex = Math.floor(lines.length / 2);
    const firstPart = lines.slice(0, halfIndex).join('\n\n');
    const secondPart = lines.slice(halfIndex).join('\n\n');
    if (firstPart.length > 300 && secondPart.startsWith(firstPart.substring(0, 200))) {
      console.warn("⚠️ Phát hiện các đoạn lặp trùng nhau trong 1 tập tin. Đã cắt bớt!");
      return firstPart;
    }
  }

  return text;
}

function splitTextIntoChunks(text, maxChars = 7000) {
  if (!text || text.length <= maxChars) return [text];

  const paragraphs = text.split('\n\n');
  const chunks = [];
  let currentChunk = '';

  for (const p of paragraphs) {
    if ((currentChunk + '\n\n' + p).length > maxChars && currentChunk.length > 0) {
      chunks.push(currentChunk.trim());
      currentChunk = p;
    } else {
      currentChunk += (currentChunk ? '\n\n' : '') + p;
    }
  }
  if (currentChunk.trim()) {
    chunks.push(currentChunk.trim());
  }
  return chunks;
}

// ==========================================
// API 1: DỊCH TRUYỆN CHỮ — QUY TRÌNH 5 GIAI ĐOẠN CHUYÊN NGHIỆP
// ==========================================
app.post('/api/translate-stream', async (req, res) => {
  const {
    urlsSampleEn, urlsSampleVi, urlNewEn, userInstructions,
    translateModel, reviewModel, fallbackModel,
    seriesName, chapterNumber, seriesId: inputSeriesId, chapter: inputChapter
  } = req.body;

  if (!urlsSampleEn || !urlsSampleVi || !urlNewEn) {
    return res.status(400).json({ error: 'Thiếu dữ liệu đầu vào!' });
  }

  if (![translateModel, reviewModel, fallbackModel]
    .filter(Boolean)
    .every(model => ALLOWED_MODELS.has(model))) {
    return res.status(400).json({ error: 'Model không được hỗ trợ' });
  }

  const MODEL_TRANSLATE = translateModel || 'deepseek/deepseek-v4-pro';
  const MODEL_REVIEW    = reviewModel    || 'minimax/minimax-m3';
  const MODEL_FALLBACK  = fallbackModel  || 'deepseek/deepseek-v4-flash';

  const abortController = new AbortController();
  req.on('close', () => {
    if (!res.writableEnded) abortController.abort();
  });

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  const sendNewBox = (title, colorClass) => {
    if (!res.writableEnded) {
      res.write(`data: ${JSON.stringify({ type: 'new_box', title, colorClass })}\n\n`);
      if (typeof res.flush === 'function') res.flush();
    }
  };
  const sendChunk = (text) => {
    if (!res.writableEnded) {
      res.write(`data: ${JSON.stringify({ type: 'chunk', data: text })}\n\n`);
      if (typeof res.flush === 'function') res.flush();
    }
  };
  const sendStatus = (text) => {
    if (!res.writableEnded) {
      res.write(`data: ${JSON.stringify({ type: 'status', data: text })}\n\n`);
      if (typeof res.flush === 'function') res.flush();
    }
  };

  const callAI = (messages, opts = {}) =>
    streamAIWithRotation(MODEL_REVIEW, messages, null, {
      temperature: opts.temperature ?? 0,
      fallbackModel: MODEL_FALLBACK,
      signal: abortController.signal
    });

  let currentDraft = "";

  try {
    sendStatus('🔍 Đang kiểm tra an toàn URL và bóc tách nội dung...');
    await validateResolvedHost(urlNewEn);

    const [sampleEnCombined, sampleViCombined, newEnText] = await Promise.all([
      fetchMultipleUrls(urlsSampleEn, 6000),
      fetchMultipleUrls(urlsSampleVi, 6000),
      fetchTextFromUrl(urlNewEn)
    ]);

    assertPromptBudget({
      source: newEnText,
      samplesEn: sampleEnCombined,
      samplesVi: sampleViCombined,
      notes: userInstructions
    });

    if (!newEnText || newEnText.length < 50) {
      sendChunk("❌ Lỗi: Không lấy được nội dung văn bản từ URL chương mới. Vui lòng kiểm tra lại link.");
      return res.end();
    }

    const seriesId = inputSeriesId || G.deriveSeriesId(seriesName || urlNewEn);
    const chapter = inputChapter || G.extractChapterNum(chapterNumber || urlNewEn);
    const g = G.loadGlossary(seriesId);

    if (urlsSampleEn.length > 0 && urlsSampleVi.length > 0 && g.terms.length === 0) {
      try {
        const pairs = await fetchPairSamples(urlsSampleEn, urlsSampleVi, 5000);
        if (pairs.en && pairs.vi) {
          sendStatus('🌱 Lần đầu tiên dịch bộ này: Đang tự động tạo Sổ Thuật Ngữ ban đầu...');
          const initTerms = await G.extractInitialTerms(callAI, pairs.en, pairs.vi);
          G.mergeTerms(g, initTerms, 0);
          await G.saveGlossary(g);
        }
      } catch (e) {
        console.warn(`⚠️ Lỗi khởi tạo từ cặp mẫu: ${e.message}`);
      }
    }

    const { terms, honorifics } = G.selectRelevant(g, newEnText);
    const glossaryBlock = G.renderGlossary(terms, honorifics, g.styleNotes);

    // ==========================================
    // GĐ 1: CHUẨN BỊ & NGHIÊN CỨU
    // ==========================================
    sendStatus('📚 GIAI ĐOẠN 1/5: Chuẩn bị & Nghiên cứu...');
    sendNewBox(`📚 GĐ 1: Chuẩn bị & Nghiên cứu (${MODEL_REVIEW})`, "color-gd1");

    const stage1Messages = buildTranslationMessages({
      source: newEnText,
      samplesEn: sampleEnCombined,
      samplesVi: sampleViCombined,
      notes: userInstructions,
      glossary: glossaryBlock,
      chunkLabel: 'stage1_preparation_source'
    });
    stage1Messages[0].content += '\nAnalyze author style, tone, and character honorifics to build an editorial guide.';

    const styleGuide = await streamAIWithRotation(
      MODEL_REVIEW,
      stage1Messages,
      (chunk) => sendChunk(chunk),
      { temperature: 0.2, fallbackModel: MODEL_FALLBACK, signal: abortController.signal }
    );

    // ==========================================
    // GĐ 2: DỊCH THÔ
    // ==========================================
    sendStatus('✍️ GIAI ĐOẠN 2/5: Dịch Thô...');
    sendNewBox(`✍️ GĐ 2: Dịch Thô (${MODEL_TRANSLATE})`, "color-gd2");
    const enChunks = splitTextIntoChunks(newEnText, 6500);

    if (enChunks.length > 24) {
      sendChunk("❌ Chương vượt quá giới hạn 24 chunk cho phép.");
      return res.end();
    }

    const draftChunks = [];

    for (let i = 0; i < enChunks.length; i++) {
      if (abortController.signal.aborted) break;

      if (enChunks.length > 1) {
        sendStatus(`✍️ GĐ 2: Đang dịch thô phần ${i + 1}/${enChunks.length}...`);
      }

      const prevTail = i > 0 && draftChunks[i - 1] ? draftChunks[i - 1].slice(-400) : '';
      const continuityBlock = prevTail
        ? `ĐUÔI BẢN DỊCH TRƯỚC, chỉ dùng để nối mạch:\n${prevTail}`
        : '';

      const isSubsequentChunk = i > 0;
      let titleChecked = !isSubsequentChunk;
      let headerBuffer = "";

      const stage2Messages = buildTranslationMessages({
        source: enChunks[i],
        samplesEn: sampleEnCombined,
        samplesVi: sampleViCombined,
        notes: [userInstructions, continuityBlock].filter(Boolean).join('\n\n'),
        glossary: glossaryBlock,
        styleGuide,
        chunkLabel: `chapter_chunk_${i + 1}`
      });
      if (isSubsequentChunk) {
        stage2Messages[0].content += `\nThis is continuation chunk ${i + 1}/${enChunks.length}. Do not repeat chapter title or introduction. Continue smoothly.`;
      }

      const chunkText = await streamAIWithRotation(
        MODEL_TRANSLATE,
        stage2Messages,
        (content) => {
          if (isSubsequentChunk && !titleChecked) {
            headerBuffer += content;
            if (headerBuffer.includes('\n') || headerBuffer.length > 80) {
              const cleanedHeader = headerBuffer.replace(/^(Chương|Chapter)\s+\d+[:\s][^\n]+\n+/i, '');
              sendChunk(cleanedHeader);
              titleChecked = true;
            }
          } else {
            sendChunk(content);
          }
        },
        { temperature: 0.3, fallbackModel: MODEL_FALLBACK, signal: abortController.signal }
      );

      if (isSubsequentChunk && !titleChecked && headerBuffer) {
        const cleanedHeader = headerBuffer.replace(/^(Chương|Chapter)\s+\d+[:\s][^\n]+\n+/i, '');
        sendChunk(cleanedHeader);
      }

      draftChunks.push(chunkText);
      currentDraft += chunkText;
      if (i < enChunks.length - 1) {
        currentDraft += "\n\n";
        sendChunk("\n\n");
      }
    }

    // ==========================================
    // VÒNG LẶP GĐ 3 + GĐ 4
    // ==========================================
    let loopCount = 0;
    const MAX_LOOPS = 3;
    let isApproved = false;
    let previousCritique = "";

    const draftHistory = [{
      version: 'Bản Dịch Thô (GĐ 2)',
      text: currentDraft,
      score: null,
      critique: ''
    }];

    let currentDraftChunks = [...draftChunks];

    while (loopCount < MAX_LOOPS && !isApproved && !abortController.signal.aborted) {
      loopCount++;

      // ==========================================
      // GĐ 3: BIÊN TẬP & ĐỐI CHIẾU
      // ==========================================
      sendStatus(`🔍 GIAI ĐOẠN 3/5: Biên tập & Đối chiếu (Lần ${loopCount})...`);
      sendNewBox(`🔍 GĐ 3: Biên tập & Đối chiếu — Lần ${loopCount} (${MODEL_REVIEW})`, "color-gd3");

      const newEditedChunks = [];

      for (let cIdx = 0; cIdx < enChunks.length; cIdx++) {
        if (abortController.signal.aborted) break;

        if (enChunks.length > 1) {
          sendStatus(`🔍 GĐ 3: Đang biên tập & đối chiếu phần ${cIdx + 1}/${enChunks.length}...`);
        }

        const stage3Messages = buildReviewMessages({
          source: enChunks[cIdx],
          draft: currentDraftChunks[cIdx] || '',
          glossary: glossaryBlock,
          styleGuide,
          critique: previousCritique
        });
        stage3Messages[0].content += `\nEditing chunk ${cIdx + 1}/${enChunks.length}. Preserve exact meaning, fix awkward sentences, and enforce glossary. Return only the edited text.`;

        let editedChunkText = "";
        try {
          editedChunkText = await streamAIWithRotation(
            MODEL_REVIEW,
            stage3Messages,
            (chunk) => sendChunk(chunk),
            { temperature: 0.2, fallbackModel: MODEL_FALLBACK, signal: abortController.signal }
          );
        } catch (err) {
          console.warn(`⚠️ GĐ 3 phần ${cIdx + 1} lỗi API: ${err.message}. Giữ nguyên bản dịch thô phần này.`);
          editedChunkText = currentDraftChunks[cIdx] || "";
        }

        if (editedChunkText.trim().length > 100) {
          newEditedChunks.push(cleanDuplicateTranslation(editedChunkText));
        } else {
          newEditedChunks.push(currentDraftChunks[cIdx] || "");
        }

        if (cIdx < enChunks.length - 1) {
          sendChunk("\n\n");
        }
      }

      currentDraftChunks = newEditedChunks;
      currentDraft = currentDraftChunks.join("\n\n");

      draftHistory.push({
        version: `Biên tập Lần ${loopCount} (GĐ 3)`,
        text: currentDraft,
        score: null,
        critique: ''
      });

      // ==========================================
      // GĐ 4: HIỆU ĐÍNH & ĐỌC THỬ
      // ==========================================
      sendStatus(`✅ GIAI ĐOẠN 4/5: Hiệu đính & Đọc thử (Lần ${loopCount})...`);
      sendNewBox(`✅ GĐ 4: Hiệu đính & Đọc thử — Lần ${loopCount} (${MODEL_FALLBACK})`, "color-gd4");

      const stage4Messages = buildReviewMessages({
        source: newEnText,
        draft: currentDraft,
        glossary: glossaryBlock,
        styleGuide,
        critique: previousCritique
      });
      stage4Messages[0].content += '\nAct as proofreader and beta reader. Report score X/10 and verdict [DUYỆT] or [CHƯA ĐẠT].';

      let critique = "";
      try {
        critique = await streamAIWithRotation(
          MODEL_FALLBACK,
          stage4Messages,
          (chunk) => sendChunk(chunk),
          { temperature: 0.1, fallbackModel: MODEL_REVIEW, signal: abortController.signal }
        );
      } catch (err) {
        if (!res.writableEnded) {
          sendChunk(`\n[LỖI HIỆU ĐÍNH: ${err.message}]\n`);
          res.end();
        }
        return;
      }

      previousCritique = critique;

      const scoreMatch = critique.match(/(\d+(?:\.\d+)?)\s*\/\s*10/);
      const extractedScore = scoreMatch ? parseFloat(scoreMatch[1]) : null;

      if (draftHistory.length > 0) {
        draftHistory[draftHistory.length - 1].score = extractedScore;
        draftHistory[draftHistory.length - 1].critique = critique;
      }

      if (critique.includes("[DUYỆT]")) {
        isApproved = true;
        sendStatus(`🎉 ĐÃ DUYỆT sau ${loopCount} vòng biên tập! Chuyển sang Giai đoạn 5 chọn bản tốt nhất...`);
      } else {
        sendStatus(`⚔️ [CHƯA ĐẠT] — Quay lại GĐ 3 biên tập lại (Lần ${loopCount + 1})...`);
      }
    }

    if (!isApproved) {
      sendStatus(`⚠️ Đã qua ${MAX_LOOPS} vòng biên tập. Chuyển sang GĐ 5 chọn bản tốt nhất...`);
    }

    // ==========================================
    // GĐ 5: HOÀN THIỆN & XUẤT BẢN
    // ==========================================
    sendStatus('🏆 GIAI ĐOẠN 5/5: Đánh giá tổng hợp & Chọn bản tốt nhất...');

    const scoredDrafts = draftHistory.filter(d => d.score !== null);
    let bestDraft = currentDraft;

    if (scoredDrafts.length > 1) {
      sendNewBox(`🏅 GĐ 5: Đánh giá tổng hợp — So sánh ${scoredDrafts.length} bản dịch`, "color-gd4");

      let scoreSummary = '📊 BẢNG ĐIỂM CÁC BẢN DỊCH:\n';
      scoredDrafts.forEach((d, idx) => {
        scoreSummary += `\n--- BẢN ${idx + 1}: ${d.version} — Điểm: ${d.score}/10 ---\n`;
      });
      sendChunk(scoreSummary);

      let bestIdx = 0;
      let bestScore = -1;
      scoredDrafts.forEach((d, idx) => {
        if (d.score !== null && d.score > bestScore) {
          bestScore = d.score;
          bestIdx = idx;
        }
      });

      bestDraft = scoredDrafts[bestIdx].text;
      sendChunk(`\n\n🏆 CHỌN: ${scoredDrafts[bestIdx].version} (Điểm: ${bestScore}/10) làm bản chốt hạ!\n`);
      sendStatus(`🏆 Đã chọn ${scoredDrafts[bestIdx].version} (${bestScore}/10) — Bản tốt nhất!`);
    } else if (scoredDrafts.length === 1) {
      bestDraft = scoredDrafts[0].text;
      sendStatus(`🏆 Chỉ có 1 bản được đánh giá (${scoredDrafts[0].score}/10). Dùng bản này.`);
    }

    sendNewBox(`🏆 GĐ 5: BẢN DỊCH HOÀN THIỆN — CHỐT HẠ CUỐI CÙNG`, "color-gd5");
    let finalCleanText = cleanDuplicateTranslation(bestDraft);

    const len = G.checkLength(newEnText, finalCleanText);
    if (!len.ok) {
      sendStatus(`⚠️ CẢNH BÁO: Bản dịch chỉ đạt ${Math.round(len.ratio * 100)}% độ dài gốc — nghi bị tóm tắt / cắt xén nội dung!`);
    }

    const violations = G.auditGlossary(newEnText, finalCleanText, terms);
    if (violations.length > 0) {
      sendStatus(`🔍 Phát hiện ${violations.length} thuật ngữ chưa đúng Glossary. Đang tự động sửa cứng...`);
      const hard = G.enforceHard(finalCleanText, violations);
      finalCleanText = hard.text;

      if (hard.remaining.length > 0) {
        try {
          finalCleanText = await callAIQuiet(MODEL_REVIEW, [
            { role: 'system', content: G.buildFixPrompt(hard.remaining) },
            { role: 'user', content: finalCleanText }
          ], { temperature: 0.1, fallbackModel: MODEL_FALLBACK, signal: abortController.signal });
        } catch (e) {
          console.warn(`⚠️ Không sửa được thuật ngữ dư: ${e.message}`);
        }
      }
      sendStatus(`🔧 Đã ép đúng ${violations.length} thuật ngữ/tên riêng theo Glossary.`);
    }

    sendChunk(finalCleanText);

    sendStatus('📝 Đang học thuật ngữ mới từ chương này...');
    try {
      const ex = await G.extractTerms(callAI, g, newEnText, finalCleanText);
      const { added, conflicts } = G.mergeTerms(g, ex.newTerms, chapter);
      G.mergeHonorifics(g, ex.honorificProposals, chapter);
      g.lastChapter = Math.max(g.lastChapter || 0, chapter);
      await G.saveGlossary(g);

      sendStatus(`📚 Glossary cập nhật: +${added.length} mục mới, ${conflicts.length} xung đột ghi log.`);
    } catch (e) {
      console.warn(`⚠️ Lỗi cập nhật sổ thuật ngữ: ${e.message}`);
    }

    res.end();
  } catch (error) {
    if (error.name !== 'AbortError' && !error.message.includes('aborted')) {
      if (currentDraft && currentDraft.length > 100) {
        sendNewBox('⚠️ BẢN DỊCH KHÔI PHỤC (do lỗi giữa chừng)', 'color-gd5');
        sendChunk(currentDraft);
      }
      if (!res.writableEnded) res.write(`data: ${JSON.stringify({ type: 'error', data: error.message })}\n\n`);
    }
    res.end();
  }
});

// ==========================================
// API TRÒ CHUYỆN TRỰC TIẾP VỚI MINIMAX
// ==========================================
app.post('/api/chat-minimax', async (req, res) => {
  const { userMessage, styleGuide, conversationHistory, reviewModel, fallbackModel } = req.body;

  const safeMessage = String(userMessage || '').slice(0, 12000);
  const safeGuide = String(styleGuide || '').slice(0, 30000);

  if (!safeMessage.trim()) {
    return res.status(400).json({ error: 'Tin nhắn rỗng' });
  }

  const history = Array.isArray(conversationHistory)
    ? conversationHistory.slice(-20)
    : [];

  const MODEL_REVIEW = ALLOWED_MODELS.has(reviewModel)
    ? reviewModel
    : 'minimax/minimax-m3';
  const MODEL_FALLBACK = fallbackModel || 'deepseek/deepseek-v4-flash';

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');

  const sendChunk = (text) => {
    if (!res.writableEnded) res.write(`data: ${JSON.stringify({ type: 'chunk', data: text })}\n\n`);
  };

  try {
    const messages = [
      {
        role: "system",
        content: `Bạn là Tổng Biên Tập sắc bén, khắt khe và giàu chuyên môn ngôn ngữ học. 
Bộ Quy Tắc Văn Phong Hiện Tại:
${safeGuide || 'Đang thiết lập'}`
      }
    ];

    history.forEach(msg => {
      if (msg && typeof msg === 'object' && msg.role && msg.content) {
        messages.push({
          role: msg.role === 'assistant' ? 'assistant' : 'user',
          content: String(msg.content).slice(0, 8000)
        });
      }
    });

    messages.push({ role: "user", content: safeMessage });

    await streamAIWithRotation(
      MODEL_REVIEW,
      messages,
      (chunk) => sendChunk(chunk),
      { temperature: 0.3, fallbackModel: MODEL_FALLBACK }
    );
    res.end();
  } catch (err) {
    console.error("❌ Lỗi Chat MiniMax:", err.message);
    if (!res.writableEnded) res.write(`data: ${JSON.stringify({ type: 'error', data: err.message })}\n\n`);
    res.end();
  }
});

async function downloadImageFromUrl(imageUrl) {
  let finalUrl = imageUrl.trim();

  const mangadexMatch = finalUrl.match(/mangadex\.org\/chapter\/([a-f0-9\-]+)(?:\/(\d+))?/i);
  if (mangadexMatch) {
    const chapterId = mangadexMatch[1];
    const pageNum = mangadexMatch[2] ? parseInt(mangadexMatch[2], 10) : 1;
    const pageIndex = Math.max(0, pageNum - 1);

    try {
      console.log(`📡 Đang gọi MangaDex API cho Chapter: ${chapterId}, Trang: ${pageNum}...`);
      const { data: apiData } = await axios.get(`https://api.mangadex.org/at-home/server/${chapterId}`, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
      });

      if (apiData && apiData.baseUrl && apiData.chapter) {
        const baseUrl = apiData.baseUrl;
        const hash = apiData.chapter.hash;
        const pages = apiData.chapter.data || [];

        if (pages.length > 0) {
          const targetFilename = pages[pageIndex] || pages[0];
          finalUrl = `${baseUrl}/data/${hash}/${targetFilename}`;
          console.log(`✅ Lấy thành công link ảnh MangaDex trang ${pageNum}: ${finalUrl}`);
        }
      }
    } catch (mdErr) {
      console.warn("⚠️ Không lấy được ảnh qua MangaDex API, fallback sang cào HTML:", mdErr.message);
    }
  }

  if (!finalUrl.match(/\.(jpeg|jpg|png|webp)(\?.*)?$/i)) {
    try {
      const { data } = await axios.get(finalUrl, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } });
      const $ = cheerio.load(data);
      let imgSrc = $('.reading-content img').first().attr('src') ||
                   $('.chapter-image img').first().attr('src') ||
                   $('article img').first().attr('src') ||
                   $('main img').first().attr('src') ||
                   $('img').first().attr('src');
      if (imgSrc) {
        if (imgSrc.startsWith('//')) imgSrc = 'https:' + imgSrc;
        else if (imgSrc.startsWith('/')) {
          const parsed = new URL(finalUrl);
          imgSrc = parsed.origin + imgSrc;
        }
        finalUrl = imgSrc;
      }
    } catch (e) {
      console.warn("Không parse được HTML trang web, thử tải trực tiếp link:", e.message);
    }
  }

  const response = await axios.get(finalUrl, {
    responseType: 'arraybuffer',
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
  });

  const ext = finalUrl.match(/\.(png|webp)/i) ? '.png' : '.jpg';
  const tempPath = path.join('uploads', `url_comic_${Date.now()}${ext}`);
  await fs.promises.writeFile(tempPath, response.data);
  return tempPath;
}

async function downloadAllChapterImages(chapterUrl, progressCallback = null) {
  let finalUrl = chapterUrl.trim();
  let imagePaths = [];

  const mangadexMatch = finalUrl.match(/mangadex\.org\/chapter\/([a-f0-9\-]+)(?:\/(\d+))?/i);
  if (mangadexMatch) {
    const chapterId = mangadexMatch[1];
    const specificPage = mangadexMatch[2] ? parseInt(mangadexMatch[2], 10) : null;

    try {
      console.log(`📡 Đang gọi MangaDex API cho Chapter: ${chapterId}...`);
      const { data: apiData } = await axios.get(`https://api.mangadex.org/at-home/server/${chapterId}`, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
      });

      if (apiData && apiData.baseUrl && apiData.chapter) {
        const baseUrl = apiData.baseUrl;
        const hash = apiData.chapter.hash;
        const pages = apiData.chapter.data || [];

        if (specificPage && specificPage <= pages.length) {
          const targetFilename = pages[specificPage - 1];
          const imgUrl = `${baseUrl}/data/${hash}/${targetFilename}`;
          if (progressCallback) progressCallback(1, 1);
          const res = await axios.get(imgUrl, { responseType: 'arraybuffer', headers: { 'User-Agent': 'Mozilla/5.0' } });
          const ext = targetFilename.match(/\.(png|webp)/i) ? '.png' : '.jpg';
          const tempPath = path.join('uploads', `md_${Date.now()}_p${specificPage}${ext}`);
          await fs.promises.writeFile(tempPath, res.data);
          return [{ pageIndex: specificPage, path: tempPath }];
        }

        console.log(`📖 Tải TOÀN BỘ ${pages.length} trang của MangaDex Chapter...`);
        for (let i = 0; i < pages.length; i++) {
          const imgUrl = `${baseUrl}/data/${hash}/${pages[i]}`;
          try {
            const res = await axios.get(imgUrl, { responseType: 'arraybuffer', headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } });
            const ext = pages[i].match(/\.(png|webp)/i) ? '.png' : '.jpg';
            const tempPath = path.join('uploads', `md_${Date.now()}_p${i + 1}${ext}`);
            await fs.promises.writeFile(tempPath, res.data);
            imagePaths.push({ pageIndex: i + 1, path: tempPath });
          } catch (pErr) {
            console.warn(`Lỗi tải trang ${i + 1}:`, pErr.message);
          }
        }
        return imagePaths;
      }
    } catch (mdErr) {
      console.warn("⚠️ Không lấy được trang qua MangaDex API:", mdErr.message);
    }
  }

  const singlePath = await downloadImageFromUrl(finalUrl);
  return [{ pageIndex: 1, path: singlePath }];
}

// ==========================================
// API 2: GỌI PYTHON XỬ LÝ TRUYỆN TRANH
// ==========================================
app.post('/api/translate-comic', upload.array('image', 8), async (req, res, next) => {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');

  const sendEvent = (type, data) => {
    if (!res.writableEnded) {
      res.write(`data: ${JSON.stringify({ type, data })}\n\n`);
      if (typeof res.flush === 'function') res.flush();
    }
  };

  const files = req.files || [];

  try {
    if (files.length > 8) {
      return res.status(413).json({ error: 'Tối đa 8 ảnh' });
    }

    const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
    if (totalBytes > 50 * 1024 * 1024) {
      return res.status(413).json({ error: 'Tổng dung lượng quá lớn' });
    }

    if (files.length > 0) {
      await validateUploadedFiles(files);
    }

    const MAX_OCR_QUEUE = Number(process.env.MAX_OCR_QUEUE || 4);
    if (ocrWorker.queue && ocrWorker.queue.length >= MAX_OCR_QUEUE) {
      return res.status(429).json({ error: 'OCR đang quá tải, thử lại sau' });
    }

    let imagesToProcess = files.map((f, idx) => ({ pageIndex: idx + 1, path: f.path }));
    const sourceLang = req.body.sourceLang || 'en';
    const userInstructions = String(req.body.userInstructions || '').slice(0, 12000);
    const allowedLangs = ['en', 'ja', 'ko', 'zh'];
    const lang = allowedLangs.includes(sourceLang) ? sourceLang : 'en';

    if (req.body.imageUrl) {
      sendEvent('status', '📡 Đang kiểm tra URL và bóc tách trang...');
      await validateResolvedHost(req.body.imageUrl);
      const downloaded = await downloadAllChapterImages(req.body.imageUrl.trim(), (current, total) => {
        sendEvent('status', `📥 Đang tải ảnh Chapter: Trang ${current}/${total}...`);
      });
      imagesToProcess = imagesToProcess.concat(downloaded);
    }

    if (!imagesToProcess || imagesToProcess.length === 0) {
      sendEvent('error', 'Vui lòng chọn file ảnh hoặc dán link chapter truyện tranh!');
      return res.end();
    }

    const allPaths = imagesToProcess.map(img => img.path);
    sendEvent('status', `🎨 Đã sẵn sàng. Bắt đầu OCR & Dịch ${imagesToProcess.length} trang truyện tranh...`);

    const results = await ocrWorker.translate({
      images: allPaths,
      lang,
      instructions: userInstructions,
      onStatus: (text) => sendEvent('status', text),
      onPage: (page) => sendEvent('page_done', page),
    });

    sendEvent('finished', `🎉 Đã hoàn tất dịch toàn bộ ${results?.length || imagesToProcess.length} trang!`);
  } catch (err) {
    sendEvent('error', `Lỗi dịch truyện tranh: ${err.message}`);
  } finally {
    if (files.length > 0) {
      await Promise.all(files.map(file => fs.promises.unlink(file.path).catch(() => {})));
    }
    res.end();
  }
});

// Global Express Error Handler (OWASP ASVS V7.1.1 & V12.1.1)
app.use((err, req, res, next) => {
  console.error('[request-error]', {
    method: req.method,
    path: req.path,
    code: err.code,
    message: err.message
  });

  if (res.headersSent) return next(err);

  const status =
    err.code === 'LIMIT_FILE_SIZE' ? 413 :
    err.statusCode || (err.message && err.message.includes('SSRF') ? 403 : 500);

  res.status(status).json({
    error: status >= 500 ? 'Internal server error' : err.message
  });
});

const PORT = 3000;
app.listen(PORT, () => console.log(`🚀 Node.js Server (Bản Multi-Agent Hoàn Hảo) đang chạy tại: http://localhost:${PORT}`));