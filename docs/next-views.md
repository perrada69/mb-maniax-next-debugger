# Panel „Next“ – pohledy na hardware Nextu

Panel ve VS Code (webview) se záložkami: Sprity, Pattern RAM, Palety, Tilemapa, Layer 2, Vrstvy,
Copper, NEXTREG. Data si každý pohled bere sám ze serveru přes rozšíření; obnovují se při
zastavení stroje, tlačítkem „Obnovit“ a volitelně živě za běhu (přepínač „Živě“, 2× za sekundu).

Referencí pro chování hardwaru je zdroj JNEXT (`D:\Source\mb maniax\.dev\next\jnext\src`,
hlavně `video/`), ne paměť autora.

## Příkazy serveru (doplněk k protocol.md)

Všechny jen čtou, běží za chodu i v pauze. Binární data jsou base64.

| příkaz | argumenty | odpověď |
| --- | --- | --- |
| `sprites` | | `sprites` [128 × {`x`, `y`, `pattern`, `paletteOffset`, `visible`, `xMirror`, `yMirror`, `rotate`, `is4bit`, `xScale`, `yScale`}], `attrs` (base64, 128 × 5 B syrových atributů), `clip` {`x1`, `x2`, `y1`, `y2`} |
| `patternRam` | | `data` (base64, 16384 B) |
| `palettes` | | `banks` {`ula0`, `ula1`, `layer2_0`, `layer2_1`, `sprite0`, `sprite1`, `tilemap0`, `tilemap1`: pole 256 čísel RGB333}, `activeUla` (0/1) |
| `copper` | | `pc` (0–1023), `running`, `mode`, `program` (base64, 1024 slov u16 little endian = 2048 B) |
| `renderLayer` | `layer`: `composite` / `ula` / `ulaShadow` / `layer2` / `layer2Shadow` / `sprites` / `tilemap` / `background` | `width` (640), `height`, `data` (base64 RGBA, alfa 0 = průhledné) |
| `readMemory` | `addr`, `length`, `page`? | s `page` (8K stránka) smí `length` až 0x30000 a čte souvislé stránky za sebou (page, page+1, …) |
| `nextregs` | | `data` (256 B), `clips` {`layer2`, `sprites`, `ula`, `tilemap`: {`x1`, `x2`, `y1`, `y2`}} (syrové hodnoty registrů) |

**RGB333** = číslo 0–511, bity 8–6 R, 5–3 G, 2–0 B. Na 8 bitů: `c8 = (c << 5) | (c << 2) | (c >> 1)`.
Souřadnice obrazu: framebuffer 640 × 256 = oblast 320 × 256 (včetně okraje) zdvojená vodorovně;
souřadnice spritů a `highlight` jsou v prostoru 320 × 256 (sprite X 0 = levý okraj této oblasti).

## Rozšíření ↔ webview

Webview → rozšíření: `{type: 'request', id, cmd, args}` → zpět `{type: 'response', id, ok, result | error}`.
Povolené `cmd`: `sprites`, `patternRam`, `palettes`, `copper`, `renderLayer`, `readMemory`,
`nextregs`, `mmu`, `state`, `registers`. Bez ladicího sezení přijde `ok: false`.

Rozšíření → webview: `{type: 'attached'}`, `{type: 'detached'}`, `{type: 'stopped'}`,
`{type: 'continued'}`.

## API pro pohledy (media/next.js)

Každý pohled je samostatný soubor `media/views/<id>.js`, načtený po `next.js`, a zaregistruje se:

```js
NextView.register({
    id: 'sprites',            // jednoznačné, = jméno souboru
    title: 'Sprity',          // text záložky
    order: 10,                // pořadí záložek
    mount(el, api) { },       // jednou: el = prázdný <div> záložky
    async refresh(api) { },   // stroj se zastavil / „Obnovit“ / živě; jen když je záložka vidět
});
```

`api`:
- `api.request(cmd, args?)` → `Promise<result>` (odmítne s Error při `ok: false`).
- `api.bytes(base64)` → `Uint8Array`.
- `api.rgb(rgb333)` → `[r, g, b]` (0–255); `api.css(rgb333)` → `'#rrggbb'`.
- `api.hex(v, digits)` → `'$0A'`.
- `api.state` → `{attached, paused}` (jen čtení).
- `api.highlight(rect | null)` – obdélník `{x, y, w, h}` (prostor 320 × 256) zvýrazní na obrazovce
  emulátoru v panelu „ZX Spectrum Next“; `null` zruší.
- `api.canvas(width, height, scale?)` → `<canvas>` s vypnutým vyhlazováním (`image-rendering: pixelated`),
  CSS velikost = width·scale × height·scale.
- `NextView.show(id)` – přepne na záložku podle id (vrací false pro neznámé id).
- `api.el(tag, attrs?, ...children)` – malý pomocník na DOM (attrs: `class`, `title`, `style`, `on<Event>`, ostatní jako atributy).

Pohled nesmí sahat na jiné pohledy ani na globální stav kromě `NextView`. Styly: společné třídy
v `media/next.css` (`.toolbar`, `.grid`, `.table`, `.mono`, `.muted`, `.swatch`, `.selected`),
vlastní styly pohled vkládá do svého `el` s prefixem `#view-<id>`. Barvy z proměnných VS Code
(`var(--vscode-foreground)` …), ať to vypadá dobře ve světlém i tmavém motivu. Texty česky.

Content Security Policy webview: skripty jen se `nonce`, žádné inline `on…` atributy v HTML
(posluchače přes `addEventListener` nebo `api.el`), žádné externí zdroje, obrázky `data:` a `blob:` povolené.

## Doplňky: paprsek, paměť, zvuk

Nové příkazy serveru (jen čtou, za běhu i v pauze):

| příkaz | odpověď |
| --- | --- |
| `raster` | `vc`, `hc` (syrové čítače), `x`, `y` (pozice paprsku v prostoru 320 × 256, −1 mimo), `frame`, `cycleInFrame`, `linesPerFrame` |
| `soundState` | `chips` [3 × {`regs`: 16 čísel}], `turbosound` (bool), `ayMode` (text), `dac` [4 čísla] nebo null |
| `pageUsage` | `nonzero` [224 čísel: počet nenulových bajtů v každé 8K stránce], `rom` [čísla stránek ROM nebo prázdné] |

Dotaz vyřizovaný rozšířením (ne serverem), povolený ve webview: `symbols` → `{labels: [{name, addr, page}], codePages: {"<stránka>": počet řádků kódu ze SLD}}` (bez SLD prázdné). Povolený navíc i `writeMemory` (úprava paměti v pohledu Paměť).

Nové záložky: `memory` (Paměť – hex prohlížeč, order 85), `memmap` (Mapa paměti, order 86), `sound` (Zvuk, order 87).
