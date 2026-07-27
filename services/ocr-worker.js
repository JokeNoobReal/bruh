import { spawn } from 'child_process';
import path from 'path';
import readline from 'readline';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const PYTHON_CANDIDATES = process.env.PYTHON_BIN
  ? [process.env.PYTHON_BIN]
  : (process.platform === 'win32' ? ['py', 'python', 'python3'] : ['python3', 'python']);

const READY_TIMEOUT_MS = Number(process.env.OCR_READY_TIMEOUT_MS || 180_000);
const JOB_TIMEOUT_MS = Number(process.env.OCR_JOB_TIMEOUT_MS || 600_000);
const IDLE_SHUTDOWN_MS = Number(process.env.OCR_IDLE_SHUTDOWN_MS || 0); // 0 = không tắt
const STATUS_RE = /\[STATUS\](.*?)\[\/STATUS\]/;

class OcrWorker {
  constructor() {
    this.proc = null;
    this.readyPromise = null;
    this.queue = [];
    this.current = null;
    this.idleTimer = null;
    this.restarts = 0;
    this.activeBinIndex = 0;
  }

  // ── Vòng đời tiến trình ────────────────────────────────
  ensure() {
    if (this.proc && !this.proc.killed && this.readyPromise) return this.readyPromise;
    return this.#start();
  }

  #start() {
    const bin = PYTHON_CANDIDATES[this.activeBinIndex % PYTHON_CANDIDATES.length];
    const proc = spawn(bin, ['comic_worker.py'], {
      cwd: ROOT,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.proc = proc;

    this.readyPromise = new Promise((resolve, reject) => {
      const t = setTimeout(
        () => reject(new Error('OCR worker không sẵn sàng kịp thời hạn')),
        READY_TIMEOUT_MS
      );
      this._onReady = () => { clearTimeout(t); this.restarts = 0; resolve(this); };
      this._onReadyFail = (err) => { clearTimeout(t); reject(err); };
    });

    readline.createInterface({ input: proc.stdout }).on('line', (l) => this.#onMessage(l));
    readline.createInterface({ input: proc.stderr }).on('line', (l) => this.#onLog(l));

    proc.on('error', (err) => {
      this.activeBinIndex++;
      this.#onExit(err);
    });
    proc.on('exit', (code, sig) => {
      if (code === 9009 || code === 9008 || code === 127) {
        this.activeBinIndex++;
      }
      this.#onExit(new Error(`OCR worker thoát (code=${code}, signal=${sig})`));
    });

    return this.readyPromise;
  }

  #onExit(err) {
    if (this.proc) this.proc.removeAllListeners();
    this.proc = null;
    this.readyPromise = null;
    this._onReadyFail?.(err);

    if (this.current) {
      clearTimeout(this.current.timer);
      this.current.reject(err);
      this.current = null;
    }
    // Job còn xếp hàng vẫn giữ, sẽ chạy lại sau khi worker hồi sinh
    if (this.queue.length) {
      const backoff = Math.min(30_000, 1000 * 2 ** this.restarts++);
      console.warn(`⚠️ ${err.message}. Khởi động lại sau ${backoff}ms...`);
      setTimeout(() => this.#pump(), backoff);
    }
  }

  // ── Kênh dữ liệu ───────────────────────────────────────
  #onMessage(line) {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }

    if (msg.type === 'ready') { this._onReady?.(); return; }
    if (!this.current || (msg.id && msg.id !== this.current.id)) return;

    if (msg.type === 'page') {
      this.current.onPage?.({ page: msg.page, total: msg.total, url: msg.url });
      this.current.results.push({ page: msg.page, total: msg.total, url: msg.url });
    } else if (msg.type === 'done') {
      const job = this.#finish();
      job.resolve(msg.results?.length ? msg.results : job.results);
    } else if (msg.type === 'error') {
      const job = this.#finish();
      job.reject(new Error(msg.message || 'OCR worker báo lỗi'));
    }
  }

  #onLog(line) {
    const m = STATUS_RE.exec(line);
    if (m && this.current?.onStatus) this.current.onStatus(m[1]);
    else console.log(`[ocr] ${line}`);
  }

  #finish() {
    const job = this.current;
    clearTimeout(job.timer);
    this.current = null;
    this.#scheduleIdleShutdown();
    setImmediate(() => this.#pump());
    return job;
  }

  // ── Hàng đợi (chạy tuần tự, OCR/GPU không song song được) ──
  translate({ images, lang = 'en', instructions = '', onStatus, onPage }) {
    return new Promise((resolve, reject) => {
      this.queue.push({
        id: crypto.randomUUID(),
        images, lang, instructions,
        onStatus, onPage,
        results: [],
        resolve, reject,
      });
      this.#pump();
    });
  }

  async #pump() {
    if (this.current || !this.queue.length) return;
    clearTimeout(this.idleTimer);

    try {
      await this.ensure();
    } catch (err) {
      const job = this.queue.shift();
      job?.reject(err);
      return;
    }
    if (this.current || !this.queue.length) return;

    const job = this.queue.shift();
    this.current = job;
    job.timer = setTimeout(() => {
      console.warn('⏱️ Job OCR quá hạn, giết worker để giải phóng.');
      this.proc?.kill('SIGKILL');
    }, JOB_TIMEOUT_MS);

    this.proc.stdin.write(
      JSON.stringify({
        id: job.id,
        type: 'translate',
        images: job.images,
        lang: job.lang,
        instructions: job.instructions,
      }) + '\n'
    );
  }

  #scheduleIdleShutdown() {
    if (!IDLE_SHUTDOWN_MS) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (!this.current && !this.queue.length && this.proc) {
        console.log('💤 Worker rảnh lâu, tắt để trả RAM/VRAM.');
        this.proc.stdin.write(JSON.stringify({ type: 'shutdown' }) + '\n');
      }
    }, IDLE_SHUTDOWN_MS);
  }

  shutdown() {
    this.queue.length = 0;
    if (this.proc) {
      try { this.proc.stdin.write(JSON.stringify({ type: 'shutdown' }) + '\n'); } catch {}
      setTimeout(() => this.proc?.kill('SIGKILL'), 3000).unref?.();
    }
  }
}

export const ocrWorker = new OcrWorker();

export function warmupOcrWorker() {
  ocrWorker.ensure()
    .then(() => console.log('✅ OCR worker đã sẵn sàng.'))
    .catch((e) => console.warn(`⚠️ Không làm nóng được OCR worker: ${e.message}`));
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { ocrWorker.shutdown(); process.exit(0); });
}
