// Pohled „Pattern RAM“: všechny vzory spritů v mřížce, detail vzoru s indexy pixelů a jeho uživateli.
// Hardware podle JNEXT video/sprites.cpp (formát 8bit / 4bit vzorů, paletový offset).
(function () {
    'use strict';

    const ID = 'patterns';
    const N = 128;
    const DCELL = 16;              // velikost pixelu v detailu
    const DSIZE = 16 * DCELL;

    const C3 = [];
    for (let c = 0; c < 8; c++) C3.push((c << 5) | (c << 2) | (c >> 1));

    // Výchozí paleta spritů (RRRGGGBB identita, modrý LSB = B1 | B0)
    function defaultBank() {
        const a = [];
        for (let i = 0; i < 256; i++) a.push((i << 1) | ((i | (i >> 1)) & 1));
        return a;
    }

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

    // Adresa vzoru podle čísla, které hardware čte (server `pattern`):
    // 8bit N5:N0 × 256 B, 4bit N5:N0:N6 × 128 B (sprites.cpp:1047, :1064)
    function patternAddr(pattern, is4bit) {
        return (is4bit ? pattern << 7 : pattern << 8) & 0x3fff;
    }

    // Který sprite čte který vzor (relativní sprity server už rozvedl ke kotvě)
    function spriteUse(list) {
        const out = [];
        for (let i = 0; i < N; i++) {
            const f = list[i] || {};
            out.push({ i, addr: patternAddr(f.pattern | 0, !!f.is4bit), is4bit: !!f.is4bit, visible: !!f.visible });
        }
        return out;
    }

    // Syrová hodnota pixelu (bajt u 8bit, nibble u 4bit)
    function rawPixel(ram, addr, is4bit, px, py) {
        if (!is4bit) return ram[(addr + (py << 4) + px) & 0x3fff];
        const b = ram[(addr + (py << 3) + (px >> 1)) & 0x3fff];
        return px & 1 ? b & 15 : b >> 4;
    }

    // Syrová hodnota → index do palety, -1 = průhledný (transp < 0: průhlednost vypnutá)
    function colorIndex(v, is4bit, pal, transp) {
        if (!is4bit) {
            if (v === transp) return -1;
            return ((((v >> 4) + pal) & 15) << 4) | (v & 15);
        }
        if (transp >= 0 && v === (transp & 15)) return -1;
        return (pal << 4) | v;
    }

    // Vzor 16 × 16 do RGBA, průhledné pixely alfa 0
    function drawPattern(out, ram, addr, is4bit, pal, transp, rgb) {
        let o = 0;
        for (let py = 0; py < 16; py++) {
            for (let px = 0; px < 16; px++) {
                const idx = colorIndex(rawPixel(ram, addr, is4bit, px, py), is4bit, pal, transp);
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

    // Zvětšený detail: buňky DCELL × DCELL, šachovnice za průhlednými, mřížka a rámeček pod myší
    function drawDetail(out, ram, addr, is4bit, pal, transp, rgb, hx, hy) {
        for (let py = 0; py < 16; py++) {
            for (let px = 0; px < 16; px++) {
                const idx = colorIndex(rawPixel(ram, addr, is4bit, px, py), is4bit, pal, transp);
                const hot = px === hx && py === hy;
                for (let y = 0; y < DCELL; y++) {
                    let o = ((py * DCELL + y) * DSIZE + px * DCELL) * 4;
                    for (let x = 0; x < DCELL; x++, o += 4) {
                        let r, g, b;
                        if (idx < 0) {
                            r = g = b = ((x >> 2) + (y >> 2)) & 1 ? 0x99 : 0x66;
                        } else {
                            r = rgb[idx * 3]; g = rgb[idx * 3 + 1]; b = rgb[idx * 3 + 2];
                        }
                        const edge = x === DCELL - 1 || y === DCELL - 1;
                        if (hot && (x < 2 || y < 2 || x >= DCELL - 2 || y >= DCELL - 2)) {
                            const light = r * 0.3 + g * 0.59 + b * 0.11 > 128;
                            r = g = b = light ? 0 : 255;
                        } else if (edge) {
                            r = (r * 0.6) | 0; g = (g * 0.6) | 0; b = (b * 0.6) | 0;
                        }
                        out[o] = r; out[o + 1] = g; out[o + 2] = b; out[o + 3] = 255;
                    }
                }
            }
        }
    }

    let api = null;
    let busy = false;
    let modeChosen = false;   // formát vybral uživatel; jinak podle viditelných spritů
    let cells = [];
    let selected = -1;
    let hoverPx = -1;
    let hoverPy = -1;
    let data = null;           // {ram, banks, active, transp, uses}
    let lastSig = '';
    const ui = {};

    const CSS = `
#view-patterns .pt-wrap { display: flex; flex-wrap: wrap; gap: 14px; align-items: flex-start; }
#view-patterns .pt-grid { display: flex; flex-wrap: wrap; gap: 4px; flex: 1 1 420px; min-width: 0; align-content: flex-start; }
#view-patterns .pt-cell { display: flex; flex-direction: column; align-items: center; padding: 2px; border: 1px solid transparent; cursor: pointer; }
#view-patterns .pt-cell:hover { border-color: var(--vscode-focusBorder); }
#view-patterns .pt-cell.selected { border-color: var(--vscode-focusBorder); background: var(--vscode-list-activeSelectionBackground); }
#view-patterns .pt-cell canvas { display: block; background: repeating-conic-gradient(rgba(128,128,128,0.35) 0 25%, transparent 0 50%) 0 0 / 8px 8px; }
#view-patterns .pt-lbl { font-size: 10px; line-height: 12px; color: var(--vscode-descriptionForeground); }
#view-patterns .pt-cell.used .pt-lbl { color: var(--vscode-textLink-foreground); font-weight: bold; }
#view-patterns .pt-detail { flex: 0 0 auto; width: 290px; }
#view-patterns .pt-detail canvas { display: block; border: 1px solid var(--vscode-panel-border); cursor: crosshair; margin: 4px 0; }
#view-patterns .pt-detail div { margin: 2px 0; word-break: break-word; }
#view-patterns .pt-sw { display: inline-block; width: 10px; height: 10px; vertical-align: middle; border: 1px solid var(--vscode-panel-border); margin-right: 4px; }
#view-patterns .err { color: var(--vscode-errorForeground); }
`;

    function setText(node, v) {
        const s = String(v);
        if (node.textContent !== s) node.textContent = s;
    }

    const is4 = () => ui.mode.value === '4';
    const count = () => (is4() ? 128 : 64);
    const size = () => (is4() ? 128 : 256);
    const zoom = () => parseInt(ui.zoom.value, 10) || 2;
    const offset = () => parseInt(ui.offset.value, 10) || 0;
    const transpOf = () => (ui.transp.checked && data ? data.transp : -1);

    function bankSecond() {
        const v = ui.pal.value;
        if (v === 'a') return data ? data.active : false;
        return v === '1';
    }

    function currentRgb() {
        if (!data) return paletteRgb(defaultBank());
        const key = bankSecond() ? 'rgb1' : 'rgb0';
        return data[key];
    }

    function option(sel, value, text) {
        const o = api.el('option', { value: String(value) }, text);
        sel.appendChild(o);
        return o;
    }

    function buildGrid() {
        ui.grid.textContent = '';
        cells = [];
        const z = zoom();
        for (let k = 0; k < count(); k++) {
            const cell = api.el('div', { class: 'pt-cell' });
            const canvas = api.canvas(16, 16, z);
            const ctx = canvas.getContext('2d');
            const img = ctx.createImageData(16, 16);
            const lbl = api.el('div', { class: 'pt-lbl mono' }, String(k));
            cell.appendChild(canvas);
            cell.appendChild(lbl);
            cell.addEventListener('click', () => selectPattern(k));
            ui.grid.appendChild(cell);
            cells.push({ cell, canvas, ctx, img, title: '' });
        }
        if (selected >= count()) selected = -1;
        if (selected >= 0) cells[selected].cell.classList.add('selected');
        lastSig = '';
    }

    function selectPattern(k) {
        if (selected >= 0 && cells[selected]) cells[selected].cell.classList.remove('selected');
        selected = k;
        if (k >= 0 && cells[k]) cells[k].cell.classList.add('selected');
        hoverPx = hoverPy = -1;
        drawDetailView();
    }

    // Sprity, jejichž vzor se překrývá s oblastí [addr, addr + len)
    function usersOf(addr, len) {
        const vis = [];
        const hid = [];
        if (!data) return { vis, hid };
        for (const u of data.uses) {
            const ulen = u.is4bit ? 128 : 256;
            if (u.addr < addr + len && addr < u.addr + ulen) {
                const t = u.i + (u.is4bit !== is4() ? (u.is4bit ? ' (4bit)' : ' (8bit)') : '');
                (u.visible ? vis : hid).push(t);
            }
        }
        return { vis, hid };
    }

    // Seznam čísel spritů, dlouhý zkrácený
    function list(a) {
        return a.length <= 16 ? a.join(', ') : api.t('patterns.listMore', a.slice(0, 16).join(', '), a.length);
    }

    function drawGrid() {
        if (!data) return;
        const rgb = currentRgb();
        const sig = ui.mode.value + '|' + (bankSecond() ? 1 : 0) + '|' + offset() + '|' + transpOf() + '|' + data.sig;
        const L = size();
        for (let k = 0; k < cells.length; k++) {
            const c = cells[k];
            const u = usersOf(k * L, L);
            c.cell.classList.toggle('used', u.vis.length > 0);
            const title = api.t('patterns.tipPattern', k, api.hex(k * L, 4)) +
                (u.vis.length ? '\n' + api.t('patterns.visibleSprites', list(u.vis)) : '') +
                (u.hid.length ? '\n' + api.t('patterns.hiddenSprites', list(u.hid)) : '');
            if (c.title !== title) { c.title = title; c.cell.title = title; }
        }
        if (sig === lastSig) return;
        lastSig = sig;
        const pal = offset();
        const transp = transpOf();
        for (let k = 0; k < cells.length; k++) {
            const c = cells[k];
            drawPattern(c.img.data, data.ram, k * L, is4(), pal, transp, rgb);
            c.ctx.putImageData(c.img, 0, 0);
        }
    }

    function hex24(r, g, b) {
        return '#' + ((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1);
    }

    function drawDetailView() {
        const k = selected;
        if (k < 0 || !data) {
            ui.dCanvas.style.visibility = 'hidden';
            setText(ui.dHead, data ? api.t('patterns.clickHint') : '');
            setText(ui.dUsers, '');
            setPix('', null);
            return;
        }
        ui.dCanvas.style.visibility = '';
        const L = size();
        const addr = k * L;
        const rgb = currentRgb();
        const pal = offset();
        const transp = transpOf();
        drawDetail(ui.dImg.data, data.ram, addr, is4(), pal, transp, rgb, hoverPx, hoverPy);
        ui.dCtx.putImageData(ui.dImg, 0, 0);
        setText(ui.dHead, api.t('patterns.detailHead', k, is4() ? '4bit' : '8bit', api.hex(addr, 4), api.hex(addr + L - 1, 4),
            bankSecond() ? 2 : 1, pal));
        const u = usersOf(addr, L);
        setText(ui.dUsers, api.t('patterns.visibleSprites', u.vis.length ? list(u.vis) : '–') +
            (u.hid.length ? ' · ' + api.t('patterns.hiddenShort', list(u.hid)) : ''));
        if (hoverPx < 0) {
            setPix(api.t('patterns.hoverHint'), null);
            return;
        }
        const v = rawPixel(data.ram, addr, is4(), hoverPx, hoverPy);
        const at = is4() ? addr + (hoverPy << 3) + (hoverPx >> 1) : addr + (hoverPy << 4) + hoverPx;
        const idx = colorIndex(v, is4(), pal, transp);
        let t = api.t(is4() ? (hoverPx & 1 ? 'patterns.pixelLow' : 'patterns.pixelHigh') : 'patterns.pixel',
            hoverPx, hoverPy, api.hex(at, 4), api.hex(v, is4() ? 1 : 2));
        if (idx < 0) {
            setPix(t + ' · ' + api.t('patterns.transparent', api.hex(data.transp, 2)), null);
        } else {
            const bank = bankSecond() ? data.bank1 : data.bank0;
            const c = bank[idx] | 0;
            const r = rgb[idx * 3], g = rgb[idx * 3 + 1], b = rgb[idx * 3 + 2];
            t += ' → ' + api.t('patterns.pixelColor', api.hex(idx, 2), api.hex(c, 3), (c >> 6) & 7, (c >> 3) & 7, c & 7, hex24(r, g, b));
            setPix(t, hex24(r, g, b));
        }
    }

    // Řádek s pixelem pod myší: vzorek barvy (nebo skrytý) a text
    function setPix(text, color) {
        setText(ui.dPixText, text);
        ui.dSw.style.visibility = color ? '' : 'hidden';
        if (color) ui.dSw.style.background = color;
    }

    function mount(el, a) {
        api = a;
        if (!el.id) el.id = 'view-' + ID;
        const style = document.createElement('style');
        style.textContent = CSS;
        el.appendChild(style);

        const bar = api.el('div', { class: 'toolbar' });
        ui.mode = api.el('select', { title: api.t('patterns.modeTip') });
        option(ui.mode, '8', api.t('patterns.mode8'));
        option(ui.mode, '4', api.t('patterns.mode4'));
        ui.pal = api.el('select', { title: api.t('patterns.palTip') });
        ui.palActive = option(ui.pal, 'a', api.t('patterns.palActive'));
        option(ui.pal, '0', api.t('patterns.palSprites', 1));
        option(ui.pal, '1', api.t('patterns.palSprites', 2));
        ui.offset = api.el('select', { title: api.t('patterns.offsetTip') });
        for (let i = 0; i < 16; i++) option(ui.offset, i, api.t('patterns.offset', i));
        ui.zoom = api.el('select', { title: api.t('patterns.zoomTip') });
        for (let i = 1; i <= 4; i++) option(ui.zoom, i, i + '×');
        ui.zoom.value = '2';
        ui.transp = api.el('input', { type: 'checkbox' });
        ui.transp.checked = true;
        ui.status = api.el('span', { class: 'muted' });
        bar.appendChild(ui.mode);
        bar.appendChild(ui.pal);
        bar.appendChild(ui.offset);
        bar.appendChild(ui.zoom);
        bar.appendChild(api.el('label', { title: api.t('patterns.transpTip') }, ui.transp, ' ' + api.t('patterns.transp')));
        bar.appendChild(ui.status);
        el.appendChild(bar);

        const wrap = api.el('div', { class: 'pt-wrap' });
        ui.grid = api.el('div', { class: 'pt-grid' });
        wrap.appendChild(ui.grid);

        const det = api.el('div', { class: 'pt-detail mono' });
        ui.dHead = api.el('div');
        ui.dCanvas = api.canvas(DSIZE, DSIZE, 1);
        ui.dCtx = ui.dCanvas.getContext('2d');
        ui.dImg = ui.dCtx.createImageData(DSIZE, DSIZE);
        ui.dUsers = api.el('div');
        ui.dSw = api.el('span', { class: 'pt-sw' });
        ui.dPixText = api.el('span');
        ui.dPix = api.el('div', {}, ui.dSw, ui.dPixText);
        det.appendChild(ui.dHead);
        det.appendChild(ui.dCanvas);
        det.appendChild(ui.dPix);
        det.appendChild(ui.dUsers);
        wrap.appendChild(det);
        el.appendChild(wrap);

        ui.dCanvas.addEventListener('mousemove', (e) => {
            const b = ui.dCanvas.getBoundingClientRect();
            const px = Math.min(15, Math.max(0, Math.floor((e.clientX - b.left) * 16 / b.width)));
            const py = Math.min(15, Math.max(0, Math.floor((e.clientY - b.top) * 16 / b.height)));
            if (px !== hoverPx || py !== hoverPy) {
                hoverPx = px;
                hoverPy = py;
                drawDetailView();
            }
        });
        ui.dCanvas.addEventListener('mouseleave', () => {
            hoverPx = hoverPy = -1;
            drawDetailView();
        });

        ui.mode.addEventListener('change', () => {
            modeChosen = true;
            const k = selected;
            selected = -1;
            buildGrid();
            drawGrid();
            if (k >= 0) selectPattern(is4() ? k * 2 : k >> 1);
            else drawDetailView();
        });
        const redraw = () => { lastSig = ''; drawGrid(); drawDetailView(); };
        ui.pal.addEventListener('change', redraw);
        ui.offset.addEventListener('change', redraw);
        ui.transp.addEventListener('change', redraw);
        ui.zoom.addEventListener('change', () => {
            const z = zoom();
            for (const c of cells) {
                c.canvas.style.width = 16 * z + 'px';
                c.canvas.style.height = 16 * z + 'px';
            }
        });
        buildGrid();
        drawDetailView();
    }

    async function refresh(a) {
        api = a;
        if (busy) return;
        busy = true;
        try {
            const [pat, pals, nr, spr] = await Promise.all([
                api.request('patternRam'),
                api.request('palettes').catch(() => null),
                api.request('nextregs').catch(() => null),
                api.request('sprites').catch(() => null),
            ]);
            const regs = nr && nr.data ? api.bytes(nr.data) : null;
            const banks = pals && pals.banks ? pals.banks : {};
            const bank0 = banks.sprite0 || defaultBank();
            const bank1 = banks.sprite1 || defaultBank();
            const uses = spriteUse((spr && spr.sprites) || []);
            const vis = uses.filter((u) => u.visible);
            if (!modeChosen && vis.length) {
                const want = vis.filter((u) => u.is4bit).length * 2 > vis.length ? '4' : '8';
                if (ui.mode.value !== want) {
                    ui.mode.value = want;
                    selected = -1;
                    buildGrid();
                }
            }
            const palSig = bank0.join(',') + '/' + bank1.join(',');
            if (!data || data.palSig !== palSig) {
                data = Object.assign(data || {}, { palSig, rgb0: paletteRgb(bank0), rgb1: paletteRgb(bank1) });
            }
            data.bank0 = bank0;
            data.bank1 = bank1;
            data.ram = api.bytes(pat.data);
            data.sig = pat.data + '|' + palSig;
            data.active = regs ? (regs[0x43] & 0x08) !== 0 : false;
            data.transp = regs ? regs[0x4b] : 0xe3;
            data.uses = uses;
            setText(ui.palActive, api.t('patterns.palActiveN', data.active ? 2 : 1));
            setText(ui.status, 'NR $4B = ' + api.hex(data.transp, 2) + (spr ? '' : ' · ' + api.t('patterns.noSprites')));
            ui.status.className = 'muted';
            drawGrid();
            drawDetailView();
        } catch (e) {
            setText(ui.status, api.t('patterns.error', e && e.message ? e.message : e));
            ui.status.className = 'err';
        } finally {
            busy = false;
        }
    }

    NextView.register({ id: ID, title: NextView.t('patterns.title'), order: 20, mount, refresh });
})();
