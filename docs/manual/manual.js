// MB Maniax Next Debugger – manuál: číslování kapitol a obrázků, obsah, prázdné rámečky za chybějící
// snímky. Běží v prohlížeči i v Edge headless při tisku do PDF (build.ps1).
// Čísla stran v obsahu: build.ps1 je po prvním tisku vytáhne z PDF (toc-pages.py) do
// out/pages.<jazyk>.js (window.MANUAL_PAGES = {id: strana}); bez souboru zůstanou prázdná.
(function () {
    'use strict';

    const lang = (document.documentElement.lang || 'en').slice(0, 2);
    const T = {
        cs: { fig: 'Obrázek', missing: 'Snímek zatím chybí', toc: 'Obsah' },
        en: { fig: 'Figure', missing: 'Screenshot not available yet', toc: 'Contents' },
    }[lang] || { fig: 'Figure', missing: 'Screenshot not available yet', toc: 'Contents' };
    const pages = window.MANUAL_PAGES || {};
    const main = document.querySelector('main');
    if (!main) return;

    function slug(s) {
        return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    }

    // ---- kapitoly (h2) a oddíly (h3)
    const entries = [];
    let c2 = 0;
    let c3 = 0;
    for (const h of main.querySelectorAll('h2, h3')) {
        if (h.classList.contains('nonum')) continue;
        let num;
        if (h.tagName === 'H2') {
            c2++;
            c3 = 0;
            num = String(c2);
        } else {
            c3++;
            num = c2 + '.' + c3;
        }
        if (!h.id) h.id = 'sec-' + slug(h.textContent);
        const text = h.textContent;
        const span = document.createElement('span');
        span.className = 'num';
        span.textContent = num;
        h.insertBefore(document.createTextNode(' '), h.firstChild);   // mezera kvůli osnově PDF
        h.insertBefore(span, h.firstChild);
        entries.push({ level: h.tagName === 'H2' ? 2 : 3, num, text, id: h.id });
    }

    // ---- obsah
    const nav = document.querySelector('nav.toc');
    if (nav) {
        const ol = document.createElement('ol');
        for (const e of entries) {
            const li = document.createElement('li');
            li.className = 'l' + e.level;
            const a = document.createElement('a');
            a.href = '#' + e.id;
            const n = document.createElement('span');
            n.className = 'num';
            n.textContent = e.num;
            const t = document.createElement('span');
            t.className = 'txt';
            t.textContent = e.text;
            const d = document.createElement('span');
            d.className = 'dots';
            const p = document.createElement('span');
            p.className = 'pg';
            p.textContent = pages[e.id] ? String(pages[e.id]) : '';
            a.append(n, t, d, p);
            li.appendChild(a);
            ol.appendChild(li);
        }
        nav.appendChild(ol);
    }

    // ---- obrázky: čísla, odkazy na ně, rámeček za chybějící snímek
    const figNum = {};
    let f = 0;
    for (const fig of main.querySelectorAll('figure.shot')) {
        f++;
        if (fig.id) figNum[fig.id] = f;
        const cap = fig.querySelector('figcaption');
        if (cap) {
            const s = document.createElement('span');
            s.className = 'fignum';
            s.textContent = T.fig + ' ' + f;
            cap.insertBefore(s, cap.firstChild);
        }
        const img = fig.querySelector('img');
        if (!img) continue;
        const ph = document.createElement('div');
        ph.className = 'ph';
        const msg = document.createElement('span');
        msg.textContent = T.missing;
        const path = document.createElement('code');
        path.textContent = img.getAttribute('src');
        ph.append(msg, path);
        fig.insertBefore(ph, img.nextSibling);
        const missing = () => fig.classList.add('missing');
        img.addEventListener('error', missing);
        if (img.complete && img.naturalWidth === 0) missing();
    }
    for (const a of document.querySelectorAll('a.figref')) {
        const id = (a.getAttribute('href') || '').slice(1);
        a.textContent = figNum[id] ? String(figNum[id]) : '?';
    }
    // odkazy na kapitoly: <a class="secref" href="#id"></a> → „5.3“
    const secNum = {};
    for (const e of entries) secNum[e.id] = e.num;
    for (const a of document.querySelectorAll('a.secref')) {
        const id = (a.getAttribute('href') || '').slice(1);
        if (!a.textContent.trim()) a.textContent = secNum[id] || '?';
    }
})();
