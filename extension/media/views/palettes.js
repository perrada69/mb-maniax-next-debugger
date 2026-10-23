// Pohled „Palety“: 8 bank palet (ULA, Layer 2, Sprity, Tilemapa × 1./2.) jako mřížky 16 × 16.
// Hardware podle JNEXT video/palette.cpp (NR $43), video/ula.cpp (ULANext), video/renderer.cpp (NR $14).
(function () {
    'use strict';

    const ID = 'palettes';
    const CELL = 14;                   // 13 px barva + 1 px mřížka
    const SIZE = 16 * CELL + 1;

    // Banky v pořadí NR $43 bity 6:4 (palette.cpp:18-28)
    const bankName = (kind, n) => NextView.t('palettes.bankName', kind, n);
    const SPRITES = NextView.t('palettes.sprites');
    const TILEMAP = NextView.t('palettes.tilemap');
    const BANKS = [
        { key: 'ula0', name: bankName('ULA', 1), kind: 'ula', second: false, target: 0 },
        { key: 'ula1', name: bankName('ULA', 2), kind: 'ula', second: true, target: 4 },
        { key: 'layer2_0', name: bankName('Layer 2', 1), kind: 'layer2', second: false, target: 1 },
        { key: 'layer2_1', name: bankName('Layer 2', 2), kind: 'layer2', second: true, target: 5 },
        { key: 'sprite0', name: bankName(SPRITES, 1), kind: 'sprite', second: false, target: 2 },
        { key: 'sprite1', name: bankName(SPRITES, 2), kind: 'sprite', second: true, target: 6 },
        { key: 'tilemap0', name: bankName(TILEMAP, 1), kind: 'tilemap', second: false, target: 3 },
        { key: 'tilemap1', name: bankName(TILEMAP, 2), kind: 'tilemap', second: true, target: 7 },
    ];

    const C3 = [];
    for (let c = 0; c < 8; c++) C3.push((c << 5) | (c << 2) | (c >> 1));

    // RGB333 → [r, g, b] 0–255
    function rgb8(c) {
        return [C3[(c >> 6) & 7], C3[(c >> 3) & 7], C3[c & 7]];
    }

    // RGB333 → RRRGGGBB (horních 8 bitů; s tím se srovnává NR $14, palette.h:313-318)
    const rrrgggbb = (c) => (c >> 1) & 0xff;

    // Je aktivní druhá banka? NR $43 b1 ULA, b2 Layer 2, b3 sprity (palette.cpp:331-340); tilemapa NR $6B b4
    function secondActive(kind, nr43, nr6b) {
        switch (kind) {
            case 'ula': return (nr43 & 0x02) !== 0;
            case 'layer2': return (nr43 & 0x04) !== 0;
            case 'sprite': return (nr43 & 0x08) !== 0;
            default: return (nr6b & 0x10) !== 0;
        }
    }

    // Formáty ULANext s papírem z palety (ula.cpp:729-738): maska → počet bitů inku
    const ULANEXT_BITS = { 0x01: 1, 0x03: 2, 0x07: 3, 0x0f: 4, 0x1f: 5, 0x3f: 6, 0x7f: 7 };

    // Úloha položky ULA palety (ink / paper / okraj) nebo null = nepoužitá
    function ulaRole(i, nr43, nr42) {
        if (!(nr43 & 0x01)) {
            // standardní ULA (ula.cpp:38-44): ink 0–15, paper 16–31, okraj = paper 16–23
            if (i < 8) return api.t('palettes.roleInk');
            if (i < 16) return api.t('palettes.roleInkBright');
            if (i < 24) return api.t('palettes.rolePaperBorder');
            if (i < 32) return api.t('palettes.rolePaperBright');
            return null;
        }
        const f = nr42 & 0xff;
        const bits = ULANEXT_BITS[f];
        if ((i & ~f) === 0) return api.t('palettes.roleInk');
        if (bits === undefined || i < 128) return null;
        const top = 128 + (255 >> bits);
        if (i > top) return null;
        return i < 136 ? api.t('palettes.rolePaperBorder') : api.t('palettes.rolePaper');
    }

    function ulaLegend(nr43, nr42) {
        if (!(nr43 & 0x01)) return api.t('palettes.legendStd');
        const f = nr42 & 0xff;
        const bits = ULANEXT_BITS[f];
        const fs = '$' + f.toString(16).toUpperCase().padStart(2, '0');
        if (bits === undefined) return api.t('palettes.legendUlaNextAny', fs);
        return api.t('palettes.legendUlaNext', fs, f, 128 + (255 >> bits));
    }

    // Je položka průhledná? ULA/Layer 2/tilemapa: barva = NR $14 (renderer.cpp:761-769); sprity: index = NR $4B
    function isTransparent(kind, i, c, regs) {
        if (kind === 'sprite') return i === regs.nr4b;
        return rrrgggbb(c) === regs.nr14;
    }

    // Banka do RGBA (out = ImageData.data SIZE × SIZE); mřížka alfa 0, průhledná položka s křížkem
    function drawBank(out, bank, kind, regs, dim) {
        out.fill(0);
        for (let i = 0; i < 256; i++) {
            const c = bank[i] | 0;
            let [r, g, b] = rgb8(c);
            if (dim && kind === 'ula' && ulaRole(i, regs.nr43, regs.nr42) === null) {
                r = (r + 128 * 3) >> 2; g = (g + 128 * 3) >> 2; b = (b + 128 * 3) >> 2;
            }
            const cross = isTransparent(kind, i, c, regs);
            const light = r * 0.3 + g * 0.59 + b * 0.11 > 128;
            const x0 = (i & 15) * CELL + 1;
            const y0 = (i >> 4) * CELL + 1;
            for (let y = 0; y < CELL - 1; y++) {
                let o = ((y0 + y) * SIZE + x0) * 4;
                for (let x = 0; x < CELL - 1; x++, o += 4) {
                    if (cross && (x === y || x === CELL - 2 - y) && x > 1 && x < CELL - 3) {
                        const v = light ? 0 : 255;
                        out[o] = out[o + 1] = out[o + 2] = v;
                    } else {
                        out[o] = r; out[o + 1] = g; out[o + 2] = b;
                    }
                    out[o + 3] = 255;
                }
            }
        }
    }

    let api = null;
    let busy = false;
    let banks = null;
    let regs = { nr43: 0, nr42: 7, nr14: 0xe3, nr4b: 0xe3, nr4c: 0x0f, nr6b: 0 };
    const views = [];
    const ui = {};

    const CSS = `
#view-palettes .pl-info { position: sticky; top: 0; z-index: 1; padding: 3px 0; min-height: 18px; background: var(--vscode-editor-background); }
#view-palettes .pl-sw { display: inline-block; width: 12px; height: 12px; vertical-align: middle; border: 1px solid var(--vscode-panel-border); margin-right: 6px; }
#view-palettes .pl-grid { display: flex; flex-wrap: wrap; gap: 14px; }
#view-palettes .pl-bank { border: 1px solid var(--vscode-panel-border); padding: 4px 6px 6px; }
#view-palettes .pl-bank.active { border-color: var(--vscode-focusBorder); }
#view-palettes .pl-head { display: flex; gap: 6px; align-items: baseline; margin-bottom: 4px; }
#view-palettes .pl-badge { font-size: 10px; padding: 0 4px; border-radius: 3px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
#view-palettes .pl-bank canvas { display: block; background: var(--vscode-panel-border, #808080); cursor: crosshair; }
#view-palettes .pl-legend { font-size: 11px; margin-top: 3px; max-width: ${SIZE}px; }
#view-palettes .err { color: var(--vscode-errorForeground); }
`;

    function setText(node, v) {
        const s = String(v);
        if (node.textContent !== s) node.textContent = s;
    }

    const h2 = (v) => api.hex(v, 2);

    function info(bi, i) {
        if (bi < 0 || !banks) {
            setText(ui.infoText, api.t('palettes.hoverHint'));
            ui.sw.style.visibility = 'hidden';
            return;
        }
        const B = BANKS[bi];
        const bank = banks[B.key] || [];
        const c = bank[i] | 0;
        const [r, g, b] = rgb8(c);
        const css = '#' + ((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1);
        let t = api.t('palettes.info', B.name, h2(i), i, api.hex(c, 3), (c >> 6) & 7, (c >> 3) & 7, c & 7, h2(rrrgggbb(c)), css);
        if (B.kind === 'ula') {
            const role = ulaRole(i, regs.nr43, regs.nr42);
            t += ' · ' + (role || api.t('palettes.unused'));
        }
        if (isTransparent(B.kind, i, c, regs)) {
            t += ' · ' + api.t(B.kind === 'sprite' ? 'palettes.transparent4B' : 'palettes.transparent14');
        }
        if (B.kind === 'tilemap' && (i & 15) === regs.nr4c) t += ' · ' + api.t('palettes.tileNibble');
        setText(ui.infoText, t);
        ui.sw.style.visibility = '';
        ui.sw.style.background = css;
    }

    function mount(el, a) {
        api = a;
        if (!el.id) el.id = 'view-' + ID;
        const style = document.createElement('style');
        style.textContent = CSS;
        el.appendChild(style);

        const bar = api.el('div', { class: 'toolbar' });
        ui.dim = api.el('input', { type: 'checkbox' });
        bar.appendChild(api.el('label', { title: api.t('palettes.dimTip') }, ui.dim, ' ' + api.t('palettes.dim')));
        ui.regs = api.el('span', { class: 'muted mono' });
        bar.appendChild(ui.regs);
        el.appendChild(bar);

        ui.sw = api.el('span', { class: 'pl-sw' });
        ui.infoText = api.el('span');
        el.appendChild(api.el('div', { class: 'pl-info mono' }, ui.sw, ui.infoText));

        const grid = api.el('div', { class: 'pl-grid' });
        BANKS.forEach((B, bi) => {
            const box = api.el('div', { class: 'pl-bank' });
            const head = api.el('div', { class: 'pl-head' });
            head.appendChild(api.el('strong', {}, B.name));
            const act = api.el('span', { class: 'pl-badge', title: api.t('palettes.activeTip') }, api.t('palettes.active'));
            const tgt = api.el('span', { class: 'pl-badge', title: api.t('palettes.writeTip') }, api.t('palettes.write'));
            head.appendChild(act);
            head.appendChild(tgt);
            box.appendChild(head);
            const canvas = api.canvas(SIZE, SIZE, 1);
            const ctx = canvas.getContext('2d');
            const img = ctx.createImageData(SIZE, SIZE);
            box.appendChild(canvas);
            const legend = api.el('div', { class: 'pl-legend muted' });
            box.appendChild(legend);
            grid.appendChild(box);
            canvas.addEventListener('mousemove', (e) => {
                const r = canvas.getBoundingClientRect();
                const cx = Math.min(15, Math.max(0, Math.floor((e.clientX - r.left) * 16 / r.width)));
                const cy = Math.min(15, Math.max(0, Math.floor((e.clientY - r.top) * 16 / r.height)));
                info(bi, cy * 16 + cx);
            });
            canvas.addEventListener('mouseleave', () => info(-1, 0));
            views.push({ box, act, tgt, canvas, ctx, img, legend, sig: '' });
        });
        el.appendChild(grid);
        ui.dim.addEventListener('change', () => { for (const v of views) v.sig = ''; render(); });
        info(-1, 0);
        render();
    }

    function render() {
        const dim = ui.dim.checked;
        BANKS.forEach((B, bi) => {
            const v = views[bi];
            const active = secondActive(B.kind, regs.nr43, regs.nr6b) === B.second;
            v.box.classList.toggle('active', active);
            v.act.style.display = active ? '' : 'none';
            v.tgt.style.display = ((regs.nr43 >> 4) & 7) === B.target ? '' : 'none';
            let legend = '';
            if (B.kind === 'ula') legend = ulaLegend(regs.nr43, regs.nr42) + ' · ' + api.t('palettes.legendColor', h2(regs.nr14));
            else if (B.kind === 'sprite') legend = api.t('palettes.legendIndex', h2(regs.nr4b));
            else if (B.kind === 'layer2') legend = api.t('palettes.legendColor', h2(regs.nr14));
            else legend = api.t('palettes.legendColor', h2(regs.nr14)) + ' · ' + api.t('palettes.legendTile', api.hex(regs.nr4c, 1));
            setText(v.legend, legend);
            if (!banks || !banks[B.key]) return;
            const bank = banks[B.key];
            const sig = bank.join(',') + '|' + regs.nr14 + '|' + regs.nr4b + '|' + regs.nr43 + '|' + regs.nr42 + '|' + dim;
            if (sig === v.sig) return;
            v.sig = sig;
            drawBank(v.img.data, bank, B.kind, regs, dim);
            v.ctx.putImageData(v.img, 0, 0);
        });
    }

    async function refresh(a) {
        api = a;
        if (busy) return;
        busy = true;
        try {
            const [pals, nr] = await Promise.all([
                api.request('palettes'),
                api.request('nextregs').catch(() => null),
            ]);
            banks = pals.banks || {};
            const d = nr && nr.data ? api.bytes(nr.data) : null;
            if (d) {
                regs = { nr43: d[0x43], nr42: d[0x42], nr14: d[0x14], nr4b: d[0x4b], nr4c: d[0x4c] & 15, nr6b: d[0x6b] };
            } else {
                // bez NEXTREG aspoň aktivní ULA ze serveru
                regs = Object.assign({}, regs, { nr43: (regs.nr43 & ~0x02) | (pals.activeUla ? 0x02 : 0) });
            }
            setText(ui.regs, 'NR $43 = ' + h2(regs.nr43) + ' · $42 = ' + h2(regs.nr42) + ' · $14 = ' + h2(regs.nr14) +
                ' · $4B = ' + h2(regs.nr4b) + ' · $6B = ' + h2(regs.nr6b) + (d ? '' : ' ' + api.t('palettes.noNextreg')));
            ui.regs.className = 'muted mono';
            render();
        } catch (e) {
            setText(ui.regs, api.t('palettes.error', e && e.message ? e.message : e));
            ui.regs.className = 'err';
        } finally {
            busy = false;
        }
    }

    NextView.register({ id: ID, title: NextView.t('palettes.title'), order: 30, mount, refresh });
})();
