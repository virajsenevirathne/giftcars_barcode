/* Gift Card Wallet - import QR vouchers from PDFs, store locally, show as cards. */

const STORAGE_KEY = 'gcw.cards.v1';
const SETTINGS_KEY = 'gcw.settings.v1';

const state = {
  cards: loadCards(),
  settings: loadSettings(),
  grouped: false,
  pendingValuePrompt: null,
};

/* ----------------------- Persistence ----------------------- */
function loadCards() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || []; }
  catch { return []; }
}
function saveCards() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state.cards));
}
function loadSettings() {
  try { return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || { showUsed: true }; }
  catch { return { showUsed: true }; }
}
function saveSettings() {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings));
}

/* ----------------------- Utils ----------------------- */
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
const fmt = (n) => '$' + (Math.round(n * 100) / 100).toLocaleString();

function setImportStatus(msg, kind = '') {
  const el = $('#importStatus');
  if (!msg) { el.classList.add('hidden'); el.textContent = ''; return; }
  el.className = 'import-status' + (kind ? ' ' + kind : '');
  el.textContent = msg;
  el.classList.remove('hidden');
}

/* ----------------------- PDF.js setup ----------------------- */
let pdfjsReady = null;
function ensurePdfJs() {
  if (pdfjsReady) return pdfjsReady;
  pdfjsReady = (async () => {
    if (!window.pdfjsLib) throw new Error('pdf.js failed to load (network blocked?)');
    if (!window.jsQR)     throw new Error('jsQR failed to load (network blocked?)');

    // Try to use the web-worker. If it can't be loaded (e.g. file:// origin, CSP),
    // fall back to running PDF.js on the main thread by disabling the worker.
    try {
      const url = window.__PDFJS_WORKER_URL__;
      const resp = await fetch(url, { method: 'GET', mode: 'cors' });
      if (!resp.ok) throw new Error('worker HTTP ' + resp.status);
      // Construct a blob worker URL so it's same-origin (avoids file:// cross-origin block).
      const code = await resp.text();
      const blob = new Blob([code], { type: 'application/javascript' });
      pdfjsLib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(blob);
    } catch (err) {
      console.warn('PDF.js worker unavailable, falling back to main-thread mode.', err);
      // Disable the worker entirely; PDF.js will run synchronously on the main thread.
      try { pdfjsLib.GlobalWorkerOptions.workerSrc = ''; } catch {}
      try { pdfjsLib.GlobalWorkerOptions.workerPort = null; } catch {}
      // PDF.js v3 still tries to spawn a worker unless disableWorker is true at getDocument time.
    }
  })();
  return pdfjsReady;
}

/* ----------------------- PDF -> QR pipeline ----------------------- */
async function importFiles(files) {
  if (!files || !files.length) return;

  try {
    await ensurePdfJs();
  } catch (e) {
    setImportStatus('Setup failed: ' + e.message, 'error');
    return;
  }

  let totalFound = 0, errorFiles = [];
  for (let f = 0; f < files.length; f++) {
    const file = files[f];
    setImportStatus(`Scanning ${file.name} (${f + 1}/${files.length})…`);
    try {
      const found = await scanPdf(file);
      console.log(`[wallet] ${file.name}: found ${found.length} QR(s)`);
      totalFound += found.length;
      for (const item of found) {
        await addCard(item.data, item.value, file.name, item.page);
      }
      if (!found.length) errorFiles.push(`${file.name} (no QR found)`);
    } catch (e) {
      console.error('PDF scan failed', file.name, e);
      errorFiles.push(`${file.name} (${e.message || e})`);
    }
  }
  render();
  if (totalFound === 0) {
    setImportStatus('No QR codes detected. ' + (errorFiles.join('; ') || 'Try a clearer PDF.'), 'error');
  } else if (errorFiles.length) {
    setImportStatus(`Imported ${totalFound} card(s). Issues: ${errorFiles.join('; ')}`, 'error');
  } else {
    setImportStatus(`Imported ${totalFound} card(s) from ${files.length} PDF(s).`, 'success');
  }
  setTimeout(() => setImportStatus(''), 8000);
}

async function loadPdf(buf) {
  // First attempt: with worker (or whatever workerSrc is set to).
  try {
    return await pdfjsLib.getDocument({ data: buf }).promise;
  } catch (e1) {
    console.warn('getDocument failed, retrying with disableWorker:true', e1);
    // Retry forcing no worker — works around blob-worker / CSP issues.
    return await pdfjsLib.getDocument({ data: buf, disableWorker: true, isEvalSupported: false }).promise;
  }
}

async function scanPdf(file) {
  const buf = await file.arrayBuffer();
  // Re-slice into a fresh ArrayBuffer so a retry isn't blocked by a detached buffer.
  const data = new Uint8Array(buf.slice(0));
  const pdf = await loadPdf(data);
  const found = [];
  const seenForFile = new Set();

  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);

    let pageText = '';
    try {
      const tc = await page.getTextContent();
      pageText = tc.items.map(i => i.str).join(' ');
    } catch {}

    const qrPayloads = await detectQRsOnPage(page, p);
    if (!qrPayloads.length) {
      console.log(`[wallet] page ${p}: no QR detected`);
      continue;
    }

    const detectedValue = detectValue(pageText);
    console.log(`[wallet] page ${p}: ${qrPayloads.length} QR(s), detectedValue=${detectedValue}`);
    for (const data of qrPayloads) {
      if (seenForFile.has(data)) continue;
      seenForFile.add(data);
      found.push({ data, value: detectedValue, page: p });
    }
  }
  return found;
}

async function detectQRsOnPage(page, pageNum) {
  // Try multiple scales; gift-card QRs vary wildly in size on the page.
  const scales = [3, 2, 4, 1.5, 5];
  const seen = new Set();
  const out = [];

  for (const scale of scales) {
    const vp = page.getViewport({ scale });
    const w = Math.floor(vp.width), h = Math.floor(vp.height);
    // Guard against absurdly large allocations
    if (w * h > 36_000_000) continue;

    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    // White background so transparent PDFs scan correctly
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    try {
      await page.render({ canvasContext: ctx, viewport: vp, background: 'rgba(255,255,255,1)' }).promise;
    } catch (e) {
      console.warn(`[wallet] render failed at scale ${scale}`, e);
      continue;
    }

    // 1) Whole-page scan, both inversions
    {
      const img = ctx.getImageData(0, 0, w, h);
      const c = jsQR(img.data, img.width, img.height, { inversionAttempts: 'attemptBoth' });
      if (c && c.data && !seen.has(c.data)) { seen.add(c.data); out.push(c.data); }
    }

    // 2) Tile scan — finds multiple QRs per page and small QRs
    const tile = 700;
    const step = Math.floor(tile * 0.6);
    if (w > tile || h > tile) {
      for (let y = 0; y < h; y += step) {
        for (let x = 0; x < w; x += step) {
          const tw = Math.min(tile, w - x);
          const th = Math.min(tile, h - y);
          if (tw < 120 || th < 120) continue;
          const img = ctx.getImageData(x, y, tw, th);
          const c = jsQR(img.data, img.width, img.height, { inversionAttempts: 'attemptBoth' });
          if (c && c.data && !seen.has(c.data)) { seen.add(c.data); out.push(c.data); }
        }
      }
    }

    if (out.length) break; // good enough
  }
  return out;
}

function detectValue(text) {
  if (!text) return null;
  // Look for $X, $X.YY, X dollars, EUR/GBP variants, "value: $X", etc.
  const patterns = [
    /(?:value|amount|balance|worth|denomination)[^\d]{0,12}([£€$]?)\s?(\d{1,5}(?:[.,]\d{1,2})?)/i,
    /([£€$])\s?(\d{1,5}(?:[.,]\d{1,2})?)/,
    /(\d{1,5}(?:[.,]\d{1,2})?)\s?(?:dollars|euros|pounds|usd|eur|gbp)/i,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m) {
      const numStr = m[2] || m[1];
      const n = parseFloat(String(numStr).replace(',', '.'));
      if (!isNaN(n) && n > 0 && n < 100000) return n;
    }
  }
  return null;
}

async function addCard(data, detectedValue, source, page) {
  // De-dup by QR payload
  if (state.cards.some(c => c.data === data)) return;
  let value = detectedValue;
  if (value == null) {
    value = await promptForValue(data, source, page);
    if (value == null) return; // user skipped
  }
  state.cards.push({
    id: uid(),
    data,
    value: Number(value),
    used: false,
    source: source || '',
    page: page || 1,
    createdAt: Date.now(),
  });
  saveCards();
}

function promptForValue(data, source, page) {
  return new Promise((resolve) => {
    state.pendingValuePrompt = { data, source, page, resolve };
    $('#valueModalSub').textContent = `Couldn't detect a value for QR on ${source || 'PDF'}${page ? ' page ' + page : ''}. Enter it manually:`;
    $('#valueInput').value = '';
    showModal('#valueModal');
    setTimeout(() => $('#valueInput').focus(), 100);
  });
}

/* ----------------------- Rendering ----------------------- */
function totalUnused() {
  return state.cards.filter(c => !c.used).reduce((s, c) => s + (Number(c.value) || 0), 0);
}

function render() {
  // Totals
  const unusedCount = state.cards.filter(c => !c.used).length;
  $('#totalValue').textContent = fmt(totalUnused());
  $('#totalSub').textContent = `${unusedCount} of ${state.cards.length} card${state.cards.length === 1 ? '' : 's'} available`;

  // Empty state
  const empty = state.cards.length === 0;
  $('#emptyState').classList.toggle('hidden', !empty);

  const cards = $('#cards');
  cards.innerHTML = '';
  cards.classList.toggle('grouped', state.grouped);

  // Filter
  const list = state.cards.filter(c => state.settings.showUsed || !c.used);
  // Sort: unused first, then used; within each by value desc; used at bottom of stack
  list.sort((a, b) => {
    if (a.used !== b.used) return a.used ? 1 : -1;
    return b.value - a.value;
  });

  if (state.grouped) {
    renderGrouped(cards, list);
  } else {
    renderFlat(cards, list);
  }

  // Group button active state
  $('#groupBtn').classList.toggle('active', state.grouped);
}

function renderFlat(container, list) {
  for (const c of list) {
    container.appendChild(makeCardEl(c));
  }
}

function renderGrouped(container, list) {
  // Group by value
  const byValue = new Map();
  for (const c of list) {
    const k = String(c.value);
    if (!byValue.has(k)) byValue.set(k, []);
    byValue.get(k).push(c);
  }
  // Sort group keys by value desc
  const keys = [...byValue.keys()].sort((a, b) => Number(b) - Number(a));
  for (const k of keys) {
    const items = byValue.get(k);
    // Sort within group: unused first (front), used last (back of stack)
    items.sort((a, b) => (a.used === b.used) ? (b.createdAt - a.createdAt) : (a.used ? 1 : -1));

    const groupEl = document.createElement('div');
    groupEl.className = 'group';
    const unusedInGroup = items.filter(i => !i.used).length;
    const totalInGroup = items.reduce((s, i) => s + (i.used ? 0 : Number(i.value)), 0);
    groupEl.innerHTML = `
      <div class="group-head">
        <div class="group-title">${fmt(Number(k))} cards</div>
        <div class="group-meta">${unusedInGroup}/${items.length} available · ${fmt(totalInGroup)}</div>
      </div>
    `;
    const stack = document.createElement('div');
    stack.className = 'stack';

    // Used cards are at the back of the stack (drawn first, smaller, deeper offset)
    items.forEach((c, idx) => {
      const card = makeCardEl(c);
      // Z-index: unused on top
      const depthIdx = c.used ? idx + items.length : idx;
      const offsetY = idx * 8;
      const offsetX = (idx - (items.length - 1) / 2) * 4;
      const scale = 1 - idx * 0.025;
      card.style.zIndex = String(1000 - depthIdx);
      card.style.transform = `translateX(calc(-50% + ${offsetX}px)) translateY(${offsetY}px) scale(${scale})`;
      stack.appendChild(card);
    });

    groupEl.appendChild(stack);
    container.appendChild(groupEl);
  }
}

function makeCardEl(c) {
  const el = document.createElement('div');
  el.className = 'card' + (c.used ? ' used' : '');
  el.dataset.id = c.id;
  el.innerHTML = `
    <div class="used-stamp">USED</div>
    <div class="card-qr"></div>
    <div class="card-foot">
      <div class="card-value">${fmt(c.value)}</div>
      <button class="card-toggle" title="Toggle used" aria-label="Toggle used"></button>
    </div>
  `;
  // Render QR
  const qrHost = el.querySelector('.card-qr');
  qrHost.appendChild(renderQR(c.data, 4));

  // Click card -> open modal
  el.addEventListener('click', (e) => {
    if (e.target.closest('.card-toggle')) return;
    openCardModal(c.id);
  });
  // Toggle used directly
  el.querySelector('.card-toggle').addEventListener('click', (e) => {
    e.stopPropagation();
    toggleUsed(c.id);
  });
  return el;
}

function renderQR(data, cellSize = 4) {
  // qrcode-generator library
  let qr;
  // Try error correction levels from high to low; high may overflow for very long data
  for (const ec of ['M', 'L', 'Q', 'H']) {
    try {
      // typeNumber 0 = auto
      qr = qrcode(0, ec);
      qr.addData(data);
      qr.make();
      break;
    } catch (e) { qr = null; }
  }
  const wrap = document.createElement('div');
  wrap.style.width = '100%'; wrap.style.height = '100%';
  if (!qr) {
    wrap.textContent = 'QR error';
    wrap.style.color = '#000';
    wrap.style.display = 'flex';
    wrap.style.alignItems = 'center';
    wrap.style.justifyContent = 'center';
    return wrap;
  }
  // Use SVG for crisp scaling
  wrap.innerHTML = qr.createSvgTag({ scalable: true, margin: 0 });
  const svg = wrap.querySelector('svg');
  if (svg) {
    svg.setAttribute('width', '100%');
    svg.setAttribute('height', '100%');
    svg.style.display = 'block';
  }
  return wrap;
}

/* ----------------------- Card actions ----------------------- */
function toggleUsed(id) {
  const c = state.cards.find(x => x.id === id);
  if (!c) return;
  c.used = !c.used;
  saveCards();
  render();
}
function deleteCard(id) {
  const i = state.cards.findIndex(x => x.id === id);
  if (i >= 0) {
    state.cards.splice(i, 1);
    saveCards();
    render();
  }
}
function updateValue(id, newValue) {
  const c = state.cards.find(x => x.id === id);
  if (!c) return;
  c.value = Number(newValue);
  saveCards();
  render();
}

/* ----------------------- Modals ----------------------- */
function showModal(sel) { $(sel).classList.remove('hidden'); }
function hideModal(sel) { $(sel).classList.add('hidden'); }
function hideAllModals() { $$('.modal').forEach(m => m.classList.add('hidden')); }

let activeCardId = null;

function openCardModal(id) {
  const c = state.cards.find(x => x.id === id);
  if (!c) return;
  activeCardId = id;
  $('#modalValue').textContent = fmt(c.value);
  const qrHost = $('#modalQr');
  qrHost.innerHTML = '';
  qrHost.appendChild(renderQR(c.data, 8));
  $('#modalData').textContent = c.data;
  $('#toggleUsedBtn').textContent = c.used ? 'Mark unused' : 'Mark used';
  showModal('#qrModal');
}

/* ----------------------- Wiring ----------------------- */
function wireUp() {
  // Import button
  $('#pdfInput').addEventListener('change', async (e) => {
    const files = [...e.target.files];
    e.target.value = ''; // allow re-selecting the same file later
    try {
      await importFiles(files);
    } catch (err) {
      console.error('Import threw', err);
      setImportStatus('Import error: ' + (err && err.message ? err.message : err), 'error');
    }
  });

  // Group toggle
  $('#groupBtn').addEventListener('click', () => {
    state.grouped = !state.grouped;
    render();
  });

  // Menu
  $('#menuBtn').addEventListener('click', () => {
    $('#showUsedToggle').checked = state.settings.showUsed;
    showModal('#menuSheet');
  });
  $('#showUsedToggle').addEventListener('change', (e) => {
    state.settings.showUsed = e.target.checked;
    saveSettings();
    render();
  });
  $('#exportBtn').addEventListener('click', exportBackup);
  $('#importBackup').addEventListener('change', importBackup);
  $('#resetUsedBtn').addEventListener('click', () => {
    if (!state.cards.length) return;
    if (!confirm('Mark all cards as unused?')) return;
    state.cards.forEach(c => c.used = false);
    saveCards(); render();
    hideAllModals();
  });
  $('#clearAllBtn').addEventListener('click', () => {
    if (!state.cards.length) return;
    if (!confirm(`Delete ALL ${state.cards.length} cards? This can't be undone.`)) return;
    state.cards = [];
    saveCards(); render();
    hideAllModals();
  });

  // Modal close handlers (any [data-close])
  document.addEventListener('click', (e) => {
    if (e.target.matches('[data-close]')) {
      hideAllModals();
      if (state.pendingValuePrompt) {
        state.pendingValuePrompt.resolve(null);
        state.pendingValuePrompt = null;
      }
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      hideAllModals();
      if (state.pendingValuePrompt) {
        state.pendingValuePrompt.resolve(null);
        state.pendingValuePrompt = null;
      }
    }
  });

  // Card modal actions
  $('#toggleUsedBtn').addEventListener('click', () => {
    if (!activeCardId) return;
    toggleUsed(activeCardId);
    const c = state.cards.find(x => x.id === activeCardId);
    if (c) $('#toggleUsedBtn').textContent = c.used ? 'Mark unused' : 'Mark used';
  });
  $('#deleteBtn').addEventListener('click', () => {
    if (!activeCardId) return;
    if (!confirm('Delete this card?')) return;
    deleteCard(activeCardId);
    activeCardId = null;
    hideModal('#qrModal');
  });
  $('#editValueBtn').addEventListener('click', () => {
    if (!activeCardId) return;
    const c = state.cards.find(x => x.id === activeCardId);
    if (!c) return;
    const v = prompt('New value:', String(c.value));
    if (v == null) return;
    const n = parseFloat(v);
    if (isNaN(n) || n < 0) { alert('Invalid value'); return; }
    updateValue(activeCardId, n);
    $('#modalValue').textContent = fmt(n);
  });

  // Value prompt modal
  $('#valueModal').querySelectorAll('.chip').forEach(chip => {
    chip.addEventListener('click', () => {
      $('#valueInput').value = chip.dataset.v;
    });
  });
  $('#valueOkBtn').addEventListener('click', () => {
    const v = parseFloat($('#valueInput').value);
    if (isNaN(v) || v < 0) { alert('Enter a valid value'); return; }
    if (state.pendingValuePrompt) {
      state.pendingValuePrompt.resolve(v);
      state.pendingValuePrompt = null;
    }
    hideModal('#valueModal');
  });
}

/* ----------------------- Backup ----------------------- */
function exportBackup() {
  const blob = new Blob([JSON.stringify({ version: 1, cards: state.cards }, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `giftcard-wallet-${new Date().toISOString().slice(0,10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

async function importBackup(e) {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try {
    const text = await f.text();
    const obj = JSON.parse(text);
    if (!obj || !Array.isArray(obj.cards)) throw new Error('bad file');
    let added = 0;
    for (const c of obj.cards) {
      if (!c.data || c.value == null) continue;
      if (state.cards.some(x => x.data === c.data)) continue;
      state.cards.push({
        id: c.id || uid(),
        data: c.data,
        value: Number(c.value),
        used: !!c.used,
        source: c.source || 'backup',
        page: c.page || 1,
        createdAt: c.createdAt || Date.now(),
      });
      added++;
    }
    saveCards();
    render();
    setImportStatus(`Imported ${added} card(s) from backup.`, 'success');
    setTimeout(() => setImportStatus(''), 3000);
    hideAllModals();
  } catch (err) {
    setImportStatus('Backup file is invalid.', 'error');
  }
}

/* ----------------------- Boot ----------------------- */
document.addEventListener('DOMContentLoaded', () => {
  wireUp();
  render();
});
