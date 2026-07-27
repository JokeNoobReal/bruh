// services/ai.js — Modular AI Client Manager & Key Rotation Engine
import OpenAI from 'openai';

// ===== BẢNG ĐĂNG KÝ MODEL =====
export const MODEL_REGISTRY = {
  'deepseek/deepseek-v4-pro':   { pool: 'DEEPSEEK', provider: 'default' },
  'deepseek/deepseek-v4-flash': { pool: 'DEEPSEEK', provider: 'default' },
  'minimax/minimax-m3':         { pool: 'MINIMAX',  provider: 'default' },
  'nvidia/nemotron':            { pool: 'OPENROUTER', provider: 'openrouter' },
};

// Thứ tự mượn key khi pool chính cạn sạch (Ring buffer failover)
export const POOL_FALLBACK = {
  DEEPSEEK: ['DEEPSEEK', 'FLASH', 'MINIMAX'],
  FLASH:    ['FLASH', 'DEEPSEEK', 'MINIMAX'],
  MINIMAX:  ['MINIMAX', 'DEEPSEEK', 'FLASH'],
};

// Quản lý các API Key bị tạm ẩn do lỗi 429/cạn quota trong bộ nhớ
const exhaustedKeys = new Map();

export function markKeyExhausted(apiKey, cooldownMs = 3600 * 1000) {
  if (apiKey) {
    exhaustedKeys.set(apiKey, Date.now() + cooldownMs);
    console.warn(`🔒 Đã tạm ẩn Key (${apiKey.substring(0, 12)}...) trong ${Math.round(cooldownMs / 1000)}s do 429 hết token/rate limit.`);
  }
}

export function isKeyExhausted(apiKey) {
  if (!apiKey) return false;
  const expireTime = exhaustedKeys.get(apiKey);
  if (!expireTime) return false;
  if (Date.now() > expireTime) {
    exhaustedKeys.delete(apiKey);
    return false;
  }
  return true;
}

export function resolveModel(modelName = '') {
  if (MODEL_REGISTRY[modelName]) return MODEL_REGISTRY[modelName];
  if (/openrouter|nvidia\/|nemotron/i.test(modelName)) return { pool: 'OPENROUTER', provider: 'openrouter' };
  if (/^minimax\//i.test(modelName))  return { pool: 'MINIMAX',  provider: 'default' };
  if (/^deepseek\//i.test(modelName)) return { pool: 'DEEPSEEK', provider: 'default' };
  if (/flash/i.test(modelName))       return { pool: 'FLASH',    provider: 'default' };
  return { pool: 'DEEPSEEK', provider: 'default' };
}

const readKeys = (name) =>
  (process.env[name] || '').split(',').map(k => k.trim()).filter(Boolean);

export function buildKeyPool(modelName) {
  const { pool } = resolveModel(modelName);
  const order = POOL_FALLBACK[pool] || [pool];
  const keys = order.flatMap(p => [...readKeys(`${p}_API_KEYS`), ...readKeys(`${p}_API_KEY`)]);
  return [...new Set(keys)];
}

export function getAIClient(modelName = '', keyIndex = 0) {
  const { provider } = resolveModel(modelName);

  if (provider === 'openrouter') {
    const apiKey = process.env.OPENROUTER_API_KEY;
    return {
      client: new OpenAI({
        baseURL: process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1',
        apiKey,
        defaultHeaders: { 'HTTP-Referer': 'http://localhost:3000', 'X-Title': 'Novel Comic Translator' }
      }),
      apiKey
    };
  }

  const all = buildKeyPool(modelName);
  let usable = all.filter(k => !isKeyExhausted(k));

  // Nếu toàn bộ Key trong kho đều hết và đã qua ít nhất 60s cooldown -> tự động xả bớt để xoay lại
  if (usable.length === 0 && all.length > 0) {
    const now = Date.now();
    let resetCount = 0;
    all.forEach(k => {
      const exp = exhaustedKeys.get(k);
      if (exp && now - (exp - 3600 * 1000) > 60 * 1000) {
        exhaustedKeys.delete(k);
        resetCount++;
      }
    });
    usable = all.filter(k => !isKeyExhausted(k));
    if (usable.length === 0) usable = all;
    if (resetCount > 0) {
      console.warn(`🔄 Đã khôi phục ${resetCount} Key để thử lại vòng quay.`);
    }
  }

  const apiKey = usable[keyIndex % usable.length] || process.env.DEEPSEEK_API_KEY;
  return { client: new OpenAI({ baseURL: process.env.AI_BASE_URL, apiKey }), apiKey };
}

export function getKeyCount(modelName = '') {
  if (resolveModel(modelName).provider === 'openrouter') return 1;
  const all = buildKeyPool(modelName);
  const usable = all.filter(k => !isKeyExhausted(k));
  return (usable.length || all.length) || 1;
}

// 🔄 HÀM GỌI AI & STREAM TỰ ĐỘNG XOAY VÒNG KEY VÀ MODEL DỰ PHÒNG
export async function streamAIWithRotation(modelName, messages, onChunk, options = {}) {
  const temperature = options.temperature ?? 0.3;
  const fallbackModel = options.fallbackModel || null;
  const timeoutMs = Number(options.timeoutMs || 180_000);

  const modelsToTry = [modelName];
  if (fallbackModel && fallbackModel !== modelName) {
    modelsToTry.push(fallbackModel);
  }

  let lastError = null;

  for (const currentModel of modelsToTry) {
    const totalKeys = getKeyCount(currentModel);

    for (let attempt = 0; attempt < totalKeys; attempt++) {
      let accumulatedText = "";
      let currentApiKey = "";
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      // Connect external signal to internal controller
      if (options.signal) {
        options.signal.addEventListener('abort', () => controller.abort(), { once: true });
      }

      try {
        const { client, apiKey } = getAIClient(currentModel, attempt);
        currentApiKey = apiKey;

        const stream = await client.chat.completions.create({
          model: currentModel,
          messages,
          temperature,
          stream: true,
          signal: controller.signal,
        });

        for await (const chunk of stream) {
          if (controller.signal.aborted) break;
          const content = chunk.choices[0]?.delta?.content || "";
          if (content) {
            accumulatedText += content;
            if (typeof onChunk === 'function') {
              onChunk(content);
            }
          }
        }

        if (accumulatedText.trim().length > 0) {
          return accumulatedText;
        }
      } catch (err) {
        lastError = err;
        const errStr = (err.message || "").toLowerCase();
        const isQuotaOrRateLimit = err.status === 429 || errStr.includes("quota") || errStr.includes("rate limit") || errStr.includes("insufficient_user_quota");

        // Fatal client errors (400 Bad Request, 404 Model Not Found, 422 Invalid Payload) should NOT be retried
        const isNonRetryable = err.status === 400 || err.status === 404 || err.status === 422;
        if (isNonRetryable || err.name === 'AbortError') {
          console.warn(`🛑 Lỗi không thể thử lại (${err.status || err.name}): ${err.message}. Dừng xoay vòng.`);
          throw err;
        }

        if (isQuotaOrRateLimit && currentApiKey) {
          markKeyExhausted(currentApiKey);
          console.warn(`⚠️ Key #${attempt + 1} cho model [${currentModel}] bị rate limit (429). Đang chuyển sang Key tiếp theo...`);
        } else {
          console.warn(`⚠️ Key #${attempt + 1} cho model [${currentModel}] gặp sự cố (${err.message}). Thử Key tiếp theo...`);
        }
      } finally {
        clearTimeout(timer);
      }
    }

    if (modelsToTry.length > 1 && currentModel === modelName) {
      console.warn(`⚠️ Tất cả Key của model chính [${modelName}] đều bận/hết token. Tự động chuyển sang Model Dự Phòng [${fallbackModel}]...`);
    }
  }

  throw lastError || new Error(`Tất cả các Model và Key dự phòng đều thất bại.`);
}

// Gọi AI lấy kết quả trọn gói không stream (dùng cho dịch ngầm / glossary)
export async function callAIQuiet(model, messages, options = {}) {
  return streamAIWithRotation(model, messages, null, options);
}
