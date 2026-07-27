# 🚀 Novel & Comic AI Translator (Hệ Thống Dịch Thuật AI 5 Giai Đoạn)

Hệ thống dịch thuật văn học & truyện tranh chuyên nghiệp tự động hóa theo quy trình 5 giai đoạn, hỗ trợ **Xoay Vòng API Key Vô Hạn (Infinite Key Pool Rotation)**, **Sổ Thuật Ngữ Động (Glossary Management)**, **Bảo Vệ SSRF**, **Dọn Dẹp File Tạm Tự Động** và **Dàn Trang Auto-Fit**.

---

## 🌟 Tính Năng Nổi Bật

1. **Quy Trình Dịch 5 Giai Đoạn Chuyên Nghiệp**:
   - 📚 **GĐ 1: Chuẩn bị & Nghiên cứu**: Phân tích phong cách tác giả, xưng hô, ngữ cảnh.
   - ✍️ **GĐ 2: Dịch thô**: Dịch từng phần kèm mồi nối văn phong (`continuity tail`).
   - 🔍 **GĐ 3: Biên tập & Đối chiếu**: So sánh từng câu với nguyên tác, xử lý các câu gượng gạo và thành ngữ `[⚠️]`.
   - ✅ **GĐ 4: Hiệu đính & Đọc thử**: Chấm điểm (1-10) và rà soát lỗi chính tả/mạch truyện.
   - 🏆 **GĐ 5: Xuất bản & Chọn bản tốt nhất**: Lựa chọn bản dịch đạt điểm cao nhất và tự động cập nhật sổ thuật ngữ.

2. **Xoay Vòng API Key Vô Hạn (Infinite Ring-Buffer Key Rotation)**:
   - Tự động ghi nhớ các Key bị `429 Too Many Requests / Quota Exhausted` để tạm ẩn.
   - Tự động mượn Key từ pool dự phòng (`DEEPSEEK` ↔ `FLASH` ↔ `MINIMAX`).
   - Tự động khôi phục danh sách Key khi cạn pool để quay vòng liên tục 24/7 mà không bị đứng nghẽn.

3. **Dịch Truyện Tranh Thẩm Mỹ (OpenCV Telea + PIL Auto-Fit)**:
   - Tự động quét OCR và khoanh vùng bong bóng thoại (`EasyOCR`).
   - Làm sạch chữ gốc bằng thuật toán **OpenCV Telea Inpainting** mà không làm đục lỗ trắng lên nét vẽ xung quanh.
   - Tự động tính toán màu nền (`bg_color`) theo từng bong bóng thoại riêng biệt.
   - Tự động căn chỉnh kích thước font (`PIL Auto-fit`) và hỗ trợ font tiếng Việt Unicode (`NotoSans-Bold.ttf`, `Tahoma`, `Arial`).

4. **Sổ Thuật Ngữ 2 Tầng (Glossary Management)**:
   - **Tầng bất biến**: Tên riêng, địa danh, thuật ngữ được giữ cố định.
   - **Tầng động**: Xưng hô nhân vật tiến hóa theo từng mốc chương.
   - Giao diện quản lý sổ thuật ngữ trực quan tại `/glossary.html`.

5. **Bảo Mật & Quản Lý Hệ Thống**:
   - **Bảo vệ SSRF**: Chặn hoàn toàn các URL nội bộ (`localhost`, `127.0.0.1`, `10.x.x.x`, `192.168.x.x`, v.v.).
   - **Xác thực API_TOKEN**: Hỗ trợ bọc token bảo vệ API khi đưa ứng dụng lên server public.
   - **Tự động dọn dẹp (Auto-cleanup cron)**: Tự động xóa file tạm trong `uploads/` và ảnh truyện công khai trong `public/` sau 1 giờ.

---

## 🛠️ Cấu Trúc Dự Án

```
e:\ok\
 ├── services/
 │    ├── ai.js          # Quản lý AI client, bảng đăng ký model & xoay vòng stream
 │    ├── scraper.js     # Cào dữ liệu web an toàn (Bảo vệ chống SSRF)
 │    ├── auth.js        # Xác thực API Token & Cấu hình CORS
 │    ├── cleanup.js     # Cron dọn dẹp file tạm tự động định kỳ
 │    ├── glossary.js    # Kho lưu trữ sổ thuật ngữ 2 tầng
 │    ├── glossary-extract.js # Trích xuất thuật ngữ tự động bằng AI
 │    └── glossary-routes.js  # Các API endpoint cho sổ thuật ngữ
 ├── public/
 │    ├── index.html     # Giao diện ứng dụng chính
 │    └── glossary.html  # Giao diện quản lý sổ thuật ngữ
 ├── fonts/              # Nơi chứa các font tiếng Việt Unicode
 ├── comic_translator.py # Động cơ dịch truyện tranh Python
 ├── server.js           # Server Express chính
 ├── package.json
 └── requirements.txt
```

---

## 🚀 Hướng Dẫn Cài Đặt & Chạy Ứng Dụng

### 1. Cài Đặt Khai Báo Môi Trường Python & Node.js

```bash
# Cài đặt Node.js dependencies
npm install

# Cài đặt Python dependencies
pip install -r requirements.txt
```

### 2. Cấu Hình File `.env`

Tạo file `.env` từ file mẫu `.env.example`:

```bash
cp .env.example .env
```

Điền các API Key của bạn vào file `.env`:

```env
DEEPSEEK_API_KEYS=sk-key1,sk-key2,sk-key3
MINIMAX_API_KEYS=sk-minimax1,sk-minimax2
OPENROUTER_API_KEY=sk-or-v1-...
```

### 3. Khởi Động Server

```bash
npm start
# Hoặc chạy ở chế độ dev:
npm run dev
```

Truy cập ứng dụng tại: `http://localhost:3000`

---

## 🔒 Bảo Mật Khi Deploy Lên Server

Nếu bạn muốn deploy ứng dụng lên VPS hoặc Server công khai, hãy bật tính năng bảo mật trong file `.env`:

```env
API_TOKEN=your_secret_password_here
ALLOWED_ORIGINS=https://your-domain.com
```

Khi bật `API_TOKEN`, mọi request gửi tới server phải kèm theo header:
```
x-api-token: your_secret_password_here
```
hoặc query parameter `?token=your_secret_password_here`.
