// public/app.js — BRUH Studio UI Interaction Script (ASVS V3.2.2 & V3.4.3 compliant)

const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

function toast(t) {
  const el = $('#toast');
  if (el) {
    el.textContent = t;
    el.classList.add('show');
    setTimeout(() => el.classList.remove('show'), 3000);
  }
}

// Cookie Helper (cho trình duyệt lưu cả Cookie lẫn localStorage)
function setCookie(name, value, days = 365) {
  const date = new Date();
  date.setTime(date.getTime() + days * 24 * 60 * 60 * 1000);
  const expires = `; expires=${date.toUTCString()}`;
  document.cookie = `${name}=${encodeURIComponent(value || '')}${expires}; path=/; SameSite=Lax`;
}

function getCookie(name) {
  const nameEQ = `${name}=`;
  const ca = document.cookie.split(';');
  for (let i = 0; i < ca.length; i++) {
    let c = ca[i];
    while (c.charAt(0) === ' ') c = c.substring(1, c.length);
    if (c.indexOf(nameEQ) === 0) return decodeURIComponent(c.substring(nameEQ.length, c.length));
  }
  return null;
}

// Tự động lưu toàn bộ dữ liệu form khi nhập
const FORM_FIELDS = [
  'sampleEn', 'sampleVi', 'newUrl', 'notes',
  'seriesName', 'chapterNumber', 'translateModel', 'reviewModel',
  'comicUrl', 'comicNotes', 'sourceLang', 'glossarySearchId'
];

function autoSaveFormData() {
  const config = {};
  FORM_FIELDS.forEach(fieldId => {
    const el = $('#' + fieldId);
    if (el) {
      const val = el.value;
      localStorage.setItem('bruh_' + fieldId, val);
      config[fieldId] = val;
    }
  });
  setCookie('bruh_config', JSON.stringify(config));
}

function autoRestoreFormData() {
  let cookieConfig = {};
  try {
    const rawCookie = getCookie('bruh_config');
    if (rawCookie) cookieConfig = JSON.parse(rawCookie);
  } catch (e) {}

  FORM_FIELDS.forEach(fieldId => {
    const el = $('#' + fieldId);
    if (el) {
      const savedVal = localStorage.getItem('bruh_' + fieldId) ?? cookieConfig[fieldId];
      if (savedVal !== undefined && savedVal !== null) {
        el.value = savedVal;
      }
    }
  });
}

// Gắn sự kiện auto-save cho tất cả các trường
window.addEventListener('DOMContentLoaded', () => {
  autoRestoreFormData();

  FORM_FIELDS.forEach(fieldId => {
    const el = $('#' + fieldId);
    if (el) {
      el.addEventListener('input', autoSaveFormData);
      el.addEventListener('change', autoSaveFormData);
    }
  });
});

// Chuyển Tab
$$('.tab').forEach((tab) => {
  tab.onclick = () => {
    $$('.tab').forEach((t) => t.classList.remove('active'));
    tab.classList.add('active');
    const target = tab.dataset.tab;
    $$('.workspace, .comic-view').forEach((el) => {
      el.style.display = 'none';
    });
    const targetEl = $('#' + target);
    if (targetEl) {
      targetEl.style.display = target === 'comicTab' ? 'grid' : 'grid';
    }
  };
});

// Nút Lưu Cấu Hình Thủ Công
const saveBtn = $('#saveBtn');
if (saveBtn) {
  saveBtn.onclick = () => {
    autoSaveFormData();
    toast('Đã lưu cấu hình tự động (Cookie & Storage).');
  };
}

// ==========================================
// 1. KẾT NỐI SSE STREAMING DỊCH TRUYỆN CHỮ 5 GIAI ĐOẠN
// ==========================================
let currentBoxContentEl = null;

const startTextBtn = $('#startText');
if (startTextBtn) {
  startTextBtn.onclick = async () => {
    autoSaveFormData();
    const urlsSampleEn = $('#sampleEn').value.trim();
    const urlsSampleVi = $('#sampleVi').value.trim();
    const urlNewEn = $('#newUrl').value.trim();
    const userInstructions = $('#notes').value.trim();
    const seriesName = $('#seriesName').value.trim();
    const chapterNumber = $('#chapterNumber').value.trim();
    const translateModel = $('#translateModel').value;
    const reviewModel = $('#reviewModel').value;

    if (!urlNewEn) {
      toast('Hãy nhập link chương mới trước.');
      $('#newUrl').focus();
      return;
    }

    const btn = $('#startText');
    const statusEl = $('#statusText');
    const timelineEl = $('#timeline');

    btn.disabled = true;
    btn.querySelector('span').textContent = '⏳ Đang khởi tạo...';
    statusEl.textContent = 'Đang kết nối phiên dịch 5 giai đoạn...';
    timelineEl.replaceChildren();

    try {
      const response = await fetch('/api/translate-stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          urlsSampleEn, urlsSampleVi, urlNewEn, userInstructions,
          translateModel, reviewModel, seriesName, chapterNumber
        })
      });

      if (!response.ok) {
        const errJson = await response.json().catch(() => ({}));
        throw new Error(errJson.error || 'Lỗi kết nối server');
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split('\n\n');
        buffer = parts.pop();

        for (const part of parts) {
          if (part.startsWith('data: ')) {
            try {
              const event = JSON.parse(part.substring(6));

              if (event.type === 'status') {
                statusEl.textContent = event.data;
              } else if (event.type === 'new_box') {
                const box = document.createElement('div');
                box.className = `stage ${event.colorClass || 'color-gd1'}`;

                const head = document.createElement('div');
                head.className = 'stage-head';
                head.onclick = () => box.classList.toggle('collapsed');

                const label = document.createElement('div');
                label.className = 'stage-label';

                const dot = document.createElement('span');
                dot.className = 'stage-dot';

                const title = document.createElement('span');
                title.className = 'stage-title';
                title.textContent = event.title;

                label.appendChild(dot);
                label.appendChild(title);

                const time = document.createElement('span');
                time.className = 'stage-time';
                time.textContent = 'Stream';

                head.appendChild(label);
                head.appendChild(time);

                const body = document.createElement('div');
                body.className = 'stage-body';

                box.appendChild(head);
                box.appendChild(body);

                timelineEl.appendChild(box);
                currentBoxContentEl = body;
                box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
              } else if (event.type === 'chunk' && currentBoxContentEl) {
                currentBoxContentEl.insertAdjacentText('beforeend', event.data);
                currentBoxContentEl.scrollTop = currentBoxContentEl.scrollHeight;
              } else if (event.type === 'error') {
                statusEl.textContent = `❌ Lỗi: ${event.data}`;
                toast(`❌ Lỗi: ${event.data}`);
              }
            } catch (e) {}
          }
        }
      }

      toast('🎉 Hoàn tất dịch 5 giai đoạn!');
    } catch (err) {
      statusEl.textContent = `❌ Lỗi: ${err.message}`;
      toast(`Lỗi: ${err.message}`);
    } finally {
      btn.disabled = false;
      btn.querySelector('span').textContent = '▶ &nbsp;Bắt đầu quy trình 5 giai đoạn';
    }
  };
}

// ==========================================
// 2. KẾT NỐI PERSISTENT WORKER TRUYỆN TRANH
// ==========================================
const comicInput = $('#comicFileInput');
if (comicInput) {
  comicInput.onchange = (e) => {
    if (e.target.files[0]) {
      $('#fileNameText').textContent = `Đã chọn: ${e.target.files[0].name}`;
    }
  };
}

const startComicBtn = $('#startComic');
if (startComicBtn) {
  startComicBtn.onclick = async () => {
    autoSaveFormData();
    const file = comicInput?.files[0];
    const comicUrl = $('#comicUrl')?.value.trim() || '';
    const sourceLang = $('#sourceLang')?.value || 'en';
    const userInstructions = $('#comicNotes')?.value.trim() || '';
    const btn = $('#startComic');
    const statusMsg = $('#comicStatusMsg');
    const container = $('#comicReaderContainer');

    if (!file && !comicUrl) {
      toast('Vui lòng chọn 1 file ảnh hoặc dán link chapter!');
      return;
    }

    btn.disabled = true;
    btn.querySelector('span').textContent = '⏳ Đang quét OCR...';
    statusMsg.textContent = '⏳ Đang gửi yêu cầu tới OCR Worker Daemon...';
    container.replaceChildren();

    const formData = new FormData();
    if (file) formData.append('image', file);
    if (comicUrl) formData.append('imageUrl', comicUrl);
    formData.append('sourceLang', sourceLang);
    if (userInstructions) formData.append('userInstructions', userInstructions);

    try {
      const response = await fetch('/api/translate-comic', { method: 'POST', body: formData });
      const reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split('\n\n');
        buffer = parts.pop();

        for (const part of parts) {
          if (part.startsWith('data: ')) {
            try {
              const event = JSON.parse(part.substring(6));
              if (event.type === 'status') {
                statusMsg.textContent = event.data;
              } else if (event.type === 'page_done') {
                const { page, total, url } = event.data;
                statusMsg.textContent = `✅ Đã hoàn thành trang ${page}/${total}!`;

                const pageWrapper = document.createElement('div');
                pageWrapper.style.cssText = "text-align:center;width:100%;margin-bottom:20px;";

                const pageTitle = document.createElement('div');
                pageTitle.style.cssText = "font-weight:bold;margin-bottom:8px;color:var(--forest)";
                pageTitle.textContent = `Trang ${page} / ${total}`;

                const img = document.createElement('img');
                img.src = `${url}?t=${Date.now()}`;
                img.style.cssText = "max-width:100%;border:1px solid var(--line);box-shadow:0 8px 16px rgba(0,0,0,0.1)";

                pageWrapper.appendChild(pageTitle);
                pageWrapper.appendChild(img);
                container.appendChild(pageWrapper);
              } else if (event.type === 'finished') {
                statusMsg.textContent = event.data;
                toast(event.data);
              } else if (event.type === 'error') {
                statusMsg.textContent = `❌ Lỗi: ${event.data}`;
              }
            } catch (e) {}
          }
        }
      }
    } catch (err) {
      statusMsg.textContent = `❌ Lỗi kết nối: ${err.message}`;
      toast(`Lỗi: ${err.message}`);
    } finally {
      btn.disabled = false;
      btn.querySelector('span').textContent = '⌁ &nbsp;Quét OCR & dịch ảnh';
    }
  };
}

// ==========================================
// 3. SỔ THUẬT NGỮ UI (Glossary Tab) — SAFE DOM CONSTRUCTION
// ==========================================
async function loadGlossaryUi() {
  const seriesId = $('#glossarySearchId')?.value.trim() || 'default';
  const container = $('#glossaryUiContainer');
  if (!container) return;

  container.textContent = '⏳ Đang tải sổ thuật ngữ...';

  try {
    const res = await fetch(`/api/glossary/${encodeURIComponent(seriesId)}`);
    if (!res.ok) throw new Error('Không tải được dữ liệu');
    const g = await res.json();

    container.replaceChildren();

    if (!g.terms || g.terms.length === 0) {
      const emptyMsg = document.createElement('p');
      emptyMsg.textContent = `${g.seriesId || seriesId}: Chưa có thuật ngữ nào được chốt.`;
      container.appendChild(emptyMsg);
      return;
    }

    const header = document.createElement('p');
    header.textContent = `${g.seriesId} (Version: ${g.version}, Chương cuối: ${g.lastChapter})`;
    container.appendChild(header);

    const hr = document.createElement('hr');
    hr.style.cssText = "border:0;border-top:1px dashed var(--line);margin:10px 0";
    container.appendChild(hr);

    const list = document.createElement('ul');
    g.terms.forEach((t) => {
      const item = document.createElement('li');

      const strongEn = document.createElement('strong');
      strongEn.textContent = t.en;

      const spanVi = document.createElement('span');
      spanVi.style.cssText = "color:var(--forest);font-weight:bold";
      spanVi.textContent = ` → ${t.vi}`;

      const meta = document.createElement('span');
      meta.textContent = ` (${t.type}) ${t.locked ? '🔒 [Chốt]' : ''}`;

      item.appendChild(strongEn);
      item.appendChild(spanVi);
      item.appendChild(meta);
      list.appendChild(item);
    });

    container.appendChild(list);
  } catch (err) {
    container.textContent = `⚠️ Lỗi: ${err.message}`;
  }
}
