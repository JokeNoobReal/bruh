// services/scraper.js — SSRF-Protected Web Content Scraper
import axios from 'axios';
import * as cheerio from 'cheerio';
import { URL } from 'url';

/**
 * Kiểm tra xem URL có an toàn để fetch không (SSRF Protection)
 * Chặn truy cập localhost, IP nội bộ, AWS metadata, v.v.
 */
export function validateUrlSsrf(inputUrl) {
  try {
    const parsed = new URL(inputUrl.trim());
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new Error(`Giao thức không hợp lệ: ${parsed.protocol}. Chỉ chấp nhận http hoặc https.`);
    }

    const hostname = parsed.hostname.toLowerCase();

    // Chặn hostname nội bộ
    if (
      hostname === 'localhost' ||
      hostname.endsWith('.local') ||
      hostname.endsWith('.internal') ||
      hostname === 'metadata.google.internal' ||
      hostname === '169.254.169.254'
    ) {
      throw new Error(`Truy cập bị từ chối do lý do bảo mật (SSRF Blocked: ${hostname}).`);
    }

    // Chặn IP nội bộ (IPv4 / IPv6)
    const ipv4Regex = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
    const match = hostname.match(ipv4Regex);
    if (match) {
      const [, a, b] = match.map(Number);
      if (
        a === 127 || // 127.0.0.0/8
        a === 10 ||  // 10.0.0.0/8
        (a === 172 && b >= 16 && b <= 31) || // 172.16.0.0/12
        (a === 192 && b === 168) || // 192.168.0.0/16
        (a === 169 && b === 254) || // 169.254.0.0/16
        a === 0
      ) {
        throw new Error(`Địa chỉ IP nội bộ bị cấm truy cập (SSRF Blocked: ${hostname}).`);
      }
    }

    if (hostname === '::1' || hostname === '0:0:0:0:0:0:0:1') {
      throw new Error(`Địa chỉ IPv6 nội bộ bị cấm truy cập.`);
    }

    return parsed.href;
  } catch (err) {
    throw new Error(`URL không hợp lệ hoặc bị cấm: ${err.message}`);
  }
}

/**
 * Cào nội dung văn bản truyện từ 1 URL công khai
 */
export async function fetchTextFromUrl(url) {
  const safeUrl = validateUrlSsrf(url);
  try {
    const { data } = await axios.get(safeUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      },
      timeout: 15000,
      maxRedirects: 5
    });

    const $ = cheerio.load(data);

    // Loại bỏ rác: script, style, quảng cáo, nav, footer, comment, popup, link chuyển chương
    $('script, style, nav, header, footer, iframe, .ads, .advertisement, .sidebar, .comments, #comments, .nav-links, .chapter-nav, .next-chapter, .prev-chapter, .btn-next, .btn-prev, .pagination, .related-posts, .cat-links, .entry-meta').remove();

    // Dùng .first() để CHỈ LẤY 1 KHUNG NỘI DUNG DUY NHẤT
    let container = $('#chapter-content').first();
    if (!container.length) container = $('.entry-content').first();
    if (!container.length) container = $('.chapter-c').first();
    if (!container.length) container = $('article').first();
    if (!container.length) container = $('main').first();
    if (!container.length) container = $('body');

    // Ưu tiên lấy từng thẻ <p> để lọc sạch khoảng trắng và nội dung thừa
    let paragraphs = [];
    container.find('p').each((_, el) => {
      const pText = $(el).text().trim();
      if (pText.length > 0 && !pText.toLowerCase().includes('next chapter') && !pText.toLowerCase().includes('previous chapter')) {
        paragraphs.push(pText);
      }
    });

    let text = paragraphs.length > 5 ? paragraphs.join('\n\n') : container.text().trim();
    text = text.replace(/\n\s*\n/g, '\n\n').trim();

    if (text.length < 100) {
      throw new Error("Không trích xuất được đủ văn bản từ trang (dưới 100 ký tự).");
    }
    return text;
  } catch (err) {
    console.warn(`⚠️ Lỗi cào URL (${safeUrl}): ${err.message}`);
    throw new Error(`Không cào được nội dung từ URL (${url}): ${err.message}`);
  }
}

/**
 * Cào nhiều URL mẫu song song
 */
export async function fetchMultipleUrls(urlsText) {
  if (!urlsText || !urlsText.trim()) return '';
  const urls = urlsText.split('\n').map(u => u.trim()).filter(u => u.length > 0);
  
  const results = await Promise.all(
    urls.map(async (url) => {
      try {
        return await fetchTextFromUrl(url);
      } catch (err) {
        console.warn(`⚠️ Bỏ qua URL lỗi: ${url} (${err.message})`);
        return '';
      }
    })
  );

  const validResults = results.filter(Boolean);
  if (validResults.length === 0) {
    throw new Error("Không cào được nội dung từ bất kỳ URL mẫu nào.");
  }

  return validResults.map((t, idx) => `=== CHƯƠNG MẪU ${idx + 1} ===\n${t}`).join("\n\n");
}

/**
 * Cào các cặp mẫu EN <-> VI khớp theo chỉ số (Tạo mảng { en, vi } cho seedFromSamples)
 */
export async function fetchPairSamples(urlsEnText, urlsViText) {
  const urlsEn = (urlsEnText || '').split('\n').map(u => u.trim()).filter(Boolean);
  const urlsVi = (urlsViText || '').split('\n').map(u => u.trim()).filter(Boolean);
  
  const count = Math.min(urlsEn.length, urlsVi.length);
  const pairs = [];

  for (let i = 0; i < count; i++) {
    try {
      const [en, vi] = await Promise.all([
        fetchTextFromUrl(urlsEn[i]),
        fetchTextFromUrl(urlsVi[i])
      ]);
      if (en && vi) {
        pairs.push({ en, vi });
      }
    } catch (e) {
      console.warn(`⚠️ Lỗi cào cặp mẫu ${i + 1}: ${e.message}`);
    }
  }

  return pairs;
}
