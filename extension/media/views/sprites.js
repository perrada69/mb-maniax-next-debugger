// Pohled „Sprity“: tabulka 128 spritů s náhledy vzorů, ořezové okno a mini-mapa.
// Hardware podle JNEXT video/sprites.cpp (adresa vzoru, 4bit, paletový offset, ořez); relativní sprity rozvádí server.
(function () {
    'use strict';

    const ID = 'sprites';
    const N = 128;
    const MAP_W = 320;
    const MAP_H = 256;

    // 3bitová složka → 8 bitů (smlouva: (c << 5) | (c << 2) | (c >> 1))
    const C3 = [];
    for (let c = 0; c < 8; c++) C3.push((c << 5) | (c << 2) | (c >> 1));

    // Výchozí paleta spritů (RRRGGGBB identita, modrý LSB = B1 | B0) – když server palety nevrátí.
    function defaultBank() {
        const a = [];
        for (let i = 0; i < 256; i++) a.push((i << 1) | ((i | (i >> 1)) & 1));
        return a;
    }

    // Paleta (256 × RGB333) → RGB bajty po trojicích
    function paletteRgb(bank) {
        const out = new Uint8Array(768);
        for (let i = 0; i < 256; i++) {
            const c = bank[i] | 0;
            out[i * 3] = C3[(c >> 6) & 7];
            out[i * 3 + 1] = C3[(c >> 3) & 7];
            out[i * 3 + 2] = C3[c & 7];
        }
        return out;
    }

    // Adresa vzoru v pattern RAM podle čísla, které hardware čte (server `pattern`):
    // 8bit N5:N0 × 256 B, 4bit N5:N0:N6 × 128 B (sprites.cpp:1047, :1064)
    function patternAddr(pattern, is4bit) {
        return (is4bit ? pattern << 7 : pattern << 8) & 0x3fff;
    }

    // Sprity ze serveru (relativní už rozvedené ke kotvě); syrové atributy jen do tooltipu
    function fromServer(list, attrs) {
        const out = [];
        for (let i = 0; i < N; i++) {
            const f = list[i] || {};
            const is4bit = !!f.is4bit;
            const p = f.pattern | 0;
            const raw = attrs && attrs.length >= (i + 1) * 5 ? Array.from(attrs.subarray(i * 5, i * 5 + 5)) : null;
            out.push({
                x: f.x | 0, y: f.y | 0, visible: !!f.visible, is4bit,
                pattern: p, addr: patternAddr(p, is4bit), pal: (f.paletteOffset | 0) & 15,
                xm: !!f.xMirror, ym: !!f.yMirror, rot: !!f.rotate,
                xs: (f.xScale | 0) & 3, ys: (f.yScale | 0) & 3,
                relative: !!f.relative, anchor: typeof f.anchor === 'number' ? f.anchor : -1, raw,
            });
        }
        return out;
    }

    // Index barvy pixelu (px, py) vzoru, nebo -1 = průhledný (sprites.cpp:1043-1079)
    function pixelIndex(ram, addr, is4bit, pal, transp, px, py) {
        if (!is4bit) {
            const v = ram[(addr + (py << 4) + px) & 0x3fff];
            if (v === transp) return -1;
            return ((((v >> 4) + pal) & 15) << 4) | (v & 15);
        }
        const raw = ram[(addr + (py << 3) + (px >> 1)) & 0x3fff];
        const nib = px & 1 ? raw & 15 : raw >> 4;
        if (nib === (transp & 15)) return -1;
        return (pal << 4) | nib;
    }

    // Vzor 16 × 16 do RGBA (out = ImageData.data); volitelně se zrcadlením a rotací jako na obrazovce
    function drawPattern(out, ram, s, transp, rgb, transform) {
        const rot = transform && s.rot;
        const ym = transform && s.ym;
        const xmEff = transform && (s.xm !== s.rot);
        let o = 0;
        for (let row = 0; row < 16; row++) {
            const yi = ym ? 15 - row : row;
            for (let col = 0; col < 16; col++) {
                let px = xmEff ? 15 - col : col;
                let py = yi;
                if (rot) { const t = px; px = py; py = t; }
                const idx = pixelIndex(ram, s.addr, s.is4bit, s.pal, transp, px, py);
                if (idx < 0) {
                    out[o] = out[o + 1] = out[o + 2] = out[o + 3] = 0;
                } else {
                    out[o] = rgb[idx * 3];
                    out[o + 1] = rgb[idx * 3 + 1];
                    out[o + 2] = rgb[idx * 3 + 2];
                    out[o + 3] = 255;
                }
                o += 4;
            }
        }
    }

    // Obdélník spritu v prostoru 320 × 256 (9bitové souřadnice se přetáčí přes 512)
    function spriteRect(s) {
        const w = 16 << s.xs;
        const h = 16 << s.ys;
        let x = s.x;
        let y = s.y;
        if (x + w > 512) x -= 512;
        if (y + h > 512) y -= 512;
        return { x, y, w, h };
    }

    // Skutečné ořezové okno v prostoru 320 × 256 (sprites.cpp:975-1002; NR $15 b1 přes okraj, b5 ořez okraje)
    function clipRect(clip, nr15) {
        const x1 = clip.x1 & 0xff, x2 = clip.x2 & 0xff, y1 = clip.y1 & 0xff, y2 = clip.y2 & 0xff;
        const overBorder = (nr15 & 0x02) !== 0;
        const borderClip = (nr15 & 0x20) !== 0;
        if (overBorder && !borderClip) return { x1: 0, x2: 319, y1: 0, y2: 255 };
        if (overBorder) return { x1: x1 * 2, x2: x2 * 2 + 1, y1, y2 };
        const sh = (v) => ((((v >> 5) & 7) + 1) << 5) | (v & 31);
        return { x1: sh(x1), x2: sh(x2), y1: sh(y1), y2: Math.min(sh(y2), 223) };
    }

    let api = null;
    let root = null;
    let rows = [];
    let sprites = [];
    let hovered = -1;
    let selected = -1;
    let busy = false;
    let lastSig = '';
    let version = 0;
    let nr15 = 0;
    let clipWin = null;
    const ui = {};

    function setText(node, v) {
        const s = String(v);
        if (node.textContent !== s) node.textContent = s;
    }

    function cssVar(name, fallback) {
        const v = getComputedStyle(root).getPropertyValue(name).trim();
        return v || fallback;
    }

    const CSS = `
#view-sprites .sp-wrap { display: flex; flex-wrap: wrap; gap: 12px; align-items: flex-start; }
#view-sprites .sp-table-box { flex: 1 1 520px; min-width: 0; overflow: auto; max-height: 70vh; }
#view-sprites table { border-collapse: collapse; width: 100%; }
#view-sprites th, #view-sprites td { padding: 1px 6px; text-align: right; white-space: nowrap; }
#view-sprites th { position: sticky; top: 0; background: var(--vscode-editor-background); color: var(--vscode-descriptionForeground); font-weight: normal; border-bottom: 1px solid var(--vscode-panel-border); }
#view-sprites tbody tr { cursor: pointer; }
#view-sprites tbody tr:hover { background: var(--vscode-list-hoverBackground); }
#view-sprites tbody tr.selected { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
#view-sprites tr.off { opacity: 0.55; }
#view-sprites td.pv { padding: 1px 4px; }
#view-sprites canvas.thumb { display: block; background: repeating-conic-gradient(rgba(128,128,128,0.35) 0 25%, transparent 0 50%) 0 0 / 8px 8px; }
#view-sprites .sp-map { flex: 0 0 auto; }
#view-sprites .sp-map canvas { display: block; border: 1px solid var(--vscode-panel-border); cursor: crosshair; }
#view-sprites .sp-sum { margin: 4px 0 8px; }
#view-sprites .sp-sum span { margin-right: 14px; }
#view-sprites .warn { color: var(--vscode-editorWarning-foreground); }
#view-sprites .err { color: var(--vscode-errorForeground); }
`;

    const COLS = ['#', NextView.t('sprites.colAnchor'), 'X', 'Y', NextView.t('sprites.colPattern'), NextView.t('sprites.colPal'),
        NextView.t('sprites.colVisible'), NextView.t('sprites.colMirrorRot'), '4bit', NextView.t('sprites.colScale'), NextView.t('sprites.colPreview')];

    function buildTable() {
        const table = api.el('table', { class: 'table mono' });
        const thead = api.el('thead');
        const hr = api.el('tr');
        for (const c of COLS) hr.appendChild(api.el('th', {}, c));
        thead.appendChild(hr);
        table.appendChild(thead);
        const tbody = api.el('tbody');
        rows = [];
        for (let i = 0; i < N; i++) {
            const tr = api.el('tr');
            const cells = [];
            for (let c = 0; c < COLS.length - 1; c++) {
                const td = api.el('td');
                tr.appendChild(td);
                cells.push(td);
            }
            const pv = api.el('td', { class: 'pv' });
            const canvas = api.canvas(16, 16, 2);
            canvas.classList.add('thumb');
            pv.appendChild(canvas);
            tr.appendChild(pv);
            const ctx = canvas.getContext('2d');
            const img = ctx.createImageData(16, 16);
            setText(cells[0], i);
            tr.addEventListener('mouseenter', () => { hovered = i; applyHighlight(); });
            tr.addEventListener('mouseleave', () => { if (hovered === i) hovered = -1; applyHighlight(); });
            tr.addEventListener('click', () => select(selected === i ? -1 : i, false));
            tbody.appendChild(tr);
            rows.push({ tr, cells, canvas, ctx, img, key: '', title: '' });
        }
        table.appendChild(tbody);
        return table;
    }

    function select(i, scroll) {
        if (selected >= 0) rows[selected].tr.classList.remove('selected');
        selected = i;
        if (i >= 0) {
            rows[i].tr.classList.add('selected');
            if (scroll && rows[i].tr.style.display !== 'none') rows[i].tr.scrollIntoView({ block: 'nearest' });
        }
        applyHighlight();
    }

    function applyHighlight() {
        const k = hovered >= 0 ? hovered : selected;
        if (api) api.highlight(k >= 0 && sprites[k] ? spriteRect(sprites[k]) : null);
        drawMap();
    }

    function hexAttrs(raw) {
        return raw ? raw.map((b) => api.hex(b, 2)).join(' ') : '–';
    }

    function updateRow(i, s, ram, transp, rgb, global, filterOn) {
        const r = rows[i];
        const show = !filterOn || s.visible;
        const disp = show ? '' : 'none';
        if (r.tr.style.display !== disp) r.tr.style.display = disp;
        r.tr.classList.toggle('off', !s.visible);
        const c = r.cells;
        setText(c[1], s.relative ? api.t('sprites.relAnchor', s.anchor) : '');
        setText(c[2], s.x);
        setText(c[3], s.y);
        setText(c[4], s.pattern);
        setText(c[5], s.pal);
        setText(c[6], s.visible ? api.t('sprites.yes') : '–');
        const tf = (s.xm ? 'X' : '') + (s.ym ? 'Y' : '') + (s.rot ? 'R' : '');
        setText(c[7], tf || '–');
        setText(c[8], s.is4bit ? api.t('sprites.yes') : '–');
        setText(c[9], (1 << s.xs) + '×' + (1 << s.ys));
        const rect = spriteRect(s);
        const title = (s.relative ? api.t('sprites.tipSpriteRel', i, s.anchor) : api.t('sprites.tipSprite', i)) +
            '\n' + api.t('sprites.tipRaw', hexAttrs(s.raw)) +
            '\n' + api.t(s.is4bit ? 'sprites.tipPattern4' : 'sprites.tipPattern8', s.pattern, api.hex(s.addr, 4)) +
            '\n' + api.t('sprites.tipRect', rect.x, rect.y, rect.w, rect.h);
        if (r.title !== title) { r.title = title; r.tr.title = title; }
        if (!show) return;
        // náhled jen když se změnil vzor, paleta nebo transformace
        const key = global + '|' + s.addr + ',' + s.is4bit + ',' + s.pal + ',' + tf;
        if (r.key === key) return;
        r.key = key;
        drawPattern(r.img.data, ram, s, transp, rgb, ui.transform.checked);
        r.ctx.putImageData(r.img, 0, 0);
    }

    function drawMap() {
        const ctx = ui.mapCtx;
        if (!ctx) return;
        const fg = cssVar('--vscode-foreground', '#ccc');
        const muted = cssVar('--vscode-descriptionForeground', '#888');
        const accent = cssVar('--vscode-focusBorder', '#3794ff');
        const warn = cssVar('--vscode-editorWarning-foreground', '#cca700');
        ctx.fillStyle = cssVar('--vscode-editor-background', '#1e1e1e');
        ctx.fillRect(0, 0, MAP_W, MAP_H);
        ctx.lineWidth = 1;
        // papír 256 × 192 uvnitř okraje
        ctx.strokeStyle = muted;
        ctx.setLineDash([]);
        ctx.strokeRect(32.5, 32.5, 255, 191);
        // ořezové okno
        if (clipWin) {
            ctx.strokeStyle = warn;
            ctx.setLineDash([4, 3]);
            ctx.strokeRect(clipWin.x1 + 0.5, clipWin.y1 + 0.5, clipWin.x2 - clipWin.x1, clipWin.y2 - clipWin.y1);
            ctx.setLineDash([]);
        }
        const k = hovered >= 0 ? hovered : selected;
        ctx.strokeStyle = fg;
        ctx.globalAlpha = 0.7;
        for (let i = 0; i < sprites.length; i++) {
            const s = sprites[i];
            if (!s.visible || i === k) continue;
            const r = spriteRect(s);
            ctx.strokeRect(r.x + 0.5, r.y + 0.5, r.w - 1, r.h - 1);
        }
        ctx.globalAlpha = 1;
        if (k >= 0 && sprites[k]) {
            const r = spriteRect(sprites[k]);
            ctx.fillStyle = accent;
            ctx.globalAlpha = 0.35;
            ctx.fillRect(r.x, r.y, r.w, r.h);
            ctx.globalAlpha = 1;
            ctx.strokeStyle = accent;
            ctx.lineWidth = 2;
            ctx.strokeRect(r.x + 1, r.y + 1, r.w - 2, r.h - 2);
            ctx.lineWidth = 1;
        }
    }

    // Sprite pod bodem mini-mapy: vrchní podle priority (NR $15 b6 = sprite 0 nahoře)
    function spriteAt(x, y) {
        const zeroOnTop = (nr15 & 0x40) !== 0;
        let hit = -1;
        for (let i = 0; i < sprites.length; i++) {
            const s = sprites[i];
            if (!s.visible) continue;
            const r = spriteRect(s);
            if (x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h) {
                hit = i;
                if (zeroOnTop) break;
            }
        }
        return hit;
    }

    function mapPoint(e) {
        const b = ui.map.getBoundingClientRect();
        return [Math.floor((e.clientX - b.left) * MAP_W / b.width), Math.floor((e.clientY - b.top) * MAP_H / b.height)];
    }

    function mount(el, a) {
        api = a;
        root = el;
        if (!el.id) el.id = 'view-' + ID;
        const style = document.createElement('style');
        style.textContent = CSS;
        el.appendChild(style);

        const bar = api.el('div', { class: 'toolbar' });
        ui.filter = api.el('input', { type: 'checkbox' });
        ui.filter.checked = true;
        ui.transform = api.el('input', { type: 'checkbox' });
        ui.transform.checked = true;
        bar.appendChild(api.el('label', { title: api.t('sprites.visibleOnlyTip') }, ui.filter, ' ' + api.t('sprites.visibleOnly')));
        bar.appendChild(api.el('label', { title: api.t('sprites.transformTip') }, ui.transform, ' ' + api.t('sprites.transform')));
        ui.status = api.el('span', { class: 'muted' });
        bar.appendChild(ui.status);
        el.appendChild(bar);

        ui.sum = api.el('div', { class: 'sp-sum mono' });
        ui.count = api.el('span');
        ui.enable = api.el('span');
        ui.clip = api.el('span');
        ui.sum.appendChild(ui.count);
        ui.sum.appendChild(ui.enable);
        ui.sum.appendChild(ui.clip);
        el.appendChild(ui.sum);

        const wrap = api.el('div', { class: 'sp-wrap' });
        const box = api.el('div', { class: 'sp-table-box' });
        box.appendChild(buildTable());
        box.addEventListener('mouseleave', () => { hovered = -1; applyHighlight(); });
        wrap.appendChild(box);

        const mapBox = api.el('div', { class: 'sp-map' });
        mapBox.appendChild(api.el('div', { class: 'muted' }, api.t('sprites.miniMap')));
        ui.map = api.canvas(MAP_W, MAP_H, 1);
        ui.mapCtx = ui.map.getContext('2d');
        mapBox.appendChild(ui.map);
        wrap.appendChild(mapBox);
        el.appendChild(wrap);

        ui.map.addEventListener('mousemove', (e) => {
            const [x, y] = mapPoint(e);
            const i = spriteAt(x, y);
            if (i !== hovered) { hovered = i; applyHighlight(); }
            ui.map.title = i >= 0 ? api.t('sprites.tipSprite', i) : '';
        });
        ui.map.addEventListener('mouseleave', () => { hovered = -1; applyHighlight(); });
        ui.map.addEventListener('click', (e) => {
            const [x, y] = mapPoint(e);
            const i = spriteAt(x, y);
            if (i >= 0) select(i, true);
        });
        const rerender = () => {
            for (const r of rows) r.key = '';
            if (ui.last) render(ui.last);
        };
        ui.filter.addEventListener('change', rerender);
        ui.transform.addEventListener('change', rerender);
        drawMap();
    }

    function render(d) {
        const { list, ram, rgb, transp, global } = d;
        sprites = list;
        const filterOn = ui.filter.checked;
        let vis = 0;
        for (let i = 0; i < N; i++) {
            if (list[i].visible) vis++;
            updateRow(i, list[i], ram, transp, rgb, global, filterOn);
        }
        setText(ui.count, api.t('sprites.visibleCount', vis, N));
        const on = (nr15 & 1) !== 0;
        setText(ui.enable, api.t(on ? 'sprites.enabled' : 'sprites.disabled') +
            ((nr15 & 0x02) ? ' · ' + api.t('sprites.overBorder') : '') + ((nr15 & 0x40) ? ' · ' + api.t('sprites.zeroOnTop') : ''));
        ui.enable.className = on ? '' : 'warn';
        drawMap();
    }

    async function refresh(a) {
        api = a;
        if (busy) return;
        busy = true;
        try {
            const [spr, pat, pals, nr] = await Promise.all([
                api.request('sprites'),
                api.request('patternRam'),
                api.request('palettes').catch(() => null),
                api.request('nextregs').catch(() => null),
            ]);
            const regs = nr && nr.data ? api.bytes(nr.data) : null;
            nr15 = regs ? regs[0x15] : 0x01;
            const transp = regs ? regs[0x4b] : 0xe3;
            const second = regs ? (regs[0x43] & 0x08) !== 0 : false;
            const bank = pals && pals.banks ? pals.banks[second ? 'sprite1' : 'sprite0'] : null;
            const palKey = bank ? bank.join(',') : 'def';
            const rgb = paletteRgb(bank || defaultBank());
            const ram = api.bytes(pat.data);
            const attrs = spr.attrs ? api.bytes(spr.attrs) : null;
            const list = fromServer(spr.sprites || [], attrs);

            // společná verze náhledů: mění se s obsahem pattern RAM, paletou a průhlednou barvou
            const sig = transp + '|' + palKey + '|' + pat.data;
            if (sig !== lastSig) {
                lastSig = sig;
                version++;
            }
            const global = 'v' + version;

            const clip = spr.clip || { x1: 0, x2: 255, y1: 0, y2: 191 };
            clipWin = clipRect(clip, nr15);
            setText(ui.clip, api.t('sprites.clip', api.hex(clip.x1, 2), api.hex(clip.x2, 2), api.hex(clip.y1, 2), api.hex(clip.y2, 2),
                clipWin.x1, clipWin.x2, clipWin.y1, clipWin.y2));
            setText(ui.status, api.t('sprites.status', api.hex(transp, 2), second ? 2 : 1));
            ui.status.className = 'muted';
            ui.last = { list, ram, rgb, transp, global };
            render(ui.last);
            if (hovered >= 0 || selected >= 0) applyHighlight();
        } catch (e) {
            setText(ui.status, api.t('sprites.error', e && e.message ? e.message : e));
            ui.status.className = 'err';
        } finally {
            busy = false;
        }
    }

    NextView.register({ id: ID, title: NextView.t('sprites.title'), order: 10, mount, refresh });
})();
