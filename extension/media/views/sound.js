// Pohled „Zvuk“: 3 čipy AY (TurboSound) × 3 kanály – tón (perioda → Hz a nota), hlasitost/obálka, mixer,
// šum, obálka (perioda, tvar), registry R0–R15; DAC (4 kanály). Data z `soundState`.
// Hardware podle JNEXT: takt PSG = 28 MHz / 16 = 1,75 MHz (core/emulator_config.h:536 MASTER_CLOCK_HZ,
// core/emulator.cpp:11067 PSG_DIVISOR = 16, audio/ay_chip.h:14-15); tón i obálka běží z děliče /8
// (ay_chip.cpp:208-241), šum z /16; tón přepne výstup po P krocích → f = 1,75 MHz / (16 · P), P 0 a 1
// se chovají stejně (tone_comp, ay_chip.cpp:139-146); obálka 32 kroků po EP → f = 1,75 MHz / (256 · EP)
// (env_comp ay_chip.cpp:162-167, update_envelope :271); mixer R7 b0–2 tón, b3–5 šum, 0 = zapnuto,
// R8–R10 b4 = obálka (update_output ay_chip.cpp:374-400); tvary obálky ay_chip.cpp:322-370.
(function () {
    'use strict';

    const ID = 'sound';
    const AY_CLOCK = 1750000;
    const CH = ['A', 'B', 'C'];

    const CSS = `
#view-sound .sd-info { margin-bottom: 8px; }
#view-sound .sd-chips { display: flex; flex-wrap: wrap; gap: 10px; align-items: flex-start; }
#view-sound .sd-chip { border: 1px solid var(--vscode-panel-border); padding: 4px 8px 6px; min-width: 330px; }
#view-sound .sd-chip.active { border-color: var(--vscode-focusBorder); }
#view-sound .sd-chip.idle { opacity: 0.6; }
#view-sound .sd-chip h3 { margin: 2px 0 4px; font-size: 1em; font-weight: bold; }
#view-sound .sd-badge { font-weight: normal; margin-left: 6px; padding: 0 4px; border-radius: 2px;
    background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
#view-sound .sd-badge.off { background: none; color: var(--vscode-descriptionForeground); }
#view-sound .table td.num { text-align: right; }
#view-sound .sd-bar { position: relative; display: inline-block; width: 64px; height: 9px; vertical-align: middle;
    background: var(--vscode-input-background); border: 1px solid var(--vscode-panel-border); }
#view-sound .sd-bar > span { position: absolute; left: 0; top: 0; bottom: 0; width: 0;
    background: var(--vscode-charts-green); transition: width 0.25s ease-out; }
#view-sound .sd-bar.env > span { background: repeating-linear-gradient(90deg, var(--vscode-charts-purple) 0 4px,
    color-mix(in srgb, var(--vscode-charts-purple) 50%, transparent) 4px 8px); }
#view-sound .sd-on { color: var(--vscode-charts-green); }
#view-sound .sd-offv { color: var(--vscode-descriptionForeground); }
#view-sound .sd-line { margin-top: 4px; }
#view-sound .sd-regs td, #view-sound .sd-regs th { padding: 0 3px; text-align: center; }
#view-sound .sd-regs td.chg { color: var(--vscode-editorWarning-foreground); font-weight: bold; }
#view-sound .sd-dac { display: flex; gap: 10px; align-items: flex-end; margin-top: 6px; }
#view-sound .sd-col { display: flex; flex-direction: column; align-items: center; gap: 2px; }
#view-sound .sd-colbar { position: relative; width: 22px; height: 80px; background: var(--vscode-input-background);
    border: 1px solid var(--vscode-panel-border); }
#view-sound .sd-colbar > span { position: absolute; left: 0; right: 0; bottom: 0; height: 0;
    background: var(--vscode-charts-blue); transition: height 0.25s ease-out; }
#view-sound .sd-colbar > i { position: absolute; left: 0; right: 0; bottom: 50%; border-top: 1px dashed var(--vscode-descriptionForeground); }
#view-sound h4 { margin: 12px 0 2px; font-size: 1em; }
`;

    const t = NextView.t;

    // ---- čisté funkce (testovatelné bez DOM)

    /** Perioda tónu (12 bitů) z R(2ch), R(2ch+1). */
    function tonePeriod(regs, ch) {
        return ((regs[ch * 2 + 1] & 0x0f) << 8) | (regs[ch * 2] & 0xff);
    }

    /** Kmitočet tónu v Hz: 1,75 MHz / (16 · P); P 0 = 1 (tone_comp). */
    function toneHz(period) {
        return AY_CLOCK / (16 * Math.max(1, period));
    }

    /** Kmitočet šumu (R6 b4:0): 1,75 MHz / (16 · NP); NP 0 = 1 (noise_comp). */
    function noiseHz(period) {
        return AY_CLOCK / (16 * Math.max(1, period & 0x1f));
    }

    /** Kmitočet obálky (jedna rampa 32 kroků): 1,75 MHz / (256 · EP); EP 0 = 1 (env_comp). */
    function envHz(period) {
        return AY_CLOCK / (256 * Math.max(1, period));
    }

    /** Nota k frekvenci (A4 = 440 Hz, MIDI 69): {midi, index 0–11 od C, octave, cents}. */
    function noteOf(hz) {
        if (!(hz > 0)) return null;
        const m = 69 + 12 * Math.log2(hz / 440);
        const midi = Math.round(m);
        return { midi, index: ((midi % 12) + 12) % 12, octave: Math.floor(midi / 12) - 1, cents: Math.round((m - midi) * 100) };
    }

    /** Jméno noty podle slovníku (sound.noteNames = 12 jmen oddělených čárkou). */
    function noteName(n, names) {
        if (!n) return '';
        return (names[n.index] || '?') + n.octave;
    }

    // Tvary obálky R13 b3:0 (CONT ATT ALT HOLD), ay_chip.cpp:322-370 / ym2149.vhd:371-391
    // [průběh, klíč popisu]
    const SHAPES = {
        decay: ['\\___', 'sound.env.decay'],
        attack: ['/___', 'sound.env.attack'],
        sawDown: ['\\\\\\\\', 'sound.env.sawDown'],
        triDown: ['\\/\\/', 'sound.env.triDown'],
        decayHold: ['\\‾‾‾', 'sound.env.decayHold'],
        sawUp: ['////', 'sound.env.sawUp'],
        attackHold: ['/‾‾‾', 'sound.env.attackHold'],
        triUp: ['/\\/\\', 'sound.env.triUp'],
    };

    function envShape(r13) {
        const s = r13 & 15;
        let key;
        if (s < 4) key = 'decay';
        else if (s < 8) key = 'attack';
        else key = ['sawDown', 'decay', 'triDown', 'decayHold', 'sawUp', 'attackHold', 'triUp', 'attack'][s - 8];
        return { shape: s, key, glyph: SHAPES[key][0], text: SHAPES[key][1] };
    }

    /** Dekódování 16 registrů jednoho čipu. */
    function decodeChip(regs) {
        const r = (i) => (regs && Number(regs[i])) & 0xff;
        const rr = [];
        for (let i = 0; i < 16; i++) rr.push(r(i));
        const channels = [];
        for (let c = 0; c < 3; c++) {
            const period = tonePeriod(rr, c);
            const hz = toneHz(period);
            const amp = rr[8 + c];
            channels.push({
                period, hz, note: noteOf(hz),
                volume: amp & 15, env: (amp & 0x10) !== 0,
                tone: (rr[7] & (1 << c)) === 0, noise: (rr[7] & (8 << c)) === 0,
            });
        }
        const np = rr[6] & 0x1f;
        const ep = rr[11] | (rr[12] << 8);
        return { regs: rr, channels, noise: { period: np, hz: noiseHz(np) }, env: { period: ep, hz: envHz(ep), ...envShape(rr[13]) }, mixer: rr[7] };
    }

    // ---- stav pohledu
    let api = null;
    let prevRegs = null;
    const chipEls = [];
    const els = {};
    let noteNames = [];

    function fmtNum(v, d) {
        try {
            return v.toLocaleString(api.lang || NextView.lang, { minimumFractionDigits: d, maximumFractionDigits: d });
        } catch (e) {
            return v.toFixed(d);
        }
    }

    function fmtHz(hz) {
        return fmtNum(hz, hz >= 1000 ? 0 : hz >= 100 ? 1 : 2) + ' Hz';
    }

    function h(v, d) {
        return '$' + v.toString(16).toUpperCase().padStart(d, '0');
    }

    function bar(cls) {
        const fill = api.el('span');
        return { box: api.el('span', { class: 'sd-bar' + (cls ? ' ' + cls : '') }, fill), fill };
    }

    /** Popis registru AY R0–R15. */
    function regTitle(n) {
        if (n < 6) return t(n & 1 ? 'sound.regToneCoarse' : 'sound.regToneFine', CH[n >> 1]);
        if (n === 6) return t('sound.regNoise');
        if (n === 7) return t('sound.regMixer');
        if (n < 11) return t('sound.regAmp', CH[n - 8]);
        if (n === 11) return t('sound.regEnvFine');
        if (n === 12) return t('sound.regEnvCoarse');
        if (n === 13) return t('sound.regEnvShape');
        return t('sound.regPort', n === 14 ? 'A' : 'B');
    }

    function buildChip(i) {
        const e = { rows: [], regs: [] };
        e.badge = api.el('span', { class: 'sd-badge off' });
        const head = api.el('h3', null, 'AY #' + i, e.badge);
        const tbody = api.el('tbody');
        for (let c = 0; c < 3; c++) {
            const r = {
                period: api.el('td', { class: 'mono num' }), hz: api.el('td', { class: 'mono num' }), note: api.el('td', { class: 'mono' }),
                vol: bar(), volText: api.el('span', { class: 'mono' }), tone: api.el('td', { class: 'mono' }), noise: api.el('td', { class: 'mono' }),
            };
            tbody.appendChild(api.el('tr', null, api.el('td', null, CH[c]), r.period, r.hz, r.note,
                api.el('td', null, r.vol.box, ' ', r.volText), r.tone, r.noise));
            e.rows.push(r);
        }
        const table = api.el('table', { class: 'table' },
            api.el('thead', null, api.el('tr', null,
                api.el('th', null, t('sound.colChannel')),
                api.el('th', { title: t('sound.colPeriodTip') }, t('sound.colPeriod')),
                api.el('th', { title: t('sound.colFreqTip') }, t('sound.colFreq')),
                api.el('th', { title: t('sound.colNoteTip') }, t('sound.colNote')),
                api.el('th', { title: t('sound.colVolumeTip') }, t('sound.colVolume')),
                api.el('th', { title: t('sound.colToneTip') }, t('sound.colTone')),
                api.el('th', { title: t('sound.colNoiseTip') }, t('sound.colNoise')))),
            tbody);
        e.noise = api.el('div', { class: 'sd-line mono' });
        e.env = api.el('div', { class: 'sd-line mono' });
        const rh = api.el('tr');
        const rv = api.el('tr');
        for (let n = 0; n < 16; n++) {
            rh.appendChild(api.el('th', { title: regTitle(n) }, 'R' + n));
            const td = api.el('td', { class: 'mono', title: regTitle(n) }, '--');
            rv.appendChild(td);
            e.regs.push(td);
        }
        const regs = api.el('table', { class: 'table sd-regs' }, api.el('thead', null, rh), api.el('tbody', null, rv));
        e.box = api.el('div', { class: 'sd-chip' }, head, table, e.noise, e.env, api.el('div', { class: 'sd-line' }, regs));
        return e;
    }

    function mount(el, a) {
        api = a;
        noteNames = t('sound.noteNames').split(',').map((s) => s.trim());
        el.appendChild(api.el('style', null, CSS));
        els.info = api.el('div', { class: 'sd-info' });
        el.appendChild(els.info);
        const chips = api.el('div', { class: 'sd-chips' });
        for (let i = 0; i < 3; i++) {
            chipEls.push(buildChip(i));
            chips.appendChild(chipEls[i].box);
        }
        el.appendChild(chips);
        els.dacHead = api.el('h4', { title: t('sound.dacTip') }, 'DAC');
        els.dac = api.el('div', { class: 'sd-dac' });
        els.dacCols = [];
        for (let i = 0; i < 4; i++) {
            const fill = api.el('span');
            const val = api.el('span', { class: 'mono' }, '--');
            els.dacCols.push({ fill, val });
            els.dac.appendChild(api.el('div', { class: 'sd-col' }, api.el('div', { class: 'sd-colbar' }, fill, api.el('i')), val,
                api.el('span', { class: 'muted' }, 'ABCD'[i])));
        }
        els.dacNone = api.el('div', { class: 'muted' }, t('sound.noDac'));
        els.dacNone.hidden = true;
        el.appendChild(els.dacHead);
        el.appendChild(els.dac);
        el.appendChild(els.dacNone);
        els.info.textContent = api.state.attached ? '' : t('sound.noSession');
    }

    function onOff(td, on) {
        const text = on ? t('sound.on') : '–';
        if (td.textContent !== text) td.textContent = text;
        td.className = 'mono ' + (on ? 'sd-on' : 'sd-offv');
    }

    function paintChip(e, d, i, active, running) {
        e.box.className = 'sd-chip' + (active ? ' active' : '') + (running ? '' : ' idle');
        e.badge.textContent = active ? t('sound.active') : running ? '' : t('sound.idle');
        e.badge.className = 'sd-badge' + (active ? '' : ' off');
        e.badge.hidden = !e.badge.textContent;
        for (let c = 0; c < 3; c++) {
            const ch = d.channels[c];
            const r = e.rows[c];
            r.period.textContent = h(ch.period, 3) + ' ' + ch.period;
            r.hz.textContent = fmtHz(ch.hz);
            r.note.textContent = noteName(ch.note, noteNames) + (ch.note && ch.note.cents ? ' ' + (ch.note.cents > 0 ? '+' : '') + ch.note.cents + '¢' : '');
            r.note.title = ch.note ? 'MIDI ' + ch.note.midi : '';
            r.vol.box.className = 'sd-bar' + (ch.env ? ' env' : '');
            r.vol.fill.style.width = (ch.env ? 100 : Math.round((ch.volume / 15) * 100)) + '%';
            r.volText.textContent = ch.env ? t('sound.envelope') : String(ch.volume);
            r.volText.title = ch.env ? t('sound.envVolumeTip') : '';
            onOff(r.tone, ch.tone);
            onOff(r.noise, ch.noise);
        }
        e.noise.textContent = t('sound.noiseLine', h(d.noise.period, 2), d.noise.period, fmtHz(d.noise.hz), h(d.mixer, 2));
        e.env.textContent = t('sound.envLine', h(d.env.period, 4), d.env.period, fmtHz(d.env.hz), h(d.env.shape, 1), d.env.glyph, t(d.env.text));
        e.env.title = t('sound.envTip');
        const prev = prevRegs && prevRegs[i];
        for (let n = 0; n < 16; n++) {
            const v = d.regs[n];
            e.regs[n].textContent = v.toString(16).toUpperCase().padStart(2, '0');
            e.regs[n].className = 'mono' + (prev && prev[n] !== v ? ' chg' : '');
        }
    }

    function paint(res) {
        const chips = Array.isArray(res.chips) ? res.chips : [];
        const ts = !!res.turbosound;
        const act = typeof res.active === 'number' ? res.active : null;   // nepovinné (aktivní čip, port $FFFD)
        const parts = [t('sound.mode', res.ayMode || '?'), t(ts ? 'sound.turboOn' : 'sound.turboOff'), t('sound.clock', fmtNum(AY_CLOCK / 1e6, 2) + ' MHz')];
        if (act !== null) parts.splice(2, 0, t('sound.activeChip', act));
        els.info.textContent = parts.join('  ·  ');
        const now = [];
        for (let i = 0; i < 3; i++) {
            const d = decodeChip(chips[i] && chips[i].regs);
            now.push(d.regs);
            // bez TurboSound tiká jen AY #0 (a vybraný čip; turbosound.cpp:139-151)
            paintChip(chipEls[i], d, i, act === i, i === 0 || ts || act === i);
        }
        prevRegs = now;
        const dac = Array.isArray(res.dac) ? res.dac : null;
        els.dac.hidden = !dac;
        els.dacNone.hidden = !!dac;
        if (dac) {
            for (let i = 0; i < 4; i++) {
                const v = (Number(dac[i]) || 0) & 0xff;
                els.dacCols[i].fill.style.height = Math.round((v / 255) * 100) + '%';
                els.dacCols[i].val.textContent = v.toString(16).toUpperCase().padStart(2, '0');
            }
        }
    }

    async function refresh(a) {
        api = a;
        if (!a.state.attached) {
            els.info.textContent = t('sound.noSession');
            return;
        }
        paint(await a.request('soundState'));
    }

    NextView.register({
        id: ID, title: t('sound.title'), order: 87, mount, refresh,
        // pro testy (docs/testing.md): čisté funkce bez DOM
        helpers: { AY_CLOCK, tonePeriod, toneHz, noiseHz, envHz, noteOf, noteName, envShape, decodeChip },
    });
})();
