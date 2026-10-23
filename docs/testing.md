# Testy

`cd extension; npm test` – sestaví `extension/test/**/*.test.ts` (esbuild, `test/build.mjs`) do
`extension/out-test/` a spustí je vestavěným `node --test`. Node.js 20+ (bez dalších knihoven).

- `test/unit/` – rychlé testy bez emulátoru: moduly z `src/` (importem `../../src/…`), slovníky
  `l10n/`, pohledy panelu Next (`media/views/*.js`) nad podvrženým DOM.
- `test/integration/` – proti skutečnému serveru `build/release/bin/mbx-next-server.exe` (příklady
  `examples/hello`, `examples/features`); když server chybí, test se přeskočí (`test.skip` s důvodem).
- Modul `vscode` nahrazuje `test/stubs/vscode.js`; test si potřebné chování doplní sám.
- Výstup sestavení je plochý (`out-test/<jméno>.test.js`), jména testových souborů proto musí být
  jedinečná v celé složce `test/`.
- Každá nová funkce přichází s testy; testy jsou česky pojmenované (`test('…', …)`).
