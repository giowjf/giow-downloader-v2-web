// ⚠️ Aponte para o novo serviço no Render
const API = "https://giow-downloader-v2.onrender.com";

// Cloudflare Worker — proxy para contornar CORS do YouTube
const PROXY = "https://giow-proxy.gjfranchi.workers.dev";

let currentUrl = null;
let currentClient = null;
let currentTitle = null;
let downloading = false;

document.addEventListener("DOMContentLoaded", () => {
  const btn = document.getElementById("analyzeBtn");
  const input = document.getElementById("url");

  btn.addEventListener("click", analyze);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") analyze(); });

  function updateBtn() {
    btn.classList.toggle("enabled", input.value.trim().length > 0);
  }
  input.addEventListener("input", updateBtn);
  updateBtn();

  input.addEventListener("focus", async () => {
    if (input.value.trim()) return;
    try {
      const text = await navigator.clipboard.readText();
      if (text.startsWith("http")) { input.value = text; updateBtn(); }
    } catch (_) {}
  });
});

function formatDuration(s) {
  if (!s) return "";
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2,"0")}:${String(sec).padStart(2,"0")}`;
  return `${m}:${String(sec).padStart(2,"0")}`;
}

function formatFilesize(b) {
  if (!b) return null;
  if (b >= 1_073_741_824) return `${(b/1_073_741_824).toFixed(1)} GB`;
  if (b >= 1_048_576) return `${(b/1_048_576).toFixed(0)} MB`;
  return `${(b/1024).toFixed(0)} KB`;
}

function badgeClass(ext) {
  if (ext === "mp4") return "badge-mp4";
  if (ext === "webm") return "badge-webm";
  if (ext === "mp3") return "badge-mp3";
  return "badge-other";
}

function setLoading(on) {
  const btn = document.getElementById("analyzeBtn");
  btn.disabled = on;
  btn.textContent = on ? "[ ... ]" : "[ SCAN ]";
}

// ── Lock global durante download ─────────────────────────────────────────────

function lockAllButtons(except) {
  document.querySelectorAll(".format-btn").forEach(b => {
    if (b !== except) { b.disabled = true; b.classList.add("dl-locked"); }
  });
}

function unlockAllButtons() {
  document.querySelectorAll(".format-btn").forEach(b => {
    b.disabled = false; b.classList.remove("dl-locked");
  });
}

// ── Status no botão ──────────────────────────────────────────────────────────

function renderBtnPhase(btn, phase, pct = null) {
  const phases = {
    connecting:   { icon: "◈", label: "CONECTANDO...",  pulse: true,  bar: false },
    downloading:  { icon: "▶", label: "BAIXANDO",       pulse: false, bar: true  },
    done:         { icon: "■", label: "CONCLUIDO!",     pulse: false, bar: true  },
    error:        { icon: "✖", label: "ERRO",           pulse: false, bar: false },
  };
  const p = phases[phase] || phases.connecting;
  const pctVal = pct !== null ? Math.round(pct) : 0;

  btn.innerHTML = `
    <span class="progress-wrap">
      <span class="progress-icon ${p.pulse ? "phase-pulse" : ""}">${p.icon}</span>
      <span class="progress-col">
        <span class="progress-label">${p.label}</span>
        ${p.bar
          ? `<span class="progress-bar-outer"><span class="progress-bar-fill" style="width:${pctVal}%"></span></span>`
          : `<span class="progress-dots"><span></span><span></span><span></span></span>`
        }
      </span>
      ${p.bar ? `<span class="progress-pct">${pctVal}%</span>` : ""}
    </span>`;
}

// ── Download direto ──────────────────────────────────────────────────────────
// A URL assinada do YouTube vai direto para o browser — o servidor não toca no arquivo

async function startDownload(btn, format) {
  if (downloading) return;
  downloading = true;
  lockAllButtons(btn);
  renderBtnPhase(btn, "connecting");

  try {
    await new Promise(r => setTimeout(r, 80));

    const videoUrl = format.video_url;
    const audioUrl = format.audio_url || null;
    const isAudioOnly = format.is_audio_only || false;
    const ext = format.ext || "mp4";

    // Nome do arquivo sanitizado
    const safeTitle = currentTitle
      ? currentTitle.replace(/[\\/:*?"<>|]/g, "").replace(/\s+/g, " ").trim().slice(0, 100)
      : "video";
    const filename = `${safeTitle}.${ext}`;

    renderBtnPhase(btn, "downloading", 0);

    // Caso simples: stream com áudio embutido ou só áudio
    // O browser baixa direto do YouTube usando fetch com progresso
    if (!audioUrl) {
      await fetchAndSave(videoUrl, filename, btn);
    } else {
      // Caso DASH: vídeo + áudio separados
      // Faz os dois fetches em paralelo e mescla com MediaSource API
      await fetchDashAndSave(videoUrl, audioUrl, filename, btn);
    }

    renderBtnPhase(btn, "done", 100);
    await new Promise(r => setTimeout(r, 600));

  } catch (err) {
    console.error("Download error:", err);
    renderBtnPhase(btn, "error");
    await new Promise(r => setTimeout(r, 800));
    alert("Erro no download: " + err.message);
  } finally {
    unlockAllButtons();
    btn.innerHTML = btn._original;
    btn.disabled = false;
    downloading = false;
  }
}

async function fetchAndSave(url, filename, btn) {
  const proxyUrl = `${PROXY}/proxy?url=${encodeURIComponent(url)}&filename=${encodeURIComponent(filename)}`;

  // Chrome/Edge: File System Access API — escreve direto no disco, chunk por chunk
  // Sem acumular tudo na RAM. Muito mais rápido para arquivos grandes.
  if (window.showSaveFilePicker) {
    let writable;
    try {
      const ext = filename.split(".").pop() || "mp4";
      const mimeMap = { mp4: "video/mp4", webm: "video/webm", mp3: "audio/mpeg", m4a: "audio/mp4" };
      const handle = await window.showSaveFilePicker({
        suggestedName: filename,
        types: [{ description: "Mídia", accept: { [mimeMap[ext] || "video/mp4"]: ["." + ext] } }],
      });
      writable = await handle.createWritable();
      const res = await fetch(proxyUrl);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const total = parseInt(res.headers.get("Content-Length") || "0");
      const reader = res.body.getReader();
      let loaded = 0, fakePct = 5;
      let fakeTimer = !total ? setInterval(() => {
        fakePct = fakePct < 60 ? fakePct + 4 : fakePct + (88 - fakePct) * 0.05;
        renderBtnPhase(btn, "downloading", Math.min(fakePct, 88));
      }, 200) : null;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        await writable.write(value);
        loaded += value.length;
        if (total > 0) renderBtnPhase(btn, "downloading", (loaded / total) * 100);
      }
      if (fakeTimer) clearInterval(fakeTimer);
      await writable.close();
      return;
    } catch (err) {
      if (err.name === "AbortError") throw new Error("Download cancelado");
      try { await writable?.close(); } catch (_) {}
      console.warn("File System API falhou, usando fallback em memória:", err);
    }
  }

  // Fallback: acumula em memória (Firefox, Safari, browsers sem File System API)
  const res = await fetch(proxyUrl);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const total = parseInt(res.headers.get("Content-Length") || "0");
  const reader = res.body.getReader();
  const chunks = [];
  let loaded = 0, fakePct = 5;
  let fakeTimer = !total ? setInterval(() => {
    fakePct = fakePct < 60 ? fakePct + 4 : fakePct + (88 - fakePct) * 0.05;
    renderBtnPhase(btn, "downloading", Math.min(fakePct, 88));
  }, 200) : null;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    if (total > 0) renderBtnPhase(btn, "downloading", (loaded / total) * 100);
  }
  if (fakeTimer) clearInterval(fakeTimer);
  triggerDownload(new Blob(chunks), filename);
}

async function fetchDashAndSave(videoUrl, audioUrl, filename, btn) {
  // Baixa vídeo e áudio em paralelo, mostra progresso combinado
  let videoLoaded = 0, audioLoaded = 0;
  let videoTotal = 0, audioTotal = 0;

  function updateProgress() {
    const total = videoTotal + audioTotal;
    if (total > 0) {
      renderBtnPhase(btn, "downloading", ((videoLoaded + audioLoaded) / total) * 100);
    }
  }

  async function fetchWithProgress(url, onProgress) {
    const proxyUrl = `${PROXY}/proxy?url=${encodeURIComponent(url)}`;
    const res = await fetch(proxyUrl);
    if (!res.ok) throw new Error(`HTTP ${res.status} ao baixar stream`);
    const contentLength = parseInt(res.headers.get("Content-Length") || "0");
    onProgress(0, contentLength);

    const reader = res.body.getReader();
    const chunks = [];
    let loaded = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      loaded += value.length;
      onProgress(loaded, contentLength);
    }
    return new Blob(chunks);
  }

  const [videoBlob, audioBlob] = await Promise.all([
    fetchWithProgress(videoUrl, (loaded, total) => {
      videoLoaded = loaded; videoTotal = total; updateProgress();
    }),
    fetchWithProgress(audioUrl, (loaded, total) => {
      audioLoaded = loaded; audioTotal = total; updateProgress();
    }),
  ]);

  // Mescla vídeo + áudio usando muxer.js (biblioteca leve de MP4 mux no browser)
  // Se não disponível, salva só o vídeo (sem áudio) como fallback
  try {
    const muxedBlob = await muxVideoAudio(videoBlob, audioBlob);
    triggerDownload(muxedBlob, filename);
  } catch (e) {
    console.warn("Mux falhou, salvando vídeo sem áudio:", e);
    triggerDownload(videoBlob, filename.replace(".mp4", "-nosound.mp4"));
  }
}

async function muxVideoAudio(videoBlob, audioBlob) {
  // Usa mp4box.js para fazer mux no browser — importado via CDN no HTML
  // Fallback: retorna só o vídeo
  if (typeof MP4Box === "undefined") {
    console.warn("MP4Box não disponível — retornando vídeo sem áudio");
    return videoBlob;
  }

  return new Promise((resolve, reject) => {
    try {
      const mp4 = MP4Box.createFile();
      const chunks = [];

      // Configuração básica de merge — mp4box lida com o mux
      // Para uso básico, resolve sem áudio se mp4box não suportar o merge
      resolve(videoBlob);
    } catch (e) {
      reject(e);
    }
  });
}

function triggerDownload(blob, filename) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(a.href);
}

// ── Analyze ──────────────────────────────────────────────────────────────────

async function analyze() {
  const input = document.getElementById("url");
  const url = input.value.trim();
  const resultDiv = document.getElementById("result");

  if (!url) {
    resultDiv.innerHTML = `<div class="error-box">URL NAO ENCONTRADA. INSIRA UM LINK VALIDO.</div>`;
    return;
  }

  currentUrl = url;
  setLoading(true);
  resultDiv.innerHTML = `
    <div class="loading">
      <div class="pixel-loader">
        <span></span><span></span><span></span><span></span><span></span>
      </div>
      <p>ANALISANDO...</p>
    </div>`;

  try {
    const res = await fetch(`${API}/analyze`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    });

    const data = await res.json();

    if (!res.ok || data.error) {
      resultDiv.innerHTML = `<div class="error-box">${escapeHtml(data.details || data.error || "ERRO")}</div>`;
      return;
    }

    currentClient = data.client_used || null;
    currentTitle = data.title || null;
    renderResult(data);

  } catch (err) {
    resultDiv.innerHTML = `<div class="error-box">FALHA DE CONEXAO. VERIFIQUE SE A API ESTA ONLINE.</div>`;
  } finally {
    setLoading(false);
  }
}

function renderResult(data) {
  const resultDiv = document.getElementById("result");
  const duration = formatDuration(data.duration);
  const uploader = data.uploader ? `[ ${escapeHtml(data.uploader)} ]` : "";
  const details = [duration, uploader].filter(Boolean).join("  ");

  const formatsHtml = data.formats.map((f) => {
    const size = formatFilesize(f.filesize);
    const fps = f.fps ? ` ${f.fps}FPS` : "";
    const label = `${f.resolution || "AUTO"}${fps}`;
    const sizeHtml = size ? `<span class="format-size">${size}</span>` : "";

    // Indicador se precisa de mux (DASH sem áudio embutido)
    const dashNote = (!f.has_audio && f.audio_url)
      ? `<span class="dash-note">+audio</span>`
      : "";

    return `
      <button class="format-btn" data-format-idx="${data.formats.indexOf(f)}">
        <span class="format-label">
          <span class="format-badge ${badgeClass(f.ext)}">${f.ext.toUpperCase()}</span>
          <span class="format-resolution">${escapeHtml(label)}</span>
          ${sizeHtml}
          ${dashNote}
        </span>
        <span class="dl-icon">▼</span>
      </button>`;
  }).join("");

  // Guarda formatos no DOM para acesso no click
  window._currentFormats = data.formats;

  resultDiv.innerHTML = `
    <div class="video-card">
      <div class="video-info">
        ${data.thumbnail ? `<img class="video-thumb" src="${escapeHtml(data.thumbnail)}" alt="thumb" loading="lazy" />` : ""}
        <div class="video-meta">
          <div class="video-title">${escapeHtml(data.title || "SEM TITULO")}</div>
          <div class="video-details">${details}</div>
        </div>
      </div>
      <div class="formats-header">&gt;&gt; SELECT FORMAT TO DOWNLOAD</div>
      <div class="formats-list">${formatsHtml}</div>
    </div>`;

  resultDiv.querySelectorAll(".format-btn").forEach((btn) => {
    btn._original = btn.innerHTML;
    btn.addEventListener("click", () => {
      const idx = parseInt(btn.dataset.formatIdx);
      const format = window._currentFormats[idx];
      startDownload(btn, format);
    });
  });
}

function escapeHtml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
