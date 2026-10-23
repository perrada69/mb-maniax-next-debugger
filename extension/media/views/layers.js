// Pohled „Vrstvy“: jednotlivé vrstvy obrazu (renderLayer), pořadí vrstev podle NR $15, ořezová okna.
// Skládání podle JNEXT video/renderer.h:20-29 (režimy NR $15) a video/renderer.cpp:856-1027.
(function () {
    'use strict';

    const ID = 'layers';
    const W = 640;   // framebuffer: oblast 320 × 256 zdvojená vodorovně
    const LAYERS = [
        ['composite', NextView.t('layers.composite')],
        ['ula', 'ULA'],
        ['ulaShadow', NextView.t('layers.ulaShadow')],
        ['layer2', 'Layer 2'],
        ['layer2Shadow', NextView.t('layers.layer2Shadow')],
        ['sprites', NextView.t('layers.sprites')],
        ['tilemap', NextView.t('layers.tilemap')],
        ['background', NextView.t('layers.background')],
    ];

    const CSS = `
#view-layers .stage { position: relative; display: inline-block; line-height: 0; }
#view-layers .checker {
    background-color: #808080;
    background-image: conic-gradient(#9a9a9a 0 25%, #6a6a6a 0 50%, #9a9a9a 0 75%, #6a6a6a 0);
    background-size: 16px 16px;
}
#view-layers .thumbs { display: flex; flex-wrap: wrap; gap: 8px; }
#view-layers .thumb { cursor: pointer; padding: 2px; border: 1px solid var(--vscode-panel-border); }
#view-layers .thumb:hover { border-color: var(--vscode-focusBorder); }
#view-layers .thumb .cap { line-height: normal; padding: 2px 0; }
#view-layers .hover { min-height: 1.4em; margin: 4px 0; }
#view-layers .info { margin-top: 8px; display: flex; flex-wrap: wrap; gap: 8px 32px; align-items: flex-start; }
#view-layers .info h4 { margin: 0 0 4px; font-weight: normal; color: var(--vscode-descriptionForeground); }
#view-layers .order { margin: 0; padding-left: 1.6em; }
#view-layers .order li { padding: 1px 0; }
#view-layers .off { opacity: 0.55; text-decoration: line-through; }
`;

    // ---- dekódování registrů (testovatelné, bez DOM)

    // NR $15 b4:2 → pořadí shora dolů (renderer.h:21-28, renderer.cpp:866-921).
    const PRIO = ['SLU', 'LSU', 'SUL', 'LUS', 'USL', 'ULS', NextView.t('layers.prioAdd'), NextView.t('layers.prioSub')];

    // Režimy 6/7: zdroje mix/top/bottom podle NR $68 b6:5 (renderer.cpp:941-975, VHDL 7141-7178)
    const BLEND = [
        { mix: 'ULA', top: NextView.t('layers.tmAboveUla'), bot: NextView.t('layers.tmBelowUla') },
        { mix: null, top: NextView.t('layers.tmUlaByTile'), bot: NextView.t('layers.ulaTmByTile') },
        { mix: NextView.t('layers.ulaMergedTm'), top: null, bot: null },
        { mix: NextView.t('layers.tilemap'), top: NextView.t('layers.ulaAboveTm'), bot: NextView.t('layers.ulaBelowTm') },
    ];

    function layerOrder(nr) {
        const nr15 = nr[0x15];
        const nr68 = nr[0x68];
        const nr6b = nr[0x6b];
        const p = (nr15 >> 2) & 7;
        const ula = (nr15 & 0x80) ? 'LoRes' : 'ULA';
        const tmOn = (nr6b & 0x80) !== 0;
        const stencil = (nr68 & 0x01) !== 0 && tmOn;
        // ULA a tilemapa se slučují dřív než priorita (renderer.cpp:856-864)
        const u = tmOn ? NextView.t(stencil ? 'layers.ulaStencil' : 'layers.ulaPlusTm', ula) : ula;
        const out = { mode: p, name: PRIO[p], order: [] };
        if (p < 6) {
            for (const c of PRIO[p]) {
                if (c === 'S') out.order.push({ key: 'S', text: NextView.t('layers.sprites') });
                else if (c === 'L') out.order.push({ key: 'L', text: 'Layer 2' });
                else out.order.push({ key: 'U', text: u });
            }
        } else {
            // Kaskáda: mix_top → sprity → mix_bot → Layer 2 ⊕ mix (renderer.cpp:1018-1022)
            const b = BLEND[(nr68 >> 5) & 3];
            if (b.top) out.order.push({ key: 'U', text: b.top });
            out.order.push({ key: 'S', text: NextView.t('layers.sprites') });
            if (b.bot) out.order.push({ key: 'U', text: b.bot });
            out.order.push({ key: 'L', text: NextView.t(p === 6 ? 'layers.blendAdd' : 'layers.blendSub', b.mix || NextView.t('layers.nothing')) });
        }
        out.order.push({ key: 'B', text: NextView.t('layers.background') + ' (NR $4A)' });
        return out;
    }

    // Zapnutí vrstev: NR $69 b7 (Layer 2, čte se živě – emulator.cpp:3995), NR $68 b7 (ULA vypnutá),
    // NR $15 b0 (sprity), b7 (LoRes), NR $6B b7 (tilemapa)
    function enables(nr) {
        return {
            ula: (nr[0x68] & 0x80) === 0,
            lores: (nr[0x15] & 0x80) !== 0,
            layer2: (nr[0x69] & 0x80) !== 0,
            sprites: (nr[0x15] & 0x01) !== 0,
            tilemap: (nr[0x6b] & 0x80) !== 0,
        };
    }

    // ---- stav pohledu
    let api = null;
    let sel = 'composite';
    let zoom = 2;
    let all = false;
    let busy = null;
    const els = {};
    const main = { canvas: null, ctx: null, img: null, data: null, h: 0 };
    const thumbs = {};   // id → {box, canvas, ctx, img, data, h}

    function sizeCanvas(c, h, scale) {
        c.style.width = 320 * scale + 'px';
        c.style.height = h * scale + 'px';
    }

    // Data RGBA → plátno; průhledné pixely nechá průhledné, šachovnici dává CSS pozadí.
    function draw(slot, res, scale) {
        const h = res.height | 0;
        const data = api.bytes(res.data);
        if (!slot.img || slot.h !== h) {
            slot.canvas.width = W;
            slot.canvas.height = h;
            slot.ctx = slot.canvas.getContext('2d');
            slot.img = slot.ctx.createImageData(W, h);
            slot.h = h;
        }
        sizeCanvas(slot.canvas, h, scale);
        const n = Math.min(data.length, slot.img.data.length);
        slot.img.data.set(n === data.length ? data : data.subarray(0, n));
        slot.ctx.putImageData(slot.img, 0, 0);
        slot.data = data;
    }

    function hoverText(slot, e) {
        if (!slot.data || !slot.h) return '';
        const r = slot.canvas.getBoundingClientRect();
        if (!r.width || !r.height) return '';
        const bx = Math.min(W - 1, Math.max(0, Math.floor(((e.clientX - r.left) / r.width) * W)));
        const by = Math.min(slot.h - 1, Math.max(0, Math.floor(((e.clientY - r.top) / r.height) * slot.h)));
        const i = (by * W + bx) * 4;
        const d = slot.data;
        let col = api.t('layers.transparent');
        if (d[i + 3]) {
            col = '#' + [d[i], d[i + 1], d[i + 2]].map((v) => v.toString(16).padStart(2, '0')).join('');
            // RGB888 → RGB333 (horní 3 bity složek)
            const c9 = ((d[i] >> 5) << 6) | ((d[i + 1] >> 5) << 3) | (d[i + 2] >> 5);
            col += ' (RGB333 ' + api.hex(c9, 3) + ')';
        }
        return 'x ' + (bx >> 1) + ', y ' + by + '  (640: ' + bx + ')  ·  ' + col;
    }

    function hookHover(slot, label) {
        slot.canvas.addEventListener('mousemove', (e) => {
            const t = hoverText(slot, e);
            els.hover.textContent = t ? (label ? api.t('layers.hoverLabel', label(), t) : t) : '';
        });
        slot.canvas.addEventListener('mouseleave', () => {
            els.hover.textContent = '';
        });
    }

    function mount(el, a) {
        api = a;
        const style = document.createElement('style');
        style.textContent = CSS;
        el.appendChild(style);

        els.select = api.el('select', { title: api.t('layers.layer'), onChange: () => {
            sel = els.select.value;
            reload();
        } }, LAYERS.map(([id, name]) => api.el('option', { value: id }, name)));
        els.select.value = sel;
        els.zoom = api.el('select', { title: api.t('layers.zoom'), onChange: () => {
            zoom = +els.zoom.value;
            relayout();
        } }, api.el('option', { value: '1' }, '1×'), api.el('option', { value: '2' }, '2×'));
        els.zoom.value = String(zoom);
        els.all = api.el('input', { type: 'checkbox', onChange: () => {
            all = els.all.checked;
            relayout();
            reload();
        } });
        el.appendChild(api.el('div', { class: 'toolbar' },
            els.select, els.zoom,
            api.el('label', { title: api.t('layers.allTip') }, els.all, ' ' + api.t('layers.all'))));

        main.canvas = api.canvas(W, 256, 1);
        main.canvas.classList.add('checker');
        sizeCanvas(main.canvas, 256, zoom);
        hookHover(main, null);
        els.stage = api.el('div', { class: 'stage' }, main.canvas);

        els.thumbs = api.el('div', { class: 'thumbs' });
        for (const [id, name] of LAYERS) {
            const t = { canvas: api.canvas(W, 256, 1), ctx: null, img: null, data: null, h: 0 };
            t.canvas.classList.add('checker');
            t.box = api.el('div', { class: 'thumb', title: api.t('layers.showLayer', name), onClick: () => {
                sel = id;
                els.select.value = id;
                all = false;
                els.all.checked = false;
                relayout();
                reload();
            } }, t.canvas, api.el('div', { class: 'cap muted' }, name));
            hookHover(t, () => name);
            thumbs[id] = t;
            els.thumbs.appendChild(t.box);
        }

        els.hover = api.el('div', { class: 'hover mono muted' });
        els.info = api.el('div', { class: 'info' });
        els.msg = api.el('div', { class: 'muted' });
        el.appendChild(els.stage);
        el.appendChild(els.thumbs);
        el.appendChild(els.hover);
        el.appendChild(els.msg);
        el.appendChild(els.info);
        relayout();
        if (!api.state.attached) els.msg.textContent = api.t('layers.noSession');
    }

    function relayout() {
        els.stage.style.display = all ? 'none' : '';
        els.thumbs.style.display = all ? '' : 'none';
        sizeCanvas(main.canvas, main.h || 256, zoom);
        for (const id in thumbs) sizeCanvas(thumbs[id].canvas, thumbs[id].h || 256, zoom / 2);
    }

    // Změna výběru z ovládacích prvků: znovu načíst (chybu ukáže pod obrazem).
    function reload() {
        if (!api || !api.state.attached) return;
        refresh(api).catch((e) => {
            els.msg.textContent = api.t('layers.error', (e && e.message) || e);
        });
    }

    function row(label, value, off) {
        return api.el('tr', off ? { class: 'off' } : null, api.el('td', null, label), api.el('td', { class: 'mono' }, value));
    }

    // Ořezová okna: celé jen u spritů (příkaz sprites). NR $18/$1A/$1B mají 4 hodnoty za sebou
    // a čtení vrátí jen tu na indexu z NR $1C (emulator.cpp:2801-2894) – víc ze serveru zjistit nejde.
    // Pokud server časem pošle v odpovědi nextregs pole `clips` {layer2, ula, tilemap}, použije se.
    function clipRows(nr, nrRes, spr) {
        const idx = nr[0x1c];
        const KEYS = ['X1', 'X2', 'Y1', 'Y2'];
        const fmt = (c) => 'X ' + api.hex(c.x1) + '–' + api.hex(c.x2) + ', Y ' + api.hex(c.y1) + '–' + api.hex(c.y2);
        const part = (reg, i) => api.t('layers.clipPart', KEYS[i], api.hex(nr[reg]));
        const clips = (nrRes && nrRes.clips) || {};
        return [
            row('Layer 2 (NR $18)', clips.layer2 ? fmt(clips.layer2) : part(0x18, idx & 3)),
            row(api.t('layers.sprites') + ' (NR $19)', spr && spr.clip ? fmt(spr.clip) : part(0x19, (idx >> 2) & 3)),
            row('ULA (NR $1A)', clips.ula ? fmt(clips.ula) : part(0x1a, (idx >> 4) & 3)),
            row(api.t('layers.tilemap') + ' (NR $1B)', clips.tilemap ? fmt(clips.tilemap) : part(0x1b, (idx >> 6) & 3)),
        ];
    }

    function showInfo(nr, nrRes, spr) {
        const o = layerOrder(nr);
        const en = enables(nr);
        const isOff = (k) => (k === 'S' && !en.sprites) || (k === 'L' && !en.layer2) || (k === 'U' && !en.ula && !en.tilemap && !en.lores);
        const list = api.el('ol', { class: 'order' }, o.order.map((it) => api.el('li', isOff(it.key) ? { class: 'off', title: api.t('layers.layerOff') } : null, it.text)));
        const nr15 = nr[0x15];
        const nr6b = nr[0x6b];
        const flags = api.el('table', { class: 'table' }, api.el('tbody', null,
            row('ULA', api.t(en.ula ? 'layers.ulaOn' : 'layers.ulaOff'), !en.ula),
            row('LoRes', api.t(en.lores ? 'layers.loresOn' : 'layers.loresOff'), !en.lores),
            row('Layer 2', api.t(en.layer2 ? 'layers.layer2On' : 'layers.layer2Off'), !en.layer2),
            row(api.t('layers.sprites'), api.t(en.sprites ? 'layers.spritesOn' : 'layers.spritesOff') +
                ((nr15 & 0x02) ? api.t('layers.spritesBorder') : '') + ((nr15 & 0x40) ? api.t('layers.spritesZeroTop') : ''), !en.sprites),
            row(api.t('layers.tilemap'), api.t(en.tilemap ? ((nr6b & 0x01) ? 'layers.tmOnTop' : 'layers.tmOnAttr') : 'layers.tmOff'), !en.tilemap)));
        const clips = api.el('table', { class: 'table' }, api.el('tbody', null, clipRows(nr, nrRes, spr)));
        els.info.replaceChildren(
            api.el('div', null, api.el('h4', null, api.t('layers.orderTitle', api.hex(nr15), o.name)), list,
                api.el('div', { class: 'muted', style: 'margin-top:4px' }, api.t('layers.priorityNote'))),
            api.el('div', null, api.el('h4', null, api.t('layers.title')), flags),
            api.el('div', null, api.el('h4', null, api.t('layers.clipTitle')), clips));
    }

    async function load(a) {
        const ids = all ? LAYERS.map((l) => l[0]) : [sel];
        const [nrRes, spr, ...imgs] = await Promise.all([
            a.request('nextregs'),
            a.request('sprites').catch(() => null),
            ...ids.map((layer) => a.request('renderLayer', { layer })),
        ]);
        ids.forEach((id, i) => draw(all ? thumbs[id] : main, imgs[i], all ? zoom / 2 : zoom));
        showInfo(a.bytes(nrRes.data), nrRes, spr);
        els.msg.textContent = '';
    }

    async function refresh(a) {
        api = a;
        if (!a.state.attached) {
            els.msg.textContent = api.t('layers.noSession');
            return;
        }
        // Souběh (živý refresh + přepnutí vrstvy): počkat na předchozí a načíst znovu.
        while (busy) await busy.catch(() => {});
        busy = load(a);
        try {
            await busy;
        } finally {
            busy = null;
        }
    }

    NextView.register({ id: ID, title: NextView.t('layers.title'), order: 40, mount, refresh });
})();
