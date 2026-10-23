# MB Maniax Next Debugger

Emulátor ZX Spectrum Next určený k vývoji: ovládá se z VS Code, ladí se ve zdrojáku sjasmplus,
obrazovka emulátoru je v panelu VS Code. Popis pro uživatele: [extension/README.md](extension/README.md).

## Jak je to poskládané

- `server/` – **ladicí server** `mbx-next-server`: jádro [JNEXT](https://github.com/jorgegv/jnext)
  bez okna. Ladění obstarává backend JNEXT (`jnext::dbg::Debugger` – breakpointy, podmínky,
  události, rewind, call stack); server je jeho klient a s rozšířením mluví přes stdin/stdout
  ([docs/protocol.md](docs/protocol.md)).
- `extension/` – **rozšíření VS Code** (TypeScript): ladicí adaptér DAP (`session.ts`, běží přímo
  v rozšíření), čtení SLD ze sjasmplus (`sld.ts`), panel s obrazovkou (`screen.ts`, `media/`).
  `dist/adapter.js` je tentýž adaptér samostatně přes stdin/stdout (testy, jiné editory).
- `examples/hello/` – malý program pro Next na vyzkoušení.
- **Překlady** (13 jazyků, výchozí angličtina): slovníky v `extension/l10n/`, texty manifestu
  v `extension/package.nls*.json`, README pro Marketplace anglicky (`extension/README.md`)
  a česky (`extension/README.cs.md`); pravidla v [docs/l10n.md](docs/l10n.md).

Jádro JNEXT se sdílí s webem a aplikací pro Android MB Maniax: zdroj s patchem
(`tools/jnext-web/jnext.patch` v repozitáři webu) je v `..\mb maniax\.dev\next\jnext`; server do
něj zapojuje háček `JNEXT_SERVER_DIR` v kořenovém `CMakeLists.txt` (z patche).

## Sestavení (Windows)

Potřeba: složka `.dev` webu MB Maniax (zdroj JNEXT s patchem, libpng, zlib, hlavičky SDL3,
překladač llvm-mingw v `.dev\next\llvm-mingw`, CMake a Ninja z Android SDK) a Node.js.

```powershell
powershell -ExecutionPolicy Bypass -File build.ps1            # server → build\release\bin
powershell -ExecutionPolicy Bypass -File build.ps1 -Balicek   # + rozšíření .vsix (s přibaleným serverem)
cd extension; npm install; npm run build                      # jen rozšíření (dist\)
```

Ladění rozšíření: otevřít složku `extension` ve VS Code a F5 (Extension Development Host);
server najde v `..\build\release\bin`.

## Další kroky

1. Podmíněné a událostní breakpointy – hotovo v prvním kole; dál: řádkové přerušení, CTC, MMU.
2. Pohledy pro Next: sprity, palety, Layer 2, tilemapa, seznam Copperu, NEXTREG.
3. Profiler a pokrytí kódu nad zdrojákem (T-stavy).
4. Ladění na skutečném Nextu (KS1 s WiFi): ladicí program v Nextu, spojení přes ESP (TCP).
5. Sestavení pro macOS (arm64 + x64) a Linux.
