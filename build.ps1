# MB Maniax Next Debugger – sestavení ladicího serveru (Windows, llvm-mingw).
#
#   powershell -ExecutionPolicy Bypass -File build.ps1 [-Ladici] [-Znovu] [-Balicek] [-Vydani]
#
# Zdroj JNEXT s patchem, libpng, zlib, hlavičky SDL3 a překladač llvm-mingw (clang + MinGW-w64;
# JNEXT pro Windows upstream překládá přes MinGW) bere ze složky .dev/next webu MB Maniax
# (stejné jádro jako web a aplikace pro Android); cestu jde změnit parametrem -Dev.
# Výsledek: build/release/bin/mbx-next-server.exe (staticky, bez dalších DLL).
#
# -Ladici: ladicí překlad (bez optimalizací) – emulace je v něm pomalá, jen na hledání chyb.
# -Znovu: smaže složku sestavení a nakonfiguruje ji znovu.
# -Balicek: navíc rozšíření VS Code se serverem (extension\mbx-next-debugger-<verze>.vsix);
#           Node.js bere z .dev\emsdk\node webu, pokud není v PATH.
# -Vydani: jako -Balicek, navíc všechny testy (npm test), kontrola záznamu verze v CHANGELOG.md
#          a příručka PDF (cs, en); balíček i příručky do release\<verze>\ – k nahrání na
#          Visual Studio Marketplace a na GitHub (viz docs/publishing.md).

param(
    [string]$Dev = (Join-Path $PSScriptRoot '..\mb maniax\.dev'),
    [switch]$Ladici,
    [switch]$Znovu,
    [switch]$Balicek,
    [switch]$Vydani
)
if ($Vydani) { $Balicek = $true }

$ErrorActionPreference = 'Stop'
$dev = (Resolve-Path $Dev).Path
$next = Join-Path $dev 'next'
$src = Join-Path $next 'jnext'
$cc = Join-Path $next 'llvm-mingw\bin'
$need = @(
    (Join-Path $src 'CMakeLists.txt'),
    (Join-Path $next 'libpng\png.h'),
    (Join-Path $next 'zlib\zlib.h'),
    (Join-Path $next 'sdl3\include\SDL3\SDL.h'),
    (Join-Path $cc 'x86_64-w64-mingw32-clang++.exe')
)
foreach ($p in $need) {
    if (-not (Test-Path $p)) { throw "Chybí $p (viz README.md)" }
}
$cmakeBin = Join-Path $dev 'android\sdk\cmake\3.31.6\bin'
$env:PATH = "$cmakeBin;$cc;$env:PATH"

$type = if ($Ladici) { 'Debug' } else { 'Release' }
$build = Join-Path $PSScriptRoot ('build\' + $type.ToLower())
if ($Znovu -and (Test-Path $build)) { Remove-Item -Recurse -Force $build }

function Slash([string]$p) { $p -replace '\\', '/' }
$server = Slash (Join-Path $PSScriptRoot 'server')
if (-not (Test-Path (Join-Path $build 'build.ninja'))) {
    cmake -S $src -B $build -G Ninja `
        "-DCMAKE_BUILD_TYPE=$type" `
        '-DCMAKE_C_COMPILER=x86_64-w64-mingw32-clang' `
        '-DCMAKE_CXX_COMPILER=x86_64-w64-mingw32-clang++' `
        '-DCMAKE_RC_COMPILER=x86_64-w64-mingw32-windres' `
        '-DCMAKE_EXE_LINKER_FLAGS=-static' `
        "-DJNEXT_SERVER_DIR=$server" `
        "-DCMAKE_PROJECT_jnext_INCLUDE=$server/deps.cmake" `
        "-DJNEXT_ZLIB_SRC=$(Slash (Join-Path $next 'zlib'))" `
        "-DJNEXT_LIBPNG_SRC=$(Slash (Join-Path $next 'libpng'))" `
        "-DSDL3_DIR=$server/sdl3" `
        "-DJNEXT_SDL3_INCLUDE=$(Slash (Join-Path $next 'sdl3\include'))" `
        -DENABLE_TESTS=OFF -DENABLE_DEBUGGER=OFF -DENABLE_QT_UI=OFF `
        -DUSE_CCACHE=OFF -DGIT_SUBMODULE=OFF
    if ($LASTEXITCODE) { throw 'konfigurace selhala' }
}
cmake --build $build --target mbx-next-server
if ($LASTEXITCODE) { throw 'sestavení selhalo' }
$exe = Join-Path $build 'bin\mbx-next-server.exe'
Write-Host "Hotovo: $exe"

if ($Balicek) {
    $ext = Join-Path $PSScriptRoot 'extension'
    $bin = Join-Path $ext 'bin\win32-x64'
    New-Item -ItemType Directory -Force $bin | Out-Null
    Copy-Item $exe $bin -Force
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
        $node = Get-ChildItem (Join-Path $dev 'emsdk\node') -Directory | Sort-Object Name | Select-Object -Last 1
        if (-not $node) { throw 'Chybí Node.js' }
        $env:PATH = "$($node.FullName);$env:PATH"
    }
    Push-Location $ext
    try {
        if (-not (Test-Path 'node_modules')) { npm install --no-fund --no-audit; if ($LASTEXITCODE) { throw 'npm install selhal' } }
        npm run check; if ($LASTEXITCODE) { throw 'kontrola typů selhala' }
        $version = (Get-Content 'package.json' -Raw | ConvertFrom-Json).version
        if ($Vydani) {
            if (-not (Select-String -Path 'CHANGELOG.md' -Pattern "^## $([regex]::Escape($version))\b" -Quiet)) {
                throw "CHANGELOG.md nemá záznam pro verzi $version"
            }
            npm test; if ($LASTEXITCODE) { throw 'testy selhaly' }
        }
        npm run package; if ($LASTEXITCODE) { throw 'sestavení rozšíření selhalo' }
        npx vsce package --no-dependencies --target win32-x64
        if ($LASTEXITCODE) { throw 'balení rozšíření selhalo' }
    } finally {
        Pop-Location
    }
    if ($Vydani) {
        & (Join-Path $PSScriptRoot 'docs\manual\build.ps1')
        $out = Join-Path $PSScriptRoot "release\$version"
        New-Item -ItemType Directory -Force $out | Out-Null
        Copy-Item (Join-Path $ext "mbx-next-debugger-win32-x64-$version.vsix") $out -Force
        Copy-Item (Join-Path $PSScriptRoot 'docs\manual\out\*.pdf') $out -Force
        Write-Host "Vydání $version připravené: $out"
    }
}
