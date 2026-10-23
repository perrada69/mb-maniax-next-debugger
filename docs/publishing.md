# Vydání rozšíření

Rozšíření se vydává na **Visual Studio Marketplace** (VS Code) a volitelně na **Open VSX**
(VSCodium, Cursor …). Zdroj je veřejný na https://github.com/perrada69/mb-maniax-next-debugger
(licence GPL 3 to vyžaduje – balíček obsahuje ladicí server sestavený z JNEXT).

## Jednou: vydavatel

1. https://marketplace.visualstudio.com/manage → přihlášení účtem Microsoft → *Create publisher*.
   **ID vydavatele** (jen písmena, číslice, pomlčky) musí být stejné jako pole `publisher`
   v `extension/package.json`.
2. Volitelně ověření domény (modrá značka ověřeného vydavatele).
3. Open VSX (volitelně): https://open-vsx.org, přihlášení účtem GitHub, podpis dohody pro
   vydavatele, jmenný prostor se stejným jménem jako `publisher`, přístupový token.

## Každé vydání

1. Zvýšit `version` v `extension/package.json` (už vydanou verzi nejde nahrát znovu)
   a doplnit záznam `## <verze>` do `extension/CHANGELOG.md`.
2. `powershell -ExecutionPolicy Bypass -File build.ps1 -Vydani` – sestaví server, pustí všechny
   testy, zkontroluje CHANGELOG, zabalí rozšíření a sestaví příručku; výsledek je
   v `release\<verze>\` (`.vsix` + PDF příručky cs/en).
3. Commit, značka `v<verze>`, `git push` a `git push --tags`.
4. Marketplace: v https://marketplace.visualstudio.com/manage u rozšíření *Update* (poprvé
   *New extension → Visual Studio Code*) a nahrát `.vsix`. Kontrola trvá obvykle pár minut.
   Z příkazové řádky jde i `npx vsce publish --packagePath release\<verze>\….vsix` s tokenem
   z Azure DevOps (oprávnění *Marketplace: Manage*).
5. Open VSX: `npx ovsx publish release\<verze>\….vsix -p <token>`.
6. GitHub: *Releases → Draft a new release* ke značce `v<verze>`, přiložit `.vsix` a obě PDF
   příručky (README na ně odkazuje přes Releases).

Balíček je jen pro Windows x64 (`--target win32-x64`): na macOS a Linuxu se rozšíření
nenabídne, dokud se server nesestaví i pro ně.
