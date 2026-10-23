// Panel s obrazovkou emulátoru: kreslí snímky ze serveru, hraje zvuk, posílá klávesy.

/**
 * Značky paprsku (příkaz serveru `raster`: x, y v prostoru 320 × 256, −1 mimo obraz) v pixelech
 * překryvné vrstvy `width` × `height` (velká jako framebuffer, obvykle 640 × 256):
 * `line` = vodorovný pruh přes aktuální řádek, `mark` = svislá značka na sloupci (null, když je
 * paprsek v zatemnění řádku). Paprsek mimo obraz (y < 0) → null.
 */
function rasterMarks(r, width, height) {
    const num = (v) => typeof v === 'number' && isFinite(v);
    if (!r || !num(r.y) || r.y < 0 || r.y >= 256 || !(width > 0) || !(height > 0)) return null;
    const sx = width / 320;
    const sy = height / 256;
    const rowH = Math.max(1, Math.round(sy));
    const line = { x: 0, y: Math.min(height - rowH, Math.floor(r.y * sy)), w: width, h: rowH };
    let mark = null;
    if (num(r.x) && r.x >= 0 && r.x < 320) {
        const w = Math.max(2, Math.round(sx));
        const top = Math.max(0, Math.floor((r.y - 6) * sy));
        const bottom = Math.min(height, Math.ceil((r.y + 7) * sy));
        mark = { x: Math.min(width - w, Math.floor(r.x * sx)), y: top, w, h: bottom - top };
    }
    return { line, mark };
}

/** Text o poloze paprsku do lišty: [klíč, …argumenty] nebo null (bez dat). */
function rasterLabel(r) {
    if (!r || typeof r !== 'object') return null;
    const num = (v) => (typeof v === 'number' && isFinite(v) ? v : '?');
    if (typeof r.y === 'number' && r.y >= 0 && typeof r.x === 'number' && r.x >= 0) return ['screen.beamPos', r.y, r.x];
    return ['screen.beamOutside', num(r.vc), num(r.hc)];
}

// Testy (node) si funkce načtou přes require; ve webview `module` není.
if (typeof module !== 'undefined' && module.exports) module.exports = { rasterMarks, rasterLabel };

if (typeof acquireVsCodeApi === 'function') (function () {
    const vscode = acquireVsCodeApi();
    const canvas = document.getElementById('screen');
    const ctx = canvas.getContext('2d');
    const status = document.getElementById('status');
    const pauseBtn = document.getElementById('pause');
    const soundBtn = document.getElementById('sound');
    const overlay = document.getElementById('overlay');
    const octx = overlay.getContext('2d');
    let image = null;
    let attached = false;
    let running = false;
    let highlight = null;   // {x, y, w, h} v prostoru 320×256 z panelu Next
    const beamBtn = document.getElementById('beam');
    const rasterText = document.getElementById('raster');
    const saved = vscode.getState() || {};
    let beamOn = saved.beam !== false;   // poloha paprsku po zastavení (tlačítko v liště)
    let raster = null;                   // odpověď serveru `raster` pro aktuální zastavení
    let rasterSeq = 0;

    // ---- překlady: slovník vybraného jazyka vloží rozšíření (window.L10N, src/i18n.ts)
    const l10n = window.L10N || { lang: 'en', texts: {} };

    /** Text podle klíče; {0}, {1} … nahradí argumenty; bez překladu vrátí klíč. */
    function t(key, ...args) {
        const s = l10n.texts[key] ?? key;
        return args.length ? s.replace(/\{(\d+)\}/g, (m, i) => (i < args.length ? String(args[i]) : m)) : s;
    }

    // KeyboardEvent.code → SDL scancode (jádro JNEXT mapuje klávesy PC na klávesnici Spectra).
    const SC = {
        Enter: 40, Escape: 41, Backspace: 42, Tab: 43, Space: 44, Minus: 45, Equal: 46,
        BracketLeft: 47, BracketRight: 48, Backslash: 49, Semicolon: 51, Quote: 52, Backquote: 53,
        Comma: 54, Period: 55, Slash: 56, CapsLock: 57,
        ArrowRight: 79, ArrowLeft: 80, ArrowDown: 81, ArrowUp: 82,
        Insert: 73, Home: 74, PageUp: 75, Delete: 76, End: 77, PageDown: 78,
        ControlLeft: 224, ShiftLeft: 225, AltLeft: 226, ControlRight: 228, ShiftRight: 229, AltRight: 230,
    };
    for (let i = 0; i < 26; i++) SC['Key' + String.fromCharCode(65 + i)] = 4 + i;
    for (let i = 1; i <= 9; i++) SC['Digit' + i] = 29 + i;
    SC.Digit0 = 39;
    for (let i = 1; i <= 12; i++) SC['F' + i] = 57 + i;

    function key(e, down) {
        const sc = SC[e.code];
        if (sc === undefined || !attached) return;
        if (e.repeat) { e.preventDefault(); return; }
        vscode.postMessage({ type: 'key', scancode: sc, down });
        e.preventDefault();
        e.stopPropagation();
    }
    canvas.addEventListener('keydown', (e) => key(e, true));
    canvas.addEventListener('keyup', (e) => key(e, false));
    canvas.addEventListener('blur', () => vscode.postMessage({ type: 'releaseKeys' }));
    canvas.addEventListener('mousedown', () => {
        canvas.focus();
        startAudio();
    });

    pauseBtn.addEventListener('click', () => vscode.postMessage({ type: 'togglePause' }));
    document.getElementById('next').addEventListener('click', () => vscode.postMessage({ type: 'showNextView' }));

    // ---- paprsek: po zastavení se zeptá na polohu (raster), za běhu nic
    function requestRaster() {
        raster = null;
        rasterSeq++;
        if (beamOn && attached && !running) vscode.postMessage({ type: 'raster', seq: rasterSeq });
        drawHighlight();
    }
    function showBeamButton() {
        beamBtn.classList.toggle('on', beamOn);
        beamBtn.setAttribute('aria-pressed', String(beamOn));
    }
    beamBtn.addEventListener('click', () => {
        beamOn = !beamOn;
        vscode.setState({ ...(vscode.getState() || {}), beam: beamOn });
        showBeamButton();
        requestRaster();
    });
    showBeamButton();

    function drawRaster() {
        const show = beamOn && attached && !running && raster;
        const label = show ? rasterLabel(raster) : null;
        rasterText.textContent = label ? t(...label) : '';
        rasterText.title = show && typeof raster.vc === 'number' ? `VC ${raster.vc}, HC ${raster.hc}` : '';
        const m = show ? rasterMarks(raster, overlay.width, overlay.height) : null;
        if (!m) return;
        octx.fillStyle = 'rgba(0, 255, 255, 0.55)';
        octx.fillRect(m.line.x, m.line.y, m.line.w, m.line.h);
        if (m.mark) {
            octx.fillStyle = '#ff30ff';
            octx.fillRect(m.mark.x, m.mark.y, m.mark.w, m.mark.h);
            octx.lineWidth = 1;
            octx.strokeStyle = 'rgba(0, 0, 0, 0.8)';
            octx.strokeRect(m.mark.x - 0.5, m.mark.y - 0.5, m.mark.w + 1, m.mark.h + 1);
        }
    }

    // ---- zvýraznění: překryvná vrstva velká jako framebuffer (640×256 = 320×256 zdvojené vodorovně)
    function drawHighlight() {
        if (overlay.width !== canvas.width || overlay.height !== canvas.height) {
            overlay.width = canvas.width;
            overlay.height = canvas.height;
        }
        octx.clearRect(0, 0, overlay.width, overlay.height);
        drawRaster();
        if (!highlight) return;
        const sx = overlay.width / 320;
        const sy = overlay.height / 256;
        const x = Math.round(highlight.x * sx);
        const y = Math.round(highlight.y * sy);
        const w = Math.max(1, Math.round(highlight.w * sx));
        const h = Math.max(1, Math.round(highlight.h * sy));
        octx.fillStyle = 'rgba(255, 255, 0, 0.25)';
        octx.fillRect(x, y, w, h);
        octx.lineWidth = 2;
        octx.strokeStyle = '#ffff00';
        octx.strokeRect(x - 1, y - 1, w + 2, h + 2);
    }

    // ---- zvuk: Int16 stereo 44,1 kHz, bloky plánované těsně za sebou
    let audio = null;
    let soundOn = false;
    let playAt = 0;
    let rate = 1;
    const LATENCY = 0.08;   // s, rezerva proti výpadkům
    function startAudio() {
        if (audio) return;
        try {
            audio = new AudioContext({ sampleRate: 44100 });
            soundOn = true;
            updateSound();
        } catch (e) {
            audio = null;
        }
    }
    function updateSound() {
        soundBtn.textContent = soundOn ? '🔊' : '🔇';
        vscode.postMessage({ type: 'audio', on: soundOn });
    }
    soundBtn.addEventListener('click', () => {
        if (!audio) startAudio();
        else {
            soundOn = !soundOn;
            updateSound();
        }
    });
    function playAudio(samples) {
        if (!audio || !soundOn || !running) return;
        const n = samples.length >> 1;
        if (!n) return;
        const buf = audio.createBuffer(2, n, 44100);
        const l = buf.getChannelData(0);
        const r = buf.getChannelData(1);
        for (let i = 0; i < n; i++) {
            l[i] = samples[2 * i] / 32768;
            r[i] = samples[2 * i + 1] / 32768;
        }
        const src = audio.createBufferSource();
        src.buffer = buf;
        src.connect(audio.destination);
        // Fronta kolem LATENCY: když emulace nestíhá (fronta ubývá), hraje se o pár procent
        // pomaleji, místo aby vznikla mezera; když předbíhá, o kousek rychleji.
        const now = audio.currentTime;
        let fill = playAt - now;
        if (fill < 0.005 || fill > 0.3) {
            playAt = now + LATENCY;
            fill = LATENCY;
            rate = 1;
        }
        const want = Math.min(1.02, Math.max(0.9, 1 + (0.1 * (fill - LATENCY)) / LATENCY));
        rate += (want - rate) * 0.2;
        src.playbackRate.value = rate;
        src.start(playAt);
        playAt += n / 44100 / rate;
    }

    function showStatus() {
        if (!attached) status.textContent = t('screen.waiting');
        else status.textContent = running ? t('screen.running') : t('screen.stopped');
        pauseBtn.textContent = running ? '⏸' : '▶';
        pauseBtn.disabled = !attached;
    }

    window.addEventListener('message', (ev) => {
        const m = ev.data;
        switch (m.type) {
            case 'frame': {
                if (!image || image.width !== m.width || image.height !== m.height) {
                    canvas.width = m.width;
                    canvas.height = m.height;
                    image = ctx.createImageData(m.width, m.height);
                    drawHighlight();
                }
                image.data.set(m.data);
                ctx.putImageData(image, 0, 0);
                break;
            }
            case 'speed':
                if (running) status.textContent = t('screen.runningFps', m.fps.toLocaleString(l10n.lang));
                break;
            case 'audio':
                playAudio(m.data);
                break;
            case 'state':
                running = m.running;
                showStatus();
                requestRaster();
                break;
            case 'attached':
                attached = true;
                showStatus();
                break;
            case 'detached':
                attached = false;
                running = false;
                highlight = null;
                raster = null;
                drawHighlight();
                showStatus();
                break;
            case 'raster':
                if (m.seq !== rasterSeq || running) break;   // odpověď na starší zastavení
                raster = m.data || null;
                drawHighlight();
                break;
            case 'highlight':
                highlight = m.rect || null;
                drawHighlight();
                break;
        }
    });
    showStatus();
    vscode.postMessage({ type: 'ready' });
})();
