// services/auth.js — API Authentication & Access Security
import cors from 'cors';

const isProduction = process.env.NODE_ENV === 'production';

// Trong môi trường production, kiểm tra xem đã bật API_TOKEN chưa
if (isProduction && !process.env.API_TOKEN) {
  console.warn('⚠️ [SECURITY CAUTION] NODE_ENV=production nhưng chưa đặt API_TOKEN! Khuyến nghị đặt API_TOKEN để bảo vệ endpoint.');
}

/**
 * Middleware kiểm tra API Token
 */
export function requireApiAuth(req, res, next) {
  const isProduction = process.env.NODE_ENV === 'production';
  const configuredToken = process.env.API_TOKEN;

  // Nếu không cấu hình API_TOKEN
  if (!configuredToken) {
    if (isProduction) {
      return res.status(401).json({
        error: 'Unauthorized: Server đang chạy chế độ production bắt buộc phải cấu hình API_TOKEN.'
      });
    }
    return next(); // Cho phép truy cập mở ở chế độ local / dev
  }

  const tokenFromHeader = req.headers['x-api-token'];
  const tokenFromQuery = req.query.token;
  const tokenFromBody = req.body?.token;

  // Never accept credentials in query/body during production
  const providedToken = isProduction ? tokenFromHeader : (tokenFromHeader || tokenFromQuery || tokenFromBody);

  if (!providedToken || providedToken !== configuredToken) {
    return res.status(401).json({
      error: 'Unauthorized: API Token không chính xác hoặc thiếu token xác thực. Truyền x-api-token trong header hoặc query param ?token='
    });
  }

  next();
}

/**
 * Cấu hình CORS an toàn theo domain cho phép (ALLOWED_ORIGINS)
 */
export function configureCors() {
  const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map(o => o.trim())
    .filter(Boolean);

  if (allowedOrigins.length === 0) {
    if (isProduction) {
      console.warn('⚠️ [SECURITY CAUTION] Chưa cấu hình ALLOWED_ORIGINS trong môi trường production!');
    }
    return cors();
  }

  return cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin) || allowedOrigins.includes('*')) {
        callback(null, true);
      } else {
        callback(new Error(`CORS policy: Domain ${origin} không được phép truy cập.`));
      }
    },
    credentials: true
  });
}
