"""Čísla stran pro obsah manuálu: z PDF (Edge --print-to-pdf) vytáhne cíle vnitřních odkazů
(<a href="#id"> → pojmenovaný cíl a strana) a zapíše je jako out/pages.<jazyk>.js:
    window.MANUAL_PAGES = {"id": strana, ...};
Vypíše "changed" nebo "same" (podle toho, jestli se obsah souboru změnil) – build.ps1 pak
případně tiskne znovu. Potřebuje PyMuPDF (pip install pymupdf).

Použití: python toc-pages.py vstup.pdf výstup.js
"""
import json
import os
import sys


def main() -> int:
    pdf, out = sys.argv[1], sys.argv[2]
    try:
        import pymupdf  # type: ignore
    except ImportError:
        try:
            import fitz as pymupdf  # type: ignore  # starší jméno balíčku
        except ImportError:
            print("nopymupdf")
            return 2
    doc = pymupdf.open(pdf)
    pages = {}
    for page in doc:
        for link in page.get_links():
            name = link.get("nameddest")
            target = link.get("page")
            if name and isinstance(target, int) and target >= 0 and name not in pages:
                pages[name] = target + 1   # tištěné číslo = pořadí strany (titulní je 1)
    text = "window.MANUAL_PAGES = " + json.dumps(pages, ensure_ascii=False, sort_keys=True) + ";\n"
    old = None
    if os.path.exists(out):
        with open(out, encoding="utf-8") as f:
            old = f.read()
    if old != text:
        with open(out, "w", encoding="utf-8") as f:
            f.write(text)
        print("changed")
    else:
        print("same")
    return 0


if __name__ == "__main__":
    sys.exit(main())
