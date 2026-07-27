// services/cleanup.js — Scheduled Temporary File Cleanup
import fs from 'fs';
import path from 'path';

/**
 * Xóa các file tạm đã cũ (uploads/ và public/*_translated.jpg, public/url_comic_*)
 * @param {number} maxAgeMs Thời gian tồn tại tối đa (mặc định: 1 giờ = 3600000ms)
 */
export function cleanupTempFiles(maxAgeMs = 3600 * 1000) {
  const now = Date.now();
  let deletedCount = 0;

  // 1. Dọn thư mục uploads/
  const uploadDir = 'uploads';
  if (fs.existsSync(uploadDir)) {
    try {
      const files = fs.readdirSync(uploadDir);
      for (const file of files) {
        const filePath = path.join(uploadDir, file);
        try {
          const stats = fs.statSync(filePath);
          if (now - stats.mtimeMs > maxAgeMs) {
            fs.unlinkSync(filePath);
            deletedCount++;
          }
        } catch (e) {
          // Bỏ qua lỗi khóa file nếu đang dùng
        }
      }
    } catch (e) {
      console.warn(`⚠️ Lỗi khi quét thư mục uploads: ${e.message}`);
    }
  }

  // 2. Dọn các ảnh truyện tranh tạm trong public/
  const publicDir = 'public';
  if (fs.existsSync(publicDir)) {
    try {
      const files = fs.readdirSync(publicDir);
      for (const file of files) {
        if (file.endsWith('_translated.jpg') || file.startsWith('url_comic_')) {
          const filePath = path.join(publicDir, file);
          try {
            const stats = fs.statSync(filePath);
            if (now - stats.mtimeMs > maxAgeMs) {
              fs.unlinkSync(filePath);
              deletedCount++;
            }
          } catch (e) {
            // Bỏ qua lỗi
          }
        }
      }
    } catch (e) {
      console.warn(`⚠️ Lỗi khi quét thư mục public: ${e.message}`);
    }
  }

  if (deletedCount > 0) {
    console.log(`🧹 Đã tự động dọn dẹp ${deletedCount} file tạm quá 1 giờ.`);
  }
}

/**
 * Khởi động lịch tự động dọn dẹp định kỳ
 */
export function startAutoCleanupCron(intervalMs = 15 * 60 * 1000) {
  // Chạy 1 lần khi khởi động
  cleanupTempFiles();
  // Chạy định kỳ mỗi 15 phút
  setInterval(() => cleanupTempFiles(), intervalMs);
}
