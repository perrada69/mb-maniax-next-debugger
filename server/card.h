// MB Maniax Next Debugger – pracovní karta NextZXOS (obraz SD karty FAT32).
//
// Start do NextZXOS (launch "boot": "nextzxos"): před bootem se do obrazu nahraje složka
// programu a program, autoexec.bas je spustí, po sezení se autoexec vrátí a změněné soubory
// se volitelně zkopírují zpět. Obraz je uživatelova vlastní kopie distribuce ze specnext.com
// (ta se nikdy nešíří, viz docs/protocol.md); karta se jen čte a zapisuje přes FatFs z jádra.
//
// Vše tady pracuje s obrazem, který NENÍ připojený v emulátoru, nebo s připojeným, ale jen
// mezi snímky (FatFs má vlastní přístup k souboru, emulovaná karta zapisuje po blocích hned).

#pragma once

#include <cstdint>
#include <string>
#include <vector>

namespace card {

/// Z oficiálního zipu distribuce (sn-emulator-*.zip) vybalí cspect-next-1gb.img, upraví ho jako
/// JNEXT (FAT32 s clustery 8 KB, config.ini, viz sdcard::patch_image_fat32) a uloží jako `out_image`.
bool prepare_from_zip(const std::string& zip, const std::string& out_image, std::string& err);

/// Složka na kartě ve tvaru, kterému rozumí NextZXOS i FatFs bez písmene jednotky ("/MBX/hra").
/// Prázdná nebo neplatná → false a `err`.
bool normalize_folder(const std::string& folder, std::string& out, std::string& err);

/// Co stage() na kartu nahrál.
struct Staged {
    std::string program_on_card;   ///< cesta k programu na kartě ("/MBX/hra/hra.nex")
    unsigned files = 0;            ///< nahraných souborů celkem (včetně programu)
};

/// Před bootem: složka `host_root` (celý obsah) a program do `folder` na kartě (přepíše, co tam
/// je), a autoexec.bas, který přejde do `folder` a program spustí (`autorun`), nebo otevře
/// Browser. Vlastní autoexec.bas uživatele se odloží do AUTOEXEC.MBX a finish() ho vrátí;
/// zůstane-li odložený po pádu, stage() ho nepřepíše.
bool stage(const std::string& image, const std::string& folder, const std::string& host_root,
           const std::string& program, bool autorun, Staged& out, std::string& err);

/// Po sezení: smaže autoexec.bas debuggeru a vrátí odložený autoexec uživatele.
bool finish(const std::string& image, std::string& err);

/// Co sync_back() udělal (cesty relativní ke složce).
struct Synced {
    std::vector<std::string> copied;     ///< nové nebo změněné na kartě → zkopírované do `host_root`
    std::vector<std::string> missing;    ///< jsou v `host_root`, na kartě chybějí (nic se nemaže)
};

/// Soubory ze složky `folder` na kartě, které program vytvořil nebo změnil, zkopíruje do
/// `host_root`. Program sám (`program_on_card`, pokud neleží v `host_root`) se nevrací.
bool sync_back(const std::string& image, const std::string& folder, const std::string& host_root,
               const std::string& program_on_card, Synced& out, std::string& err);

/// Smaže celý strom `folder` na kartě (i složku samotnou). Neexistující složka není chyba.
bool clean(const std::string& image, const std::string& folder, std::string& err);

/// autoexec.bas (+3DOS hlavička, BASIC s autostartem na prvním řádku): první řádek REM se
/// značkou debuggeru, pak `lines` jako příkazy (řádky 10, 20, …). Tečkové příkazy se ukládají
/// jako text, jak je uloží editor NextBASICu. Kvůli testům veřejné.
std::vector<uint8_t> make_autoexec(const std::vector<std::string>& lines);

/// Je `bas` autoexec, který zapsal debugger (podle značky v REM)?
bool is_our_autoexec(const std::vector<uint8_t>& bas);

}  // namespace card
