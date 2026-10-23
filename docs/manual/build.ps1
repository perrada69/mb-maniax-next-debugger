# Sestavení manuálu: manual.cs.html a manual.en.html → PDF přes Edge headless (--print-to-pdf).
#
#   powershell -ExecutionPolicy Bypass -File docs\manual\build.ps1            # obě verze
#   powershell -ExecutionPolicy Bypass -File docs\manual\build.ps1 -Lang cs   # jen česky
#
# Výstup: docs\manual\out\MB-Maniax-Next-Debugger-manual-<jazyk>.pdf
# Čísla stran v obsahu: po tisku je toc-pages.py (Python + PyMuPDF) vytáhne z PDF do
# out\pages.<jazyk>.js a tiskne se znovu, dokud se nepřestanou měnit (nejvýš 3×). Bez Pythonu
# nebo PyMuPDF vznikne PDF s obsahem bez čísel stran.
# Snímky: img\<jazyk>\<jméno>.png; chybějící snímek se vysází jako prázdný rámeček s popiskem.

param(
    [ValidateSet('cs', 'en', 'all')]
    [string]$Lang = 'all',
    [string]$Edge = ''
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$out = Join-Path $here 'out'
New-Item -ItemType Directory -Force $out | Out-Null

if (-not $Edge) {
    $candidates = @(
        "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
        "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
        "$env:ProgramFiles\Google\Chrome\Application\chrome.exe"
    )
    $Edge = $candidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
}
if (-not $Edge -or -not (Test-Path $Edge)) { throw "Edge (msedge.exe) nenalezen – zadejte cestu parametrem -Edge." }

$python = Get-Command python -ErrorAction SilentlyContinue
# Samostatný profil, ať se headless Edge nepřipojí k běžícímu oknu prohlížeče.
$profileDir = Join-Path $env:TEMP 'mbx-manual-edge-profile'

function Invoke-Print([string]$html, [string]$pdf) {
    if (Test-Path $pdf) { Remove-Item $pdf -Force }
    $url = 'file:///' + ($html -replace '\\', '/')
    $argList = @(
        '--headless=new', '--disable-gpu', '--no-first-run', '--disable-extensions',
        "--user-data-dir=`"$profileDir`"",
        '--no-pdf-header-footer', '--generate-pdf-document-outline',
        '--virtual-time-budget=15000',
        "--print-to-pdf=`"$pdf`"",
        "`"$url`""
    )
    $p = Start-Process -FilePath $Edge -ArgumentList $argList -Wait -PassThru -WindowStyle Hidden
    if (-not (Test-Path $pdf)) { throw "Tisk do PDF selhal ($html, kód $($p.ExitCode))." }
}

$langs = if ($Lang -eq 'all') { @('cs', 'en') } else { @($Lang) }
foreach ($l in $langs) {
    $html = Join-Path $here "manual.$l.html"
    $pdf = Join-Path $out "MB-Maniax-Next-Debugger-manual-$l.pdf"
    $pagesJs = Join-Path $out "pages.$l.js"
    Write-Host "[$l] $html"
    for ($pass = 1; $pass -le 3; $pass++) {
        Invoke-Print $html $pdf
        if (-not $python) { Write-Warning 'Python nenalezen – obsah bez čísel stran.'; break }
        $r = (& $python.Source (Join-Path $here 'toc-pages.py') $pdf $pagesJs | Out-String).Trim()
        if ($r -eq 'nopymupdf') { Write-Warning 'Chybí PyMuPDF (pip install pymupdf) – obsah bez čísel stran.'; break }
        if ($r -eq 'same') { break }
        Write-Host "  průchod $pass – čísla stran se změnila, tisknu znovu"
    }
    $size = [math]::Round((Get-Item $pdf).Length / 1KB)
    Write-Host "  → $pdf ($size kB)"
}
