import sys
import os
import io
import warnings
warnings.filterwarnings("ignore")

# Đảm bảo Windows STDOUT/STDERR luôn mã hóa UTF-8 để không bị lỗi UnicodeEncodeError (cp1252)
if sys.platform == 'win32':
    try:
        sys.stdout.reconfigure(encoding='utf-8', errors='replace')
        sys.stderr.reconfigure(encoding='utf-8', errors='replace')
    except Exception:
        sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
        sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8', errors='replace')

import re
import json
import textwrap
import numpy as np
import easyocr
import cv2
from PIL import Image, ImageDraw, ImageFont
from openai import OpenAI
from dotenv import load_dotenv

# Tải biến môi trường từ file .env
load_dotenv()

_FONT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fonts")
FONT_CANDIDATES = [
    os.path.join(_FONT_DIR, "NotoSans-Bold.ttf"),   # font kèm repo, ưu tiên số 1
    os.path.join(_FONT_DIR, "arial.ttf"),
    os.path.join(_FONT_DIR, "tahoma.ttf"),
    "C:/Windows/Fonts/arial.ttf",
    "C:/Windows/Fonts/tahoma.ttf",
    "/usr/share/fonts/truetype/noto/NotoSans-Bold.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
    "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
]

_FONT_PATH = next((p for p in FONT_CANDIDATES if os.path.exists(p)), None)
if _FONT_PATH is None:
    raise RuntimeError(
        "Không tìm thấy font hỗ trợ tiếng Việt. "
        "Tải NotoSans-Bold.ttf và đặt vào thư mục fonts/ cạnh comic_translator.py"
    )

_FONT_CACHE = {}
def load_font(size):
    """Tải font (có cache) đảm bảo render đủ dấu tiếng Việt."""
    size = int(size)
    if size not in _FONT_CACHE:
        _FONT_CACHE[size] = ImageFont.truetype(_FONT_PATH, size)
    return _FONT_CACHE[size]

def wrap_text(text, font, max_width):
    """
    Chia văn bản thành nhiều dòng sao cho chiều rộng mỗi dòng <= max_width.
    """
    words = text.split()
    lines = []
    current_line = []
    for word in words:
        test_line = " ".join(current_line + [word])
        left, top, right, bottom = font.getbbox(test_line)
        w = right - left
        if w <= max_width:
            current_line.append(word)
        else:
            if current_line:
                lines.append(" ".join(current_line))
                current_line = [word]
            else:
                lines.append(word) # Từ quá dài, đành cho nó một dòng riêng
    if current_line:
        lines.append(" ".join(current_line))
    return lines

def get_border_mean_color(crop_img):
    """
    Tính màu trung bình của 2 pixel ngoài cùng (viền) của một vùng ảnh.
    Giúp tạo màu nền thay thế tự nhiên hơn màu trắng tinh.
    """
    h, w, c = crop_img.shape
    if h <= 4 or w <= 4:
        return (255, 255, 255) # Nếu khung quá nhỏ, trả về màu trắng
    
    top = crop_img[0:2, 0:w]
    bottom = crop_img[h-2:h, 0:w]
    left = crop_img[2:h-2, 0:2]
    right = crop_img[2:h-2, w-2:w]
    
    # Gom tất cả pixel viền lại
    borders = np.concatenate([top.reshape(-1, 3), bottom.reshape(-1, 3), left.reshape(-1, 3), right.reshape(-1, 3)], axis=0)
    mean_color = np.mean(borders, axis=0)
    return tuple(map(int, mean_color))

def merge_adjacent_bboxes(valid_texts, y_threshold=35, x_threshold=40):
    """
    Gom các ô chữ nằm sát nhau (thuộc cùng 1 bong bóng thoại) thành 1 ô hợp nhất duy nhất.
    """
    if not valid_texts:
        return []

    # Sắp xếp các ô chữ theo vị trí Y từ trên xuống dưới
    sorted_items = sorted(valid_texts, key=lambda item: item["bbox"][0][1])
    clusters = []

    for item in sorted_items:
        (tl, tr, br, bl) = item["bbox"]
        x0, y0 = int(tl[0]), int(tl[1])
        x1, y1 = int(br[0]), int(br[1])

        merged = False
        for cluster in clusters:
            cx0, cy0, cx1, cy1 = cluster["bounds"]
            
            # Kiểm tra khoảng cách xem có thuộc cùng 1 bong bóng thoại hay không
            vertical_near = (y0 <= cy1 + y_threshold) and (y1 >= cy0 - y_threshold)
            horizontal_near = (x0 <= cx1 + x_threshold) and (x1 >= cx0 - x_threshold)

            if vertical_near and horizontal_near:
                cluster["bounds"] = [min(cx0, x0), min(cy0, y0), max(cx1, x1), max(cy1, y1)]
                cluster["original_items"].append(item)
                merged = True
                break

        if not merged:
            clusters.append({
                "bounds": [x0, y0, x1, y1],
                "original_items": [item]
            })

    merged_results = []
    for idx, cluster in enumerate(clusters):
        combined_text = " ".join([it["original"] for it in cluster["original_items"]])
        merged_results.append({
            "idx": idx + 1,
            "bounds": cluster["bounds"],
            "combined_text": combined_text
        })

    return merged_results

def inpaint_speech_bubble(crop_region):
    """
    Xóa sạch 100% chữ cũ (Tiếng Anh/Nhật) bên trong bong bóng thoại bằng thuật toán OpenCV Inpainting (Telea).
    Tạo nền bong bóng thoại mượt mà, đồng màu, giữ nguyên nghệ thuật nét vẽ xung quanh.
    """
    if crop_region is None or crop_region.size == 0:
        return crop_region, (255, 255, 255)

    h, w, c = crop_region.shape
    gray = cv2.cvtColor(crop_region, cv2.COLOR_BGR2GRAY)
    
    # 1. Phát hiện vết chữ (chữ đen/tối tương phản trên nền bong bóng sáng)
    mean_val = np.mean(gray)
    if mean_val > 130:
        _, mask = cv2.threshold(gray, 120, 255, cv2.THRESH_BINARY_INV)
        bg_color = (255, 255, 255)
    else:
        _, mask = cv2.threshold(gray, 150, 255, cv2.THRESH_BINARY)
        bgr_color = get_border_mean_color(crop_region)
        bg_color = (bgr_color[2], bgr_color[1], bgr_color[0])

    # 2. Dãn viền mask 3px để xóa sạch vết mờ nét chữ cũ (Anti-aliasing)
    kernel = np.ones((3, 3), np.uint8)
    mask_dilated = cv2.dilate(mask, kernel, iterations=1)

    # 3. Phủ sạch 100% vết chữ cũ bằng thuật toán Inpaint TELEA (giữ nguyên nghệ thuật nét vẽ)
    inpainted = cv2.inpaint(crop_region, mask_dilated, inpaintRadius=3, flags=cv2.INPAINT_TELEA)

    return inpainted, bg_color

def call_ai_with_retry(clients, model_name, messages, temperature=0.3):
    """
    Tự động thử lần lượt danh sách API Key dự phòng và nhớ Key sống để ưu tiên cho các bước sau.
    """
    if not isinstance(clients, list):
        clients = [clients]

    last_err = None
    for idx in range(len(clients)):
        client = clients[0] # Luôn thử client đầu danh sách
        if not client:
            continue
        try:
            return client.chat.completions.create(
                model=model_name,
                messages=messages,
                temperature=temperature
            )
        except Exception as e:
            last_err = e
            key_str = getattr(client, 'api_key', 'Key')
            key_preview = key_str[:12] if key_str else 'Key'
            print(f"🔒 Đã tạm ẩn Key ({key_preview}...) do hết token/rate limit ({e}). Tự động xoay sang Key sống tiếp theo...", flush=True)
            # Chuyển Key hỏng xuống cuối danh sách để các bước sau tự động dùng Key sống!
            if len(clients) > 1:
                failed_client = clients.pop(0)
                clients.append(failed_client)
            continue
    raise last_err or Exception("Tất cả API Key dự phòng đều thất bại.")

def process_single_image(image_path, reader, clients, source_lang, user_instructions=""):
    """
    Quy trình Dịch Truyện Tranh 5 Giai Đoạn Chuyên Nghiệp:
    GĐ 1: Quét OCR & Nghiên cứu bối cảnh (OCR & Bubble detection)
    GĐ 2: Dịch lời thoại & SFX (Dịch ngắn gọn vừa khung thoại)
    GĐ 3: Làm sạch & đặt chữ (Xóa chữ gốc OpenCV Telea + chèn bản dịch PIL Auto-fit)
    GĐ 4: Biên tập & đối chiếu (Kiểm tra thẩm mỹ, ngắt cụm từ, chữ không trào viền)
    GĐ 5: Duyệt & phát hành (Xuất bản trang hoàn thiện)
    """
    output_filename = os.path.basename(image_path) + "_translated.jpg"
    output_path = os.path.join("public", output_filename)

    if not os.path.exists(image_path):
        return None

    print(f"📷 Đang xử lý ảnh: {image_path}", flush=True)

    # ==========================================
    # GĐ 1: QUÉT OCR & NGHIÊN CỨU BỐI CẢNH
    # ==========================================
    print(f"[STATUS]📚 GĐ 1/5: Quét OCR & Nghiên cứu bối cảnh nhân vật...[/STATUS]", flush=True)
    ocr_results = reader.readtext(image_path)

    valid_texts = []
    for idx, (bbox, text, prob) in enumerate(ocr_results):
        if prob > 0.3 and len(text.strip()) > 1:
            valid_texts.append({
                "idx": idx,
                "bbox": bbox,
                "original": text.strip()
            })

    if not valid_texts:
        img_cv = cv2.imread(image_path)
        if img_cv is not None:
            cv2.imwrite(output_path, img_cv)
        print(f"[STATUS]🏆 GĐ 5/5: Không phát hiện chữ thoại. Xuất bản trang gốc![/STATUS]", flush=True)
        return "/" + output_filename

    # Gom các ô chữ kề nhau thành bong bóng thoại hợp nhất
    merged_bubbles = merge_adjacent_bboxes(valid_texts)
    print(f"[STATUS]📚 GĐ 1/5: Đã nhận diện {len(merged_bubbles)} bong bóng thoại. Nghiên cứu bối cảnh...[/STATUS]", flush=True)

    prompt_lines = []
    for item in merged_bubbles:
        prompt_lines.append(f"[{item['idx']}] {item['combined_text']}")
    user_prompt = "\n".join(prompt_lines)

    model_name = os.getenv("DEEPSEEK_MODEL", "deepseek/deepseek-v4-flash")

    # 🤖 AGENT 1: PHÂN TÍCH BỐI CẢNH VISUAL & QUAN HỆ NHÂN VẬT (GĐ 1)
    agent1_system_prompt = f"""Bạn là Chuyên Gia Phân Tích Bối Cảnh Truyện Tranh & Tuyến Phát Triển Nhân Vật.
Nhiệm vụ: Đọc danh sách thoại và Bộ Nhớ / Chỉ Đạo Xưng Hô của người dùng, xác định giai đoạn mối quan hệ và đưa ra BẢNG CHỈ ĐỊNH XƯNG HÔ THỐNG NHẤT 100%.

QUY TẮC BẮT BUỘC VỀ THỐNG NHẤT XƯƠNG HÔ:
1. TUYỆT ĐỐI KHÔNG NỬA NỌ NỬA KỊA: Cấm nhảy từ 'tớ/cậu' sang 'tao/mày' hoặc 'tôi/ngươi' vô lý.
2. TUYẾN PHÁT TRIỂN QUAN HỆ:
   - Giai đoạn Kẻ thù / Xa lạ: Bắt buộc giữ cặp xưng hô 'Tôi - Ngươi' hoặc 'Ta - Ngươi'.
   - Giai đoạn Bạn bè / Đồng minh: Bắt buộc chuyển sang 'Tớ - Cậu' hoặc 'Tôi - Cậu'.
   - Giai đoạn Thân thiết: Bắt buộc giữ 'Anh - Em' hoặc 'Tớ - Cậu'.
3. KÍCH THƯỚC BONG BÓNG: Lưu ý nhắc nhở các đoạn thoại dài cần dịch ngắn gọn súc tích để không tràn khung.

{f"BỘ NHỚ TUYẾN NHÂN VẬT & CHỈ ĐẠO TỪ NGƯỜI DÙNG:\n{user_instructions}\n" if user_instructions else ""}

Hãy phân tích ngắn gọn:
1. Bối cảnh & Giai đoạn quan hệ hiện tại?
2. Bảng hướng dẫn XƯNG HÔ ĐỒNG NHẤT cho từng bong bóng thoại [1], [2], [3]..."""

    context_analysis = ""
    try:
        agent1_res = call_ai_with_retry(
            clients,
            model_name=model_name,
            messages=[
                {"role": "system", "content": agent1_system_prompt},
                {"role": "user", "content": user_prompt}
            ],
            temperature=0.3
        )
        context_analysis = agent1_res.choices[0].message.content.strip()
    except Exception as e:
        context_analysis = "Bối cảnh hội thoại truyện tranh tự nhiên."

    # ==========================================
    # GĐ 2: DỊCH LỜI THOẠI & SFX (NGẮN GỌN VỪA KHUNG THOẠI)
    # ==========================================
    print(f"[STATUS]✍️ GĐ 2/5: Dịch lời thoại & SFX (ưu tiên ngắn gọn vừa khung thoại)...[/STATUS]", flush=True)

    agent2_system_prompt = f"""Bạn là Dịch Giả & Tổng Biên Tập Scanlation Truyện Tranh Chuyên Nghiệp.
Bạn nhận được danh sách thoại gốc VÀ Bản Chỉ Định Xưng Hô Thống Nhất từ Giai Đoạn 1.

BẢN PHÂN TÍCH BỐI CẢNH VÀ BẢNG XƯƠNG HÔ THỐNG NHẤT (GĐ 1):
{context_analysis}

NHIỆM VỤ DỊCH THUẬT SCANLATION (GĐ 2):
1. DỊCH NGẮN GỌN VỪA KHUNG THOẠI: Truyện tranh có bong bóng thoại giới hạn diện tích, hãy ưu tiên câu từ súc tích, đắt giá, KHÔNG viết câu dài dòng lê thê gây tràn khung.
2. DỊCH HIỆU ỨNG ÂM THANH (SFX): Dịch các từ tưởng thanh/tưởng hình (rầm, vèo, rắc, bụp, á...) cô đọng, giàu hình ảnh.
3. ĐỒNG NHẤT XƯƠNG HÔ 100%: Dùng đúng cặp xưng hô do GĐ 1 chỉ định xuyên suốt các câu thoại.
4. VĂN PHONG TỰ NHIÊN: Dịch trôi chảy như người Việt nói chuyện.

FORMAT ĐẦU RA:
- [1] Bản dịch ngắn gọn 1.
- [2] Bản dịch ngắn gọn 2.
- CHỈ TRẢ VỀ DUY NHẤT danh sách thoại đã dịch, không giải thích."""

    ai_response = ""
    try:
        agent2_res = call_ai_with_retry(
            clients,
            model_name=model_name,
            messages=[
                {"role": "system", "content": agent2_system_prompt},
                {"role": "user", "content": f"Danh sách thoại cần dịch:\n{user_prompt}"}
            ],
            temperature=0.3
        )
        ai_response = agent2_res.choices[0].message.content.strip()
    except Exception as apiErr:
        print(f"⚠️ Lỗi API Agent 2 khi dịch ảnh: {apiErr}. Giữ thoại gốc.", flush=True)

    # ==========================================
    # GĐ 4: BIÊN TẬP & ĐỐI CHIẾU THẨM MỸ (DÀN TRANG)
    # ==========================================
    print(f"[STATUS]🔍 GĐ 4/5: Biên tập & đối chiếu (Kiểm tra chữ vừa khung, thẩm mỹ dàn trang)...[/STATUS]", flush=True)

    # Nếu câu thoại dài (>45 ký tự) → Cần Agent 3 tinh chỉnh dàn trang. Nếu ngắn gọn rồi → Dùng luôn để tối ưu tốc độ!
    has_long_dialogue = any(len(line) > 45 for line in ai_response.split('\n') if '[' in line)

    if has_long_dialogue and ai_response:
        agent3_system_prompt = """Bạn là Chuyên Gia Dàn Trang & Đánh Giá Thẩm Mỹ Truyện Tranh (Scanlation Typesetter & Aesthetic Critic).
Nhiệm vụ: Nhận các câu thoại đã dịch từ GĐ 2 và tinh chỉnh ngắt dòng/ngắt cụm từ sao cho đẹp mắt nhất, vừa vặn bong bóng thoại.

QUY TẮC BẮT BUỘC:
1. KHÔNG NGẮT TỪ VÔ LÝ: Ngắt dòng theo cụm từ có nghĩa (ví dụ: 'Chúa tể Vani').
2. TỶ LỆ KHUNG HÌNH BONG BÓNG: Đảm bảo độ dài các dòng cân đối, hình dạng khối chữ sau khi xếp dòng trông tròn trịa/vuông vắn khớp với bong bóng thoại.
3. NGẮN GỌN: Nếu câu dịch quá dài có nguy cơ tràn khung, hãy rút gọn lại mà vẫn giữ nguyên ý nghĩa.
4. GIỮ NGUYÊN NỘI DUNG DỊCH NẾU ĐÃ CHUẨN.

FORMAT ĐẦU RA:
- [1] Bản dịch thẩm mỹ 1.
- [2] Bản dịch thẩm mỹ 2.
- CHỈ TRẢ VỀ DUY NHẤT danh sách thoại đã biên tập."""

        try:
            agent3_res = call_ai_with_retry(
                clients,
                model_name=model_name,
                messages=[
                    {"role": "system", "content": agent3_system_prompt},
                    {"role": "user", "content": f"Yêu cầu tối ưu thẩm mỹ dàn trang cho danh sách thoại sau:\n{ai_response}"}
                ],
                temperature=0.2
            )
            final_aesthetic_response = agent3_res.choices[0].message.content.strip()
            if final_aesthetic_response:
                ai_response = final_aesthetic_response
        except Exception as e:
            print(f"⚠️ Agent Biên tập thẩm mỹ bỏ qua: {e}", flush=True)
    else:
        print(f"✅ Thoại ngắn gọn chuẩn kích thước khung, bỏ qua bước tinh chỉnh thừa để tối ưu tốc độ!", flush=True)

    # Parse kết quả dịch bằng Regex
    translations = {}
    if ai_response:
        pattern = re.compile(r'\[(\d+)\]\s*(.+)')
        for line in ai_response.split('\n'):
            match = pattern.search(line)
            if match:
                idx = int(match.group(1))
                translated_text = match.group(2).strip()
                translations[idx] = translated_text

    # ==========================================
    # GĐ 3: LÀM SẠCH & ĐẶT CHỮ (INPAINTING & TYPESETTING)
    # ==========================================
    print(f"[STATUS]🎨 GĐ 3/5: Làm sạch chữ gốc (OpenCV Telea) & Đặt chữ mới (Auto-fit)...[/STATUS]", flush=True)
    img_cv = cv2.imread(image_path)
    if img_cv is None:
        return None

    img_h, img_w, _ = img_cv.shape

    # 1. Xóa sạch 100% chữ Tiếng Anh/Nhật cũ + GHI NHỚ màu nền của TỪNG bong bóng
    bubble_bg = {}
    for item in merged_bubbles:
        x0, y0, x1, y1 = item["bounds"]
        x0 = max(0, x0 - 4)
        y0 = max(0, y0 - 4)
        x1 = min(img_w, x1 + 4)
        y1 = min(img_h, y1 + 4)

        bubble_bg[item["idx"]] = (255, 255, 255) # mặc định an toàn

        if (x1 - x0) > 0 and (y1 - y0) > 0:
            crop_region = img_cv[y0:y1, x0:x1]
            inpainted_crop, bg_color = inpaint_speech_bubble(crop_region)
            if inpainted_crop is not None and inpainted_crop.size > 0:
                img_cv[y0:y1, x0:x1] = inpainted_crop
            bubble_bg[item["idx"]] = bg_color

    # 2. Chuyển ảnh đã xóa sạch chữ cũ 100% sang PIL để chèn chữ Tiếng Việt mới
    img_pil = Image.fromarray(cv2.cvtColor(img_cv, cv2.COLOR_BGR2RGB))
    draw = ImageDraw.Draw(img_pil)

    for item in merged_bubbles:
        idx = item["idx"]
        x0, y0, x1, y1 = item["bounds"]
        translated_text = translations.get(idx, item["combined_text"])

        x0 = max(0, x0 - 4)
        y0 = max(0, y0 - 4)
        x1 = min(img_w, x1 + 4)
        y1 = min(img_h, y1 + 4)

        box_w = x1 - x0
        box_h = y1 - y0
        
        if box_w <= 0 or box_h <= 0:
            continue
        
        # Auto-fit chữ trong bong bóng thoại hợp nhất
        start_size = min(max(11, box_h - 4), 28)
        final_font = load_font(11)
        final_lines = []
        final_height = 0
        line_spacing = 4
        
        for size in range(int(start_size), 9, -1):
            font = load_font(size)
            lines = wrap_text(translated_text, font, box_w - 6)
            
            total_height = 0
            for line in lines:
                left, top, right, bottom = font.getbbox(line)
                total_height += (bottom - top)
            
            total_height += (len(lines) - 1) * line_spacing
            
            if total_height <= box_h or size == 10:
                final_font = font
                final_lines = lines
                final_height = total_height
                break

        # Căn giữa chiều dọc
        start_y = y0 + max(0, (box_h - final_height) // 2)
        
        # Màu chữ: lấy đúng nền CỦA BONG BÓNG NÀY
        bg = bubble_bg.get(idx, (255, 255, 255))
        brightness = 0.299 * bg[0] + 0.587 * bg[1] + 0.114 * bg[2]
        text_color = (0, 0, 0) if brightness >= 128 else (255, 255, 255)

        for line in final_lines:
            left, top, right, bottom = final_font.getbbox(line)
            line_w = right - left
            line_h = bottom - top
            
            # Căn giữa chiều ngang
            start_x = x0 + max(0, (box_w - line_w) // 2)
            draw.text((start_x, start_y), line, fill=text_color, font=final_font)
            start_y += line_h + line_spacing

    img_cv_result = cv2.cvtColor(np.array(img_pil), cv2.COLOR_RGB2BGR)
    cv2.imwrite(output_path, img_cv_result)
    print(f"[STATUS]🏆 GĐ 5/5: Duyệt & phát hành (Hoàn tất trang ảnh dịch hoàn chỉnh)![/STATUS]", flush=True)
    return "/" + output_filename

def main():
    try:
        if len(sys.argv) < 2:
            print("Lỗi: Cần truyền vào đường dẫn ảnh hoặc danh sách ảnh phân tách bằng dấu phẩy.")
            sys.exit(1)

        raw_input = sys.argv[1]
        source_lang = sys.argv[2] if len(sys.argv) > 2 else 'en'
        user_instructions = sys.argv[3] if len(sys.argv) > 3 else ""
        
        api_base_url = os.getenv("AI_BASE_URL", "https://api.openai.com/v1")
        raw_keys = []
        for var in ["FLASH_API_KEYS", "DEEPSEEK_API_KEYS", "MINIMAX_API_KEYS", "FLASH_API_KEY", "DEEPSEEK_API_KEY", "MINIMAX_API_KEY"]:
            val = os.getenv(var, "")
            if val:
                raw_keys.extend([k.strip() for k in val.split(",") if k.strip()])
        
        valid_keys = []
        for k in raw_keys:
            if k not in valid_keys:
                valid_keys.append(k)
        
        clients = [OpenAI(base_url=api_base_url, api_key=k) for k in valid_keys]
        
        openrouter_key = os.getenv("OPENROUTER_API_KEY")
        if openrouter_key:
            openrouter_base = os.getenv("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1")
            clients.append(OpenAI(
                base_url=openrouter_base,
                api_key=openrouter_key,
                default_headers={
                    "HTTP-Referer": "http://localhost:3000",
                    "X-Title": "Novel Comic Translator"
                }
            ))

        if not clients:
            print("Lỗi: Không tìm thấy API Key nào trong file .env")
            sys.exit(1)

        os.makedirs("public", exist_ok=True)

        image_paths = [p.strip() for p in raw_input.split(',') if p.strip()]

        print(f"🚀 Bắt đầu khởi tạo EasyOCR cho ngôn ngữ [{source_lang}]...", flush=True)
        import torch
        use_gpu = torch.cuda.is_available()
        reader = easyocr.Reader([source_lang], gpu=use_gpu)

        results = []
        total_pages = len(image_paths)

        for idx, img_path in enumerate(image_paths):
            print(f"[STATUS]🔍 Đang quét OCR & Dịch trang {idx + 1}/{total_pages}...", flush=True)
            translated_url = process_single_image(img_path, reader, clients, source_lang, user_instructions)
            if translated_url:
                page_data = {"page": idx + 1, "total": total_pages, "url": translated_url}
                results.append(page_data)
                print(f"[PAGE_DONE]{json.dumps(page_data)}[/PAGE_DONE]", flush=True)

        print("[JSON_RESULT]" + json.dumps(results) + "[/JSON_RESULT]", flush=True)
    except Exception as e:
        print(f"❌ Lỗi hệ thống Python: {str(e)}", flush=True)
        sys.exit(1)

if __name__ == "__main__":
    main()