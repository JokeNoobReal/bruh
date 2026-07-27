// services/auth.js — API Authentication & Access Security
import cors from 'cors';

/**
 * Middleware kiểm tra API Token nếu được bật trong môi trường (.env)
 */
export function requireApiAuth(req, res, next) {
  const configuredToken = process.env.API_TOKEN;
  // Nếu không cấu hình API_TOKEN trong env -> bỏ qua auth (chế độ tự do / local)
  if (!configuredToken) {
    return next();
  }

  const tokenFromHeader = req.headers['x-api-token'];
  const tokenFromQuery = req.query.token;
  const tokenFromBody = req.body?.token;

  const providedToken = tokenFromHeader || tokenFromQuery || tokenFromBody;

  if (!providedToken || providedToken !== configuredToken) {
    return res.status(401).json({
      error: 'Unauthorized: API Token không chính xác hoặc thiếu token xác thực. Đặt x-api-token trong header hoặc query param ?token='
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
    return cors(); // Mặc định mở nếu chưa đặt restriction
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
