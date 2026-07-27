import 'dotenv/config';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import multer from 'multer';
import { execFile, spawn } from 'child_process';
import fs from 'fs';
import rateLimit from 'express-rate-limit';

import * as G from './services/glossary.js';
import glossaryRoutes from './services/glossary-routes.js';
import { streamAIWithRotation, callAIQuiet, getAIClient } from './services/ai.js';
import { fetchTextFromUrl, fetchMultipleUrls, fetchPairSamples } from './services/scraper.js';
import { requireApiAuth, configureCors } from './services/auth.js';
import { startAutoCleanupCron } from './services/cleanup.js';
import { ocrWorker, warmupOcrWorker } from './services/ocr-worker.js';

import { assertPromptBudget, buildTranslationMessages, buildReviewMessages } from './services/prompt-guard.js';
import { budgetMiddleware, validateUploadBytes } from './services/security.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(configureCors());
app.use(express.json({ limit: '50mb' }));

const limiter = rateLimit({ windowMs: 60 * 1000, max: 100, message: { error: 'Quá nhiều request. Vui lòng chờ 1 phút.' } });
app.use('/api/', limiter);
app.use('/api/', requireApiAuth);
app.use('/api/translate-stream', budgetMiddleware);
app.use('/api/glossary', glossaryRoutes);
app.use(express.static(path.join(__dirname, 'public')));

// Đảm bảo thư mục uploads và public tồn tại
if (!fs.existsSync('uploads')) fs.mkdirSync('uploads');
if (!fs.existsSync('public')) fs.mkdirSync('public');

// Khởi động cron tự động dọn dẹp file tạm cũ (>1 giờ) định kỳ mỗi 15 phút
startAutoCleanupCron();

// Làm nóng sẵn OCR Worker daemon
warmupOcrWorker();

// Cấu hình thư mục nhận ảnh truyện tranh
const upload = multer({
  dest: 'uploads/',
  limits: { fileSize: 10 * 1024 * 1024, files: 8, fields: 20 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Chỉ chấp nhận file ảnh!'), false);
  }
});

// Validate magic bytes and dimensions after multer writes the temporary file.
async function validateUploadedFiles(files = []) {
  for (const file of files) {
    const bytes = await fs.promises.readFile(file.path);
    validateUploadBytes(bytes, file.mimetype);
  }
}

// Ngăn server bị văng (crash) khi có lỗi không lường trước
process.on('uncaughtException', (err) => console.error("❌ Lỗi hệ thống:", err.message));
process.on('unhandledRejection', (err) => console.error("❌ Lỗi Promise:", err.message));


// Helper làm sạch đoạn trùng lặp trong bản dịch

function cleanDuplicateTranslation(text) {
  if (!text || text.length < 500) return text;
  
  // 1. Kiểm tra lặp nửa đầu và nửa sau
  const len = text.length;
  const halfLen = Math.floor(len / 2);
  const firstHalf = text.substring(0, halfLen).trim();
  const secondHalf = text.substring(halfLen).trim();

  if (firstHalf.length > 300 && secondHalf.startsWith(firstHalf.substring(0, 200))) {
    console.warn("⚠️ Phát hiện bản dịch bị lặp lại 2 lần trong 1 phản hồi. Đã tự động cắt bớt đoạn lặp trùng!");
    return firstHalf;
  }

  // 2. Kiểm tra lặp lại theo dòng/đoạn lớn
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

  const MODEL_TRANSLATE = translateModel || 'deepseek/deepseek-v4-pro';
  const MODEL_REVIEW    = reviewModel    || 'minimax/minimax-m3';
  const MODEL_FALLBACK  = fallbackModel  || 'deepseek/deepseek-v4-flash';
  
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
      temperature: opts.temperature ?? 0, fallbackModel: MODEL_FALLBACK
    });

  const seriesId = inputSeriesId || G.deriveSeriesId(seriesName || urlNewEn);
  const chapter = Number(chapterNumber || inputChapter) || 0;

  let currentDraft = '';

  try {
    await G.withLock(seriesId, async () => {
      sendStatus('📡 Đang cào dữ liệu...');
      const [sampleEnCombined, sampleViCombined, newEnText] = await Promise.all([
        fetchMultipleUrls(urlsSampleEn),
        fetchMultipleUrls(urlsSampleVi),
        fetchTextFromUrl(urlNewEn)
      ]);

      // Guard prompt budget before calling AI models
      assertPromptBudget({ source: newEnText, samplesEn: sampleEnCombined, samplesVi: sampleViCombined, notes: userInstructions });

      if (!newEnText || newEnText.length < 100) {
        sendStatus('❌ Không cào được nội dung chương mới. Kiểm tra lại link!');
        return res.end();
      }
      if (!sampleViCombined || sampleViCombined.length < 50) {
        sendStatus('❌ Không cào được bản mẫu tiếng Việt. Kiểm tra lại link!');
        return res.end();
      }

      // Hiển thị bản gốc
      sendNewBox("📄 Văn bản gốc đã cào (Tiếng Anh)", "color-ds");
      sendChunk(newEnText);
      sendStatus(`✅ Đã cào được ${newEnText.length.toLocaleString()} ký tự. Nạp & Khởi tạo Sổ Thuật Ngữ...`);

      // ── Tải Sổ Thuật Ngữ & Khởi tạo từ Cặp Mẫu nếu là bộ mới
      const g = G.loadGlossary(seriesId);

      if (g.terms.length === 0 && urlsSampleEn && urlsSampleVi) {
        sendStatus('🌱 Đang trích xuất thuật ngữ ban đầu từ các cặp mẫu EN↔VI...');
        try {
          const pairSamples = await fetchPairSamples(urlsSampleEn, urlsSampleVi);
          if (pairSamples.length > 0) {
            await G.seedFromSamples(callAI, g, pairSamples);
            await G.saveGlossary(g);
            sendStatus(`✅ Đã chốt ${g.terms.length} thuật ngữ ban đầu từ bản mẫu người dịch!`);
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
      
      const styleGuide = await streamAIWithRotation(
        MODEL_REVIEW,
        [
          { 
            role: "system", 
            content: `Bạn là Tổng Biên Tập & Chuyên gia Ngôn ngữ học.
Nhiệm vụ: Đọc toàn bộ [BẢN MẪU ANH] và [BẢN MẪU VIỆT], phân tích phong cách tác giả, bối cảnh và lập TÀI LIỆU CHUẨN BỊ DỊCH theo format sau:

═══ 📋 BẢNG THUẬT NGỮ & TÊN RIÊNG ═══
| Tiếng Anh | Tiếng Việt | Ghi chú |
(Liệt kê tất cả tên nhân vật, địa danh, thuật ngữ đặc biệt)

═══ 💬 BẢNG XƯNG HÔ NHÂN VẬT ═══
| Nhân vật A → B | Xưng hô | Lý do |
(Liệt kê cách từng cặp nhân vật xưng hô với nhau)

═══ 🎭 PHONG CÁCH & GIỌNG VĂN ═══
- Giọng người kể chuyện: (deadpan, hài hước, nghiêm túc, mỉa mai...)
- Sắc thái cảm xúc chủ đạo:
- Cách ngắt câu đặc trưng:

═══ 📐 CHIẾN LƯỢC DỊCH ═══
- Phương pháp: (sát nghĩa / thoát ý / kết hợp)
- Yếu tố văn hóa: (giữ nguyên / bản địa hóa)
- Lưu ý đặc biệt từ bản mẫu Việt:

═══ 📝 CHỈ ĐẠO TỪ NGƯỜI DÙNG ═══
(Tổng hợp và nhấn mạnh các yêu cầu đặc biệt)` 
          },
          { 
            role: "user", 
            content: `${glossaryBlock ? `${glossaryBlock}\n\n` : ''}=== BẢN MẪU ANH ===\n${sampleEnCombined}\n\n=== BẢN MẪU VIỆT ===\n${sampleViCombined}\n\n=== GÓP Ý BỔ SUNG CỦA NGƯỜI DÙNG ===\n${userInstructions || 'Không có (Tự động phân tích theo bản mẫu)'}\n\n=== TÀI LIỆU CHUẨN BỊ DỊCH:` 
          }
        ],
        (chunk) => sendChunk(chunk),
        { temperature: 0.2, fallbackModel: MODEL_FALLBACK }
      );

      // ==========================================
      // GĐ 2: DỊCH THÔ
      // ==========================================
      sendStatus('✍️ GIAI ĐOẠN 2/5: Dịch Thô...');
      sendNewBox(`✍️ GĐ 2: Dịch Thô (${MODEL_TRANSLATE})`, "color-gd2");
      const enChunks = splitTextIntoChunks(newEnText, 6500);
      const draftChunks = [];

      for (let i = 0; i < enChunks.length; i++) {
        if (enChunks.length > 1) {
          sendStatus(`✍️ GĐ 2: Đang dịch thô phần ${i + 1}/${enChunks.length}...`);
        }

        const prevTail = i > 0 && draftChunks[i - 1] ? draftChunks[i - 1].slice(-400) : '';
        const continuityBlock = prevTail
          ? `=== ĐUÔI BẢN DỊCH PHẦN TRƯỚC (chỉ để nối mạch, KHÔNG dịch lại) ===\n...${prevTail}\n\n`
          : '';
        
        const isSubsequentChunk = i > 0;
        const systemInstruction = isSubsequentChunk
          ? `Bạn là phiên dịch viên văn học cao cấp. Đây là ĐOẠN NỐI TIẾP (phần ${i + 1}/${enChunks.length}).
LỆNH BẮT BUỘC:
1. TUYỆT ĐỐI KHÔNG lặp lại tiêu đề chương hoặc đoạn mở đầu.
2. Dịch thẳng từ câu đầu tiên của phần này.
3. KHÔNG tóm tắt, KHÔNG cắt xén, KHÔNG bịa thêm.
4. Với thành ngữ, chơi chữ, yếu tố văn hóa đặc thù: đánh dấu [⚠️] bên cạnh để biên tập viên xử lý kỹ ở bước sau.
5. CHỈ TRẢ VỀ DUY NHẤT văn bản dịch nối tiếp.
6. Nối liền mạch văn phong và xưng hô với [ĐUÔI BẢN DỊCH PHẦN TRƯỚC]. Không được đổi cách xưng hô giữa chương.`
          : `Bạn là phiên dịch viên văn học cao cấp. Dịch ĐẦY ĐỦ 100% phần mở đầu chương này.
LỆNH BẮT BUỘC:
1. Dịch chính xác từng câu. KHÔNG bịa thêm tình tiết.
2. KHÔNG tóm tắt, cắt xén bất kỳ câu nào.
3. Ưu tiên truyền tải ý nghĩa, cảm xúc và giọng điệu hơn là dịch từng chữ.
4. Với thành ngữ, chơi chữ, yếu tố văn hóa đặc thù: đánh dấu [⚠️] bên cạnh để biên tập viên xử lý kỹ ở bước sau.
5. Tuân thủ BẢNG THUẬT NGỮ và BẢNG XƯNG HÔ từ Tài liệu Chuẩn bị.
6. CHỈ TRẢ VỀ DUY NHẤT nội dung truyện đã dịch.`;

        let titleChecked = !isSubsequentChunk;
        let headerBuffer = "";

        const chunkText = await streamAIWithRotation(
          MODEL_TRANSLATE,
          [
            { role: "system", content: systemInstruction },
            { role: "user", content: `${glossaryBlock ? `${glossaryBlock}\n\n` : ''}=== TÀI LIỆU CHUẨN BỊ DỊCH (GĐ 1) ===\n${styleGuide}\n\n${continuityBlock}=== GÓP Ý CỦA NGƯỜI DÙNG ===\n${userInstructions || 'Không có'}\n\n=== CHƯƠNG MỚI (TIẾNG ANH - PHẦN ${i + 1}/${enChunks.length}) ===\n${enChunks[i]}\n\n=== BẢN DỊCH:` }
          ],
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
          { temperature: 0.3, fallbackModel: MODEL_FALLBACK }
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
      // VÒNG LẶP GĐ 3 + GĐ 4 (LẶP ĐẾN KHI DUYỆT, TỐI ĐA 3 VÒNG AN TOÀN)
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

      while (loopCount < MAX_LOOPS && !isApproved) {
        loopCount++;

        // ==========================================
        // GĐ 3: BIÊN TẬP & ĐỐI CHIẾU
        // ==========================================
        sendStatus(`🔍 GIAI ĐOẠN 3/5: Biên tập & Đối chiếu (Lần ${loopCount})...`);
        sendNewBox(`🔍 GĐ 3: Biên tập & Đối chiếu — Lần ${loopCount} (${MODEL_REVIEW})`, "color-gd3");

        const newEditedChunks = [];

        for (let cIdx = 0; cIdx < enChunks.length; cIdx++) {
          if (enChunks.length > 1) {
            sendStatus(`🔍 GĐ 3: Đang biên tập & đối chiếu phần ${cIdx + 1}/${enChunks.length}...`);
          }

          const editSystemPrompt = `Bạn là Biên Tập Viên Văn Học Chuyên Nghiệp.
Nhiệm vụ: Đọc [BẢN DỊCH THÔ PHẦN ${cIdx + 1}/${enChunks.length}], đối chiếu từng câu với [VĂN BẢN GỐC TIẾNG ANH PHẦN ${cIdx + 1}/${enChunks.length}] và [TÀI LIỆU CHUẨN BỊ DỊCH].

${glossaryBlock ? `${glossaryBlock}\n` : ''}
${loopCount > 1 ? `⚠️ ĐÂY LÀ LẦN BIÊN TẬP THỨ ${loopCount}. Tham khảo [LỜI PHÊ BÌNH LẦN TRƯỚC] để sửa đúng trọng tâm.\n\n[LỜI PHÊ BÌNH LẦN TRƯỚC]:\n${previousCritique}\n` : ''}

QUY TRÌNH BIÊN TẬP BẮT BUỘC:
1. ĐỐI CHIẾU TỪNG ĐOẠN: So sánh bản dịch phần này với nguyên tác — không sót ý, không sai nghĩa.
2. CHỈNH CÂU VĂN: Sửa các câu dịch bám sát cấu trúc Anh ngữ nghe gượng gạo → viết lại tự nhiên trong tiếng Việt.
3. XỬ LÝ ĐOẠN KHÓ [⚠️]: Tìm các đoạn đánh dấu [⚠️] (thành ngữ, chơi chữ, yếu tố văn hóa) và xử lý kỹ, gỡ bỏ ký hiệu [⚠️] sau khi xử lý xong.
4. NHẤT QUÁN: Đảm bảo tên riêng, thuật ngữ, xưng hô đồng nhất theo Bảng Thuật Ngữ & Bảng XƯNG HÔ.
5. GIỮ NGUYÊN 100% NỘI DUNG PHẦN NÀY: KHÔNG tóm tắt, KHÔNG cắt xén, KHÔNG bịa thêm.
${cIdx > 0 ? "6. KHÔNG lặp lại tiêu đề chương hoặc đoạn mở đầu đã biên tập ở phần trước." : ""}

CHỈ TRẢ VỀ DUY NHẤT nội dung phần ${cIdx + 1} đã biên tập hoàn chỉnh (không giải thích, không giao tiếp).`;

          let editedChunkText = "";
          try {
            editedChunkText = await streamAIWithRotation(
              MODEL_REVIEW,
              [
                { role: "system", content: editSystemPrompt },
                { role: "user", content: `=== TÀI LIỆU CHUẨN BỊ DỊCH (GĐ 1) ===\n${styleGuide}\n\n=== GÓP Ý CỦA NGƯỜI DÙNG ===\n${userInstructions || 'Không có'}\n\n=== VĂN BẢN GỐC TIẾNG ANH (PHẦN ${cIdx + 1}/${enChunks.length}) ===\n${enChunks[cIdx]}\n\n=== BẢN DỊCH THÔ (PHẦN ${cIdx + 1}/${enChunks.length}) ===\n${currentDraftChunks[cIdx] || ''}\n\n=== BẢN BIÊN TẬP HOÀN CHỈNH PHẦN ${cIdx + 1}:` }
              ],
              (chunk) => sendChunk(chunk),
              { temperature: 0.2, fallbackModel: MODEL_FALLBACK }
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

        const proofSystemPrompt = `Bạn là Hiệu Đính Viên & Người Đọc Thử Chuyên Nghiệp (Proofreader & Beta Reader).
Bạn đang hiệu đính bản dịch đã qua biên tập.

${loopCount > 1 ? `⚠️ ĐÂY LÀ LẦN HIỆU ĐÍNH THỨ ${loopCount}. Đối chiếu với lời phê bình lần trước để xem các lỗi đã được sửa chưa.
Nếu các lỗi chính đã sửa xong → PHẢI TĂNG ĐIỂM. KHÔNG MÂU THUẪN VỚI CHÍNH MÌNH.` : ''}

QUY TRÌNH HIỆU ĐÍNH:
1. RÀ LỖI: Chính tả, ngữ pháp, dấu câu, định dạng.
2. MẠCH TRUYỆN: Đọc liền mạch từ đầu đến cuối — có chỗ nào bị đứt gãy, nhảy ý không?
3. ĐỘ TRÔI CHẢY: Đọc như người Việt đọc truyện — có chỗ nào nghe lạ tai, gượng gạo?
4. NHẤT QUÁN: Xưng hô, tên riêng, thuật ngữ có thống nhất xuyên suốt?
5. ĐỐI CHIẾU GỐC: Có đoạn nào bị dịch sót, dịch sai ý, hoặc bịa thêm không?

BÁO CÁO THEO FORMAT:

📊 ĐIỂM SỐ: X/10

✅ ĐIỂM TỐT:
- Liệt kê những điểm đã làm tốt.

❌ LỖI CẦN SỬA (nếu có):
- Trích câu sai → Gợi ý sửa cụ thể.

🏷️ KẾT LUẬN: [DUYỆT] hoặc [CHƯA ĐẠT]

QUY TẮC:
- Điểm >= 8.5/10 và không có lỗi nghiêm trọng → [DUYỆT]
- Điểm < 8.5/10 hoặc còn lỗi xưng hô, câu gượng, sót ý → [CHƯA ĐẠT]`;

        let critique = "";
        try {
          critique = await streamAIWithRotation(
            MODEL_FALLBACK,
            [
              { role: "system", content: proofSystemPrompt },
              { role: "user", content: `=== TÀI LIỆU CHUẨN BỊ DỊCH (GĐ 1) ===\n${styleGuide}\n\n=== GÓP Ý CỦA NGƯỜI DÙNG ===\n${userInstructions || 'Không có'}\n\n=== VĂN BẢN GỐC (TIẾNG ANH) ===\n${newEnText}\n\n=== BẢN DỊCH ĐÃ BIÊN TẬP (CẦN HIỆU ĐÍNH) ===\n${currentDraft}\n\n${loopCount > 1 ? `=== LỜI PHÊ BÌNH LẦN TRƯỚC ===\n${previousCritique}\n\n` : ''}=== KẾT QUẢ HIỆU ĐÍNH LẦN ${loopCount}:` }
            ],
            (chunk) => sendChunk(chunk),
            { temperature: 0.1, fallbackModel: MODEL_REVIEW }
          );
        } catch (err) {
          console.warn(`⚠️ GĐ 4 lỗi xoay vòng API: ${err.message}. Tự động chấp nhận bản hiện tại.`);
          critique = "[DUYỆT] — Đã tự động chấp nhận bản hiện tại do sự cố mạng.";
          sendChunk(critique);
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
      // GĐ 5: HOÀN THIỆN & XUẤT BẢN — CHỌN BẢN TỐT NHẤT
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

      // ── LỚP KIỂM TRA CƯỠNG CHẾ (AUDIT & HARD ENFORCEMENT & LENGTH CHECK)
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
            ], { temperature: 0.1, fallbackModel: MODEL_FALLBACK });
          } catch (e) {
            console.warn(`⚠️ Không sửa được thuật ngữ dư: ${e.message}`);
          }
        }
        sendStatus(`🔧 Đã ép đúng ${violations.length} thuật ngữ/tên riêng theo Glossary.`);
      }

      sendChunk(finalCleanText);

      // ── TRÍCH XUẤT THUẬT NGỮ MỚI & TRỘN VÀO GLOSSARY
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
    });

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
// API TRÒ CHUYỆN TRỰC TIẾP VỚI MINIMAX (TỔNG BIÊN TẬP)
// ==========================================
app.post('/api/chat-minimax', async (req, res) => {
  const { userMessage, styleGuide, conversationHistory, reviewModel, fallbackModel } = req.body;
  if (!userMessage) return res.status(400).json({ error: 'Chưa có tin nhắn!' });

  const MODEL_REVIEW = reviewModel || 'minimax/minimax-m3';
  const MODEL_FALLBACK = fallbackModel || 'deepseek/deepseek-v4-flash';
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const sendChunk = (text) => { 
    if (!res.writableEnded) res.write(`data: ${JSON.stringify({ type: 'chunk', data: text })}\n\n`); 
  };

  try {
    const messages = [
      {
        role: "system",
        content: `Bạn là Tổng Biên Tập sắc bén, khắt khe và giàu chuyên môn ngôn ngữ học. 
Người dùng đang trao đổi trực tiếp với bạn để thảo luận về bản dịch, cách xưng hô, giọng văn và từ ngữ.

NHIỆM VỤ CỦA BẠN (ĐÁNH GIÁ & TƯƠNG TÁC BIÊN TẬP):
1. TUYỆT ĐỐI KHÔNG GẬT ĐẦU MÙ MÁU: Hãy phân tích xem góp ý của người dùng có HỢP LÝ và DÚNG BỐI CẢNH tác phẩm hay không.
2. NẾU GÓP Ý HỢP LÝ: Khen ngợi góc nhìn của người dùng, làm rõ thêm chi tiết và xác nhận sẽ đưa chỉ đạo này cho Dịch giả sửa.
3. NẾU GÓP Ý CHƯA PHÙ HỢP (ví dụ: làm mất tính deadpan, sai xưng hô nhân vật Nhật Bản, phá vỡ bối cảnh): Phản biện thẳng thắn, giải thích RÕ LÝ DO tại sao chưa nên làm vậy, và đề xuất phương án dung hòa hay hơn.
4. Trả lời sắc bén, chuyên nghiệp, giữ phong thái Tổng Biên Tập nghiêm túc (dưới 180 từ).

Bộ Quy Tắc Văn Phong Hiện Tại:
${styleGuide || 'Đang thiết lập'}`
      }
    ];

    if (conversationHistory && Array.isArray(conversationHistory) && conversationHistory.length > 0) {
      conversationHistory.forEach(msg => messages.push(msg));
    } else {
      messages.push({ role: "user", content: userMessage });
    }

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
  }
});

async function downloadImageFromUrl(imageUrl) {
  let finalUrl = imageUrl.trim();

  // 1. XỬ LÝ ĐẶC BIỆT CHO MANGADEX (Hỗ trợ từng trang ví dụ: /chapter/id/4)
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

  // 2. XỬ LÝ CHO CÁC TRANG WEB TRUYỆN TRANH KHÁC (Cheerio)
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

  // Check if user specifically requested a single page (e.g. /chapter/id/4)
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

        // Nếu người dùng chọn đúng 1 trang cụ thể (vd: /4) -> chỉ lấy trang đó
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

        // Ngược lại -> Tải TOÀN BỘ các trang của Chapter
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

  // CÁC TRANG WEB KHÁC (Tải 1 ảnh duy nhất)
  const singlePath = await downloadImageFromUrl(finalUrl);
  return [{ pageIndex: 1, path: singlePath }];
}

function spawnPythonScript(args, onStdout, onStderr, onClose) {
  const pyCmd = process.platform === 'win32' ? 'py' : 'python';
  const optWithEnv = { env: { ...process.env, PYTHONIOENCODING: 'utf-8' } };
  
  let pyProc;
  try {
    pyProc = spawn(pyCmd, args, optWithEnv);
  } catch(e) {
    pyProc = spawn('python', args, optWithEnv);
  }

  pyProc.stdout.on('data', (data) => onStdout(data.toString('utf-8')));
  pyProc.stderr.on('data', (data) => onStderr(data.toString('utf-8')));
  
  pyProc.on('error', (err) => {
    if (process.platform === 'win32') {
      const fallbackProc = spawn('python', args, optWithEnv);
      fallbackProc.stdout.on('data', (data) => onStdout(data.toString('utf-8')));
      fallbackProc.stderr.on('data', (data) => onStderr(data.toString('utf-8')));
      fallbackProc.on('close', (code) => onClose(code));
    } else {
      onStderr(err.message);
    }
  });

  pyProc.on('close', (code) => onClose(code));
}

// ==========================================
// API 2: GỌI PYTHON XỬ LÝ TRUYỆN TRANH (STREAM TIẾN TRÌNH THỜI GIAN THỰC)
// ==========================================
app.post('/api/translate-comic', upload.single('image'), async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  const sendEvent = (type, data) => {
    if (!res.writableEnded) {
      res.write(`data: ${JSON.stringify({ type, data })}\n\n`);
      if (typeof res.flush === 'function') res.flush();
    }
  };

  let imagesToProcess = [];
  const sourceLang = req.body.sourceLang || 'en';
  const userInstructions = req.body.userInstructions || '';
  const allowedLangs = ['en', 'ja', 'ko', 'zh'];
  const lang = allowedLangs.includes(sourceLang) ? sourceLang : 'en';

  if (req.file) {
    try {
      await validateUploadedFiles([req.file]);
      imagesToProcess.push({ pageIndex: 1, path: req.file.path });
    } catch (valErr) {
      sendEvent('error', `File ảnh không hợp lệ: ${valErr.message}`);
      return res.end();
    }
  } else if (req.body.imageUrl) {
    try {
      sendEvent('status', '📡 Đang kết nối bóc tách danh sách trang của Chapter...');
      imagesToProcess = await downloadAllChapterImages(req.body.imageUrl.trim(), (current, total) => {
        sendEvent('status', `📥 Đang tải ảnh Chapter: Trang ${current}/${total}...`);
      });
    } catch (err) {
      sendEvent('error', `Không thể tải chapter từ link: ${err.message}`);
      return res.end();
    }
  }

  if (!imagesToProcess || imagesToProcess.length === 0) {
    sendEvent('error', 'Vui lòng chọn file ảnh hoặc dán link chapter truyện tranh!');
    return res.end();
  }

  const allPaths = imagesToProcess.map(img => img.path);
  sendEvent('status', `🎨 Đã sẵn sàng. Bắt đầu OCR & Dịch ${imagesToProcess.length} trang truyện tranh...`);

  try {
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
    imagesToProcess.forEach(img => fs.unlink(img.path, () => {}));
    res.end();
  }
});

const PORT = 3000;
app.listen(PORT, () => console.log(`🚀 Node.js Server (Bản Multi-Agent Hoàn Hảo) đang chạy tại: http://localhost:${PORT}`));