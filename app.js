/* =======================================================================
   ALŞ08 — WebRTC (P2P) Mesaj ve Dosya Aktarımı
   index.html (masaüstü) ve mobile.html (mobil) tarafından paylaşılır.
   Rol, <body data-role="desktop|mobile"> üzerinden okunur.
   ======================================================================= */
(() => {
  'use strict';

  /* ---------------------- Sabitler ---------------------- */
  const CHUNK_SIZE = 12 * 1024;          // 12 KB'lık parçalar
  const HIGH_WATER = 4 * 1024 * 1024;    // gönderim tamponu üst sınırı
  const LOW_WATER  = 1 * 1024 * 1024;    // alt sınır (drain)

  const ROLE = document.body.dataset.role || 'desktop';
  const $ = (sel, root = document) => root.querySelector(sel);

  const S = {
    peer: null,
    conn: null,
    open: false,
    queue: [],            // gönderim kuyruğu (tek dosya akar)
    sending: false,
    incoming: null,       // alınmakta olan dosya
    stream: null,
    scanning: false,
    detector: null
  };

  /* ---------------------- Yardımcılar ---------------------- */
  const escapeHtml = s => String(s).replace(/[&<>"']/g, c =>
    ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));

  function formatSize(n) {
    if (n < 1024) return n + ' B';
    const u = ['KB', 'MB', 'GB', 'TB'];
    let i = -1;
    do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
    return n.toFixed(n < 10 ? 2 : 1) + ' ' + u[i];
  }

  function iconFor(mime = '', name = '') {
    if (mime.startsWith('image/')) return '🖼️';
    if (mime.startsWith('video/')) return '🎬';
    if (mime.startsWith('audio/')) return '🎵';
    if (/\.pdf$/i.test(name))                     return '📕';
    if (/\.(zip|rar|7z|tar|gz)$/i.test(name))     return '🗜️';
    if (/\.(doc|docx|txt|rtf)$/i.test(name))      return '📄';
    if (/\.(xls|xlsx|csv)$/i.test(name))          return '📊';
    if (/\.(ppt|pptx)$/i.test(name))              return '📽️';
    return '📦';
  }

  function uid() {
    if (crypto.randomUUID) return crypto.randomUUID();
    return 'id-' + Math.random().toString(36).slice(2) + '-' + Date.now().toString(36);
  }

  function makePeerId() {
    const abc = 'abcdefghijkmnpqrstuvwxyz23456789';
    const a = new Uint8Array(9);
    crypto.getRandomValues(a);
    return 'als08-' + Array.from(a, b => abc[b % abc.length]).join('');
  }

  function setStatus(text, kind) {
    const el = $('#status');
    if (!el) return;
    el.textContent = text;
    el.className = 'status' + (kind ? ' ' + kind : '');
  }

  function scrollBottom() {
    const c = $('#chat');
    if (c) c.scrollTop = c.scrollHeight;
  }

  function showChat() {
    $('#screenConnect')?.classList.add('hidden');
    $('#screenChat')?.classList.remove('hidden');
    $('#msgInput')?.focus();
    scrollBottom();
  }

  /* ---------------------- Sohbet / Arayüz ---------------------- */
  function addBubble(dir, node) {
    const wrap = document.createElement('div');
    wrap.className = 'msg ' + dir;
    const b = document.createElement('div');
    b.className = 'bubble';
    b.appendChild(node);
    wrap.appendChild(b);
    $('#chat').appendChild(wrap);
    scrollBottom();
    return wrap;
  }

  function addTextMessage(text, dir) {
    const p = document.createElement('div');
    p.className = 'text';
    p.textContent = text;
    addBubble(dir, p);
  }

  function createFileCard({ name, size, mime }) {
    const card = document.createElement('div');
    card.className = 'file-card';
    card.innerHTML = `
      <div class="file-head">
        <span class="file-icon">${iconFor(mime, name)}</span>
        <div class="file-meta">
          <div class="file-name">${escapeHtml(name)}</div>
          <div class="file-size">${formatSize(size)}</div>
        </div>
      </div>
      <div class="preview"></div>
      <div class="bar"><span></span></div>
      <div class="pct">%0</div>`;
    return card;
  }

  function setProgress(card, ratio) {
    const pct = Math.max(0, Math.min(100, Math.round(ratio * 100)));
    const bar = card.querySelector('.bar > span');
    const lbl = card.querySelector('.pct');
    if (bar) bar.style.width = pct + '%';
    if (lbl) lbl.textContent = '%' + pct;
  }

  function finishCard(card, blob, dir, name, mime) {
    card.querySelector('.bar')?.remove();
    card.querySelector('.pct')?.remove();
    setProgress(card, 1);

    const url = URL.createObjectURL(blob);
    const prev = card.querySelector('.preview');
    const type = (blob.type || mime || '');

    if (type.startsWith('image/')) {
      const img = document.createElement('img');
      img.src = url; img.alt = name; img.loading = 'lazy';
      prev.appendChild(img);
    } else if (type.startsWith('video/')) {
      const v = document.createElement('video');
      v.src = url; v.controls = true; v.playsInline = true; v.preload = 'metadata';
      prev.appendChild(v);
    } else if (type.startsWith('audio/')) {
      const a = document.createElement('audio');
      a.src = url; a.controls = true;
      prev.appendChild(a);
    }

    const a = document.createElement('a');
    a.href = url;
    a.download = name || 'dosya';
    a.className = 'btn ghost small';
    a.textContent = dir === 'in' ? '⬇ İndir' : '⬇ Cihaza kaydet';
    prev.appendChild(a);
  }

  /* ---------------------- Dosya okuma (FileReader) ---------------------- */
  function readChunk(blob) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload  = () => resolve(fr.result);      // ArrayBuffer
      fr.onerror = () => reject(fr.error);
      fr.readAsArrayBuffer(blob);
    });
  }

  /* ---------------------- Gönderim (backpressure) ---------------------- */
  function dataChannel() {
    if (!S.conn) return null;
    return S.conn.dataChannel || S.conn._dc || null;
  }

  function waitDrain() {
    const dc = dataChannel();
    if (!dc || dc.bufferedAmount <= HIGH_WATER) return Promise.resolve();
    dc.bufferedAmountLowThreshold = LOW_WATER;
    return new Promise(resolve => {
      const h = () => { dc.removeEventListener('bufferedamountlow', h); resolve(); };
      dc.addEventListener('bufferedamountlow', h);
    });
  }

  async function sendBinary(buf) {
    await waitDrain();
    S.conn.send(buf);
  }

  /* ---------------------- Dosya gönderme ---------------------- */
  function enqueueFile(file) {
    if (!S.open) return;
    S.queue.push(file);
    processQueue();
  }

  async function processQueue() {
    if (S.sending || !S.open) return;
    const file = S.queue.shift();
    if (!file) return;

    S.sending = true;
    try { await sendFile(file); }
    catch (err) { console.error('Gönderim hatası:', err); }
    S.sending = false;
    processQueue();
  }

  async function sendFile(file) {
    const id      = uid();
    const total   = Math.ceil(file.size / CHUNK_SIZE);
    const card    = createFileCard({ name: file.name, size: file.size, mime: file.type });
    addBubble('out', card);

    S.conn.send(JSON.stringify({
      t: 'file-start', id,
      name: file.name, size: file.size,
      mime: file.type || 'application/octet-stream',
      chunks: total
    }));

    let offset = 0;
    for (let i = 0; i < total; i++) {
      const blob = file.slice(offset, offset + CHUNK_SIZE);
      const buf  = await readChunk(blob);       // FileReader → ArrayBuffer
      await sendBinary(buf);
      offset += buf.byteLength;
      setProgress(card, offset / file.size);
    }

    S.conn.send(JSON.stringify({ t: 'file-end', id }));
    finishCard(card, file, 'out', file.name, file.type);
  }

  /* ---------------------- Alma ---------------------- */
  function pushChunk(u8) {
    const inc = S.incoming;
    if (!inc) return;
    inc.chunks.push(u8);
    inc.received += u8.byteLength;
    setProgress(inc.card, inc.size ? inc.received / inc.size : 1);
  }

  function finishIncoming() {
    const inc = S.incoming;
    if (!inc) return;
    S.incoming = null;
    const blob = new Blob(inc.chunks, { type: inc.mime || 'application/octet-stream' });
    finishCard(inc.card, blob, 'in', inc.name, inc.mime);
  }

  /* ---------------------- Veri yönlendirici ---------------------- */
  function onData(data) {
    /* --- Metin / kontrol mesajları --- */
    if (typeof data === 'string') {
      let msg;
      try { msg = JSON.parse(data); } catch { return; }

      switch (msg.t) {
        case 'text':
          addTextMessage(msg.body, 'in');
          break;

        case 'file-start': {
          const card = createFileCard({ name: msg.name, size: msg.size, mime: msg.mime });
          addBubble('in', card);
          S.incoming = { ...msg, chunks: [], received: 0, card };
          break;
        }

        case 'file-end':
          finishIncoming();
          break;
      }
      return;
    }

    /* --- İkili parçalar (sıra korunur) --- */
    if (data instanceof ArrayBuffer) {
      pushChunk(new Uint8Array(data));
    } else if (ArrayBuffer.isView(data)) {
      pushChunk(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    } else if (data instanceof Blob) {
      data.arrayBuffer().then(b => pushChunk(new Uint8Array(b)));
    }
  }

  /* ---------------------- Bağlantı kurulumu ---------------------- */
  function attach(conn) {
    S.conn = conn;

    conn.on('open', () => {
      S.open = true;
      setStatus('Bağlı ✓ — uçtan uca şifreli', 'ok');
      stopScan();
      showChat();
      processQueue();
    });

    conn.on('data', onData);

    conn.on('close', () => {
      S.open = false;
      setStatus('Bağlantı kapandı', 'err');
      addTextMessage('— Bağlantı sonlandırıldı —', 'in');
    });

    conn.on('error', err => {
      console.error('Conn error:', err);
      setStatus('Bağlantı hatası', 'err');
    });
  }

  /* ---------------------- PeerJS ---------------------- */
  const PEER_OPTS = {
    debug: 1,
    config: {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:global.stun.twilio.com:3478' }
      ]
    }
  };

  function startDesktop() {
    const id = makePeerId();
    const peer = new Peer(id, PEER_OPTS);
    S.peer = peer;

    peer.on('open', pid => {
      setStatus('Telefon bekleniyor…', 'wait');
      const url = mobileUrl(pid);
      $('#codeText').value = pid;
      renderQR(url);
    });

    peer.on('connection', conn => {
      if (S.conn && S.conn.open) { try { conn.close(); } catch {} return; }
      attach(conn);
    });

    peer.on('error', err => {
      console.warn('Peer error:', err.type);
      if (err.type === 'unavailable-id') { try { peer.destroy(); } catch {} startDesktop(); return; }
      setStatus('Hata: ' + err.type, 'err');
    });

    $('#copyCode')?.addEventListener('click', async () => {
      const v = $('#codeText').value;
      try { await navigator.clipboard.writeText(v); setStatus('Kod kopyalandı', 'ok'); }
      catch { $('#codeText').select(); }
    });
  }

  function mobileUrl(pid) {
    const base = location.href.split('#')[0].split('?')[0].replace(/[^/]*$/, 'mobile.html');
    return base + '#p=' + encodeURIComponent(pid);
  }

  function renderQR(text) {
    const box = $('#qrBox');
    if (!box) return;
    box.innerHTML = '';

    if (typeof window.qrcode !== 'function') {
      box.innerHTML = '<p class="muted small" style="word-break:break-all">' + escapeHtml(text) + '</p>';
      return;
    }

    const qr = window.qrcode(0, 'M');   // tip 0 = otomatik sürüm
    qr.addData(text);
    qr.make();

    let svg;
    try { svg = qr.createSvgTag({ cellSize: 6, margin: 4, scalable: true }); }
    catch { svg = qr.createSvgTag(6, 4); }
    box.innerHTML = svg;
  }

  function startMobile() {
    const peer = new Peer(PEER_OPTS);   // rastgele kimlik
    S.peer = peer;

    peer.on('open', () => {
      setStatus('QR kod okutun', 'wait');
      // Doğrudan link ile gelindiyse (native kamera) otomatik bağlan
      const fromHash = new URLSearchParams(location.hash.replace(/^#/, '')).get('p');
      if (fromHash) { connectTo(fromHash); return; }
      startScan();
    });

    peer.on('error', err => {
      console.warn('Peer error:', err.type);
      if (err.type === 'peer-unavailable') {
        setStatus('Karşı cihaz bulunamadı — tekrar deneyin', 'err');
        startScan();
      } else {
        setStatus('Hata: ' + err.type, 'err');
      }
    });

    $('#connectBtn')?.addEventListener('click', () => {
      const id = parsePeerId($('#codeInput').value);
      if (id) connectTo(id);
      else setStatus('Geçersiz kod', 'err');
    });

    $('#codeInput')?.addEventListener('keydown', e => {
      if (e.key === 'Enter') $('#connectBtn').click();
    });
  }

  function connectTo(peerId) {
    stopScan();
    setStatus('Bağlanıyor…', 'wait');
    const conn = S.peer.connect(peerId, { reliable: true });
    attach(conn);
  }

  function parsePeerId(text) {
    text = (text || '').trim();
    if (!text) return null;
    try {
      const u = new URL(text);
      const p = u.searchParams.get('p') ||
                (u.hash.startsWith('#p=') ? decodeURIComponent(u.hash.slice(3)) : null);
      if (p) return p;
    } catch { /* URL değil */ }
    if (/^[A-Za-z0-9][A-Za-z0-9 _-]{2,80}$/.test(text)) return text;
    return null;
  }

  /* ---------------------- QR Tarayıcı ---------------------- */
  async function startScan() {
    if (S.scanning) return;
    const video = $('#scanVideo');
    if (!video) return;

    try {
      S.stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false
      });
      video.srcObject = S.stream;
      await video.play();
      S.scanning = true;
      setStatus('QR kod okutun', 'wait');
      scanLoop();
    } catch (err) {
      console.error('Kamera hatası:', err);
      setStatus('Kamera açılamadı — kodu elle girin', 'err');
      document.querySelector('.manual')?.setAttribute('open', '');
    }
  }

  function stopScan() {
    S.scanning = false;
    if (S.stream) { S.stream.getTracks().forEach(t => t.stop()); S.stream = null; }
    const v = $('#scanVideo');
    if (v) v.srcObject = null;
  }

  async function scanLoop() {
    const video  = $('#scanVideo');
    const canvas = $('#scanCanvas');
    if (!video || !canvas) return;

    while (S.scanning) {
      await new Promise(r => setTimeout(r, 120));
      if (!S.scanning) return;
      if (video.readyState < 2 || !video.videoWidth) continue;

      canvas.width  = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

      let found = null;

      /* 1) Yerleşik BarcodeDetector (Android Chrome) */
      if ('BarcodeDetector' in window) {
        try {
          if (!S.detector) S.detector = new window.BarcodeDetector({ formats: ['qr_code'] });
          const codes = await S.detector.detect(canvas);
          if (codes && codes.length) found = codes[0].rawValue;
        } catch { /* yoksay */ }
      }

      /* 2) jsQR yedeği */
      if (!found && typeof window.jsQR === 'function') {
        const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const res = window.jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
        if (res && res.data) found = res.data;
      }

      if (found) {
        const id = parsePeerId(found);
        if (id) { connectTo(id); return; }
      }
    }
  }

  /* ---------------------- Metin gönderme ---------------------- */
  function sendText() {
    const input = $('#msgInput');
    const v = input.value.trim();
    if (!v || !S.open) return;
    S.conn.send(JSON.stringify({ t: 'text', body: v }));
    addTextMessage(v, 'out');
    input.value = '';
    input.focus();
  }

  /* ---------------------- Olay bağlama ---------------------- */
  function bindCommonUI() {
    $('#sendBtn')?.addEventListener('click', sendText);
    $('#msgInput')?.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendText(); }
    });

    $('#fileBtn')?.addEventListener('click', () => $('#fileInput').click());
    $('#fileInput')?.addEventListener('change', e => {
      [...e.target.files].forEach(enqueueFile);
      e.target.value = '';
    });

    /* Sürükle-bırak (masaüstü) */
    window.addEventListener('dragover', e => e.preventDefault());
    window.addEventListener('drop', e => {
      e.preventDefault();
      if (!S.open || !e.dataTransfer) return;
      [...e.dataTransfer.files].forEach(enqueueFile);
    });
  }

  /* ---------------------- PWA ---------------------- */
  function registerSW() {
    if ('serviceWorker' in navigator) {
      window.addEventListener('load', () => {
        navigator.serviceWorker.register('./sw.js').catch(err => console.warn('SW:', err));
      });
    }
  }

  /* ---------------------- Başlat ---------------------- */
  function init() {
    bindCommonUI();
    registerSW();
    if (ROLE === 'mobile') startMobile();
    else startDesktop();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();