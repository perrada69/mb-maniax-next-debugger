// MB Maniax Next Debugger – pracovní karta NextZXOS. Viz card.h.

#include "card.h"

#include "core/fatfs_diskio.h"
#include "core/sdcard_provisioner.h"
#include "third_party/fatfs/ff.h"

#include <cstdio>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <system_error>

namespace fs = std::filesystem;

namespace card {
namespace {

constexpr const char* kAutoexec = "0:/NEXTZXOS/AUTOEXEC.BAS";
constexpr const char* kBackup = "0:/NEXTZXOS/AUTOEXEC.MBX";
/// Značka v prvním řádku REM autoexecu, který zapsal debugger.
constexpr const char* kMark = "mbx-next-debugger";

const char* fr_text(FRESULT r) {
    switch (r) {
        case FR_OK: return "ok";
        case FR_DISK_ERR: return "disk error";
        case FR_NO_FILE: return "no such file";
        case FR_NO_PATH: return "no such folder";
        case FR_INVALID_NAME: return "invalid name";
        case FR_DENIED: return "access denied or card full";
        case FR_EXIST: return "already exists";
        case FR_WRITE_PROTECTED: return "write protected";
        case FR_NO_FILESYSTEM: return "no FAT32 filesystem";
        default: return "FatFs error";
    }
}

/// Obraz připojený jako jednotka 0: FatFs po dobu života objektu (jako MountedCard v
/// sdcard_file_add.cpp). Při zániku zapíše mezipaměti FatFs a odpojí soubor.
struct Mounted {
    FATFS fsys{};
    bool attached = false;
    bool mounted = false;

    bool mount(const std::string& image, std::string& err) {
        uint8_t mbr[512] = {};
        {
            std::ifstream f(fs::u8path(image), std::ios::binary);
            if (!f.read(reinterpret_cast<char*>(mbr), sizeof mbr)) {
                err = "cannot read the SD card image " + image;
                return false;
            }
        }
        // První oddíl FAT32 (typ 0x0B / 0x0C) v MBR.
        uint32_t lba = 0, count = 0;
        for (int i = 0; i < 4; ++i) {
            const uint8_t* e = mbr + 446 + 16 * i;
            if (e[4] != 0x0B && e[4] != 0x0C) continue;
            lba = e[8] | e[9] << 8 | e[10] << 16 | static_cast<uint32_t>(e[11]) << 24;
            count = e[12] | e[13] << 8 | e[14] << 16 | static_cast<uint32_t>(e[15]) << 24;
            break;
        }
        if (!lba || !count) {
            err = "the SD card image has no FAT32 partition: " + image;
            return false;
        }
        std::string gerr;
        if (!fatfs_glue::attach(0, image, lba, count, gerr)) {
            err = "cannot open the SD card image " + image + " (" + gerr + ")";
            return false;
        }
        attached = true;
        const FRESULT r = f_mount(&fsys, "0:", 1);
        if (r != FR_OK) {
            err = std::string("cannot mount the SD card image (") + fr_text(r) + ")";
            return false;
        }
        mounted = true;
        return true;
    }

    ~Mounted() {
        if (mounted) f_mount(nullptr, "0:", 0);
        if (attached) fatfs_glue::detach(0);
    }
};

bool read_card_file(const std::string& path, std::vector<uint8_t>& out) {
    FIL f;
    if (f_open(&f, path.c_str(), FA_READ) != FR_OK) return false;
    out.resize(static_cast<std::size_t>(f_size(&f)));
    UINT got = 0;
    const FRESULT r = out.empty() ? FR_OK : f_read(&f, out.data(), static_cast<UINT>(out.size()), &got);
    f_close(&f);
    return r == FR_OK && got == out.size();
}

bool write_card_file(const std::string& path, const std::vector<uint8_t>& data, std::string& err) {
    FIL f;
    FRESULT r = f_open(&f, path.c_str(), FA_WRITE | FA_CREATE_ALWAYS);
    if (r != FR_OK) {
        err = "cannot create " + path.substr(2) + " on the card (" + fr_text(r) + ")";
        return false;
    }
    UINT put = 0;
    r = data.empty() ? FR_OK : f_write(&f, data.data(), static_cast<UINT>(data.size()), &put);
    const FRESULT c = f_close(&f);
    if (r != FR_OK || c != FR_OK || put != data.size()) {
        f_unlink(path.c_str());
        err = "cannot write " + path.substr(2) + " on the card (card full?)";
        return false;
    }
    return true;
}

/// Složky cesty `dir` ("0:/A/B") na kartě, které chybějí.
bool make_dirs(const std::string& dir, std::string& err) {
    for (std::size_t i = 3; i <= dir.size(); ++i) {
        if (i < dir.size() && dir[i] != '/') continue;
        const std::string part = dir.substr(0, i);
        FILINFO fi;
        if (f_stat(part.c_str(), &fi) == FR_OK) {
            if (!(fi.fattrib & AM_DIR)) {
                err = part.substr(2) + " on the card is a file, not a folder";
                return false;
            }
            continue;
        }
        const FRESULT r = f_mkdir(part.c_str());
        if (r != FR_OK) {
            err = "cannot create the folder " + part.substr(2) + " on the card (" + fr_text(r) + ")";
            return false;
        }
    }
    return true;
}

/// Jméno, které jde na kartu zapsat beze změny: tisknutelné ASCII bez znaků, které FAT
/// nedovolí (FatFs je na desktopu v kódové stránce 437, jiné znaky by se změnily).
bool fat_name_ok(const std::string& n) {
    if (n.empty() || n == "." || n == ".." || n.size() > 255) return false;
    for (unsigned char c : n)
        if (c < 0x20 || c > 0x7E || std::strchr("\"*:<>?\\|", c)) return false;
    return n.back() != '.' && n.back() != ' ';
}

bool host_read(const fs::path& p, std::vector<uint8_t>& out) {
    std::ifstream f(p, std::ios::binary);
    if (!f) return false;
    out.assign(std::istreambuf_iterator<char>(f), std::istreambuf_iterator<char>());
    return !f.bad();
}

/// Položky složky `root` na kartě rekurzivně (cesta relativně k `root`, je složka). Nejdřív
/// celý výpis, pak teprve cokoli dalšího: soubor otevřený během f_readdir posune výpis
/// zpátky (FatFs sdílí okno sektoru) a průchod se zacyklí.
void list_card(const std::string& root, const std::string& rel,
               std::vector<std::pair<std::string, bool>>& out) {
    DIR d;
    const std::string here = rel.empty() ? root : root + "/" + rel;
    if (f_opendir(&d, here.c_str()) != FR_OK) return;
    std::vector<std::pair<std::string, bool>> mine;
    FILINFO fi;
    // Konec výpisu je prázdné jméno, ale FatFs R0.15b ho na konci nezapíše (get_fileinfo skončí
    // dřív) – bez vynulování by se poslední položka vracela pořád dokola.
    while ((fi.fname[0] = 0, f_readdir(&d, &fi)) == FR_OK && fi.fname[0]) {
        const std::string name = fi.fname;
        if (name == "." || name == "..") continue;
        mine.emplace_back(rel.empty() ? name : rel + "/" + name, (fi.fattrib & AM_DIR) != 0);
    }
    f_closedir(&d);
    for (const auto& e : mine) {
        out.push_back(e);
        if (e.second) list_card(root, e.first, out);
    }
}

/// Smaže strom `path` na kartě (nejdřív obsah, pak složku). Soubor s atributem jen pro čtení
/// FatFs smazat odmítne; ohlásí se jako chyba.
bool remove_tree(const std::string& path, std::string& err) {
    FILINFO fi;
    if (f_stat(path.c_str(), &fi) != FR_OK) return true;
    if (fi.fattrib & AM_DIR) {
        std::vector<std::string> kids;
        DIR d;
        if (f_opendir(&d, path.c_str()) == FR_OK) {
            FILINFO k;
            while ((k.fname[0] = 0, f_readdir(&d, &k)) == FR_OK && k.fname[0]) {   // viz list_card
                const std::string n = k.fname;
                if (n != "." && n != "..") kids.push_back(path + "/" + n);
            }
            f_closedir(&d);
        }
        for (const auto& k : kids)
            if (!remove_tree(k, err)) return false;
    }
    const FRESULT r = f_unlink(path.c_str());
    if (r != FR_OK) {
        err = "cannot delete " + path.substr(2) + " on the card (" + fr_text(r) + ")";
        return false;
    }
    return true;
}

}  // namespace

bool prepare_from_zip(const std::string& zip, const std::string& out_image, std::string& err) {
    const std::string tmp = out_image + ".part";
    std::error_code ec;
    fs::remove(fs::u8path(tmp), ec);
    if (!sdcard::unzip_entry(zip, sdcard::kImageFileName, tmp, err)) {
        fs::remove(fs::u8path(tmp), ec);
        return false;
    }
    if (!sdcard::patch_image_fat32(tmp, err)) {
        fs::remove(fs::u8path(tmp), ec);
        return false;
    }
    {
        // Uvítací program běží při každém bootu čerstvé karty dřív než autoexec.bas a čeká na
        // klávesu. Vypnout ho tak, jak to udělá jeho volba „D=Disable welcome“ (změřeno na kartě
        // po jejím stisku: AUTOEXEC.1ST přejmenovaný na welcome.bas).
        Mounted m;
        if (!m.mount(tmp, err)) {
            fs::remove(fs::u8path(tmp), ec);
            return false;
        }
        FILINFO fi;
        if (f_stat("0:/NEXTZXOS/AUTOEXEC.1ST", &fi) == FR_OK && f_stat("0:/NEXTZXOS/welcome.bas", &fi) != FR_OK)
            f_rename("0:/NEXTZXOS/AUTOEXEC.1ST", "0:/NEXTZXOS/welcome.bas");
    }
    fs::remove(fs::u8path(out_image), ec);
    fs::rename(fs::u8path(tmp), fs::u8path(out_image), ec);
    if (ec) {
        err = "cannot save " + out_image + ": " + ec.message();
        return false;
    }
    return true;
}

bool normalize_folder(const std::string& folder, std::string& out, std::string& err) {
    std::string s = folder;
    for (char& c : s)
        if (c == '\\') c = '/';
    if (s.size() >= 2 && s[1] == ':') s = s.substr(2);   // "c:/MBX" → "/MBX"
    out.clear();
    std::size_t i = 0;
    while (i <= s.size()) {
        const std::size_t j = s.find('/', i);
        const std::string part = s.substr(i, j == std::string::npos ? std::string::npos : j - i);
        i = j == std::string::npos ? s.size() + 1 : j + 1;
        if (part.empty()) continue;
        if (!fat_name_ok(part)) {
            err = "the card folder \"" + folder + "\" has a name the card cannot hold: \"" + part + "\"";
            return false;
        }
        out += "/" + part;
    }
    if (out.empty()) {
        err = "the card folder must not be the root of the card";
        return false;
    }
    return true;
}

std::vector<uint8_t> make_autoexec(const std::vector<std::string>& lines) {
    std::vector<uint8_t> body;
    auto line = [&](uint16_t number, const std::vector<uint8_t>& text) {
        body.push_back(static_cast<uint8_t>(number >> 8));   // číslo řádku big-endian
        body.push_back(static_cast<uint8_t>(number));
        const std::size_t len = text.size() + 1;              // délka little-endian, s 0x0D
        body.push_back(static_cast<uint8_t>(len));
        body.push_back(static_cast<uint8_t>(len >> 8));
        body.insert(body.end(), text.begin(), text.end());
        body.push_back(0x0D);
    };
    std::vector<uint8_t> rem = {0xEA};                        // REM
    rem.insert(rem.end(), kMark, kMark + std::strlen(kMark));
    line(1, rem);
    uint16_t n = 10;
    for (const auto& l : lines) {
        line(n, std::vector<uint8_t>(l.begin(), l.end()));
        n = static_cast<uint16_t>(n + 10);
    }
    // +3DOS hlavička (128 B): PLUS3DOS, 1A, issue 1, verze 0, délka souboru, typ 0 = BASIC,
    // délka programu, autostart, začátek proměnných (= konec programu), součet bajtů 0..126.
    std::vector<uint8_t> h(128, 0);
    std::memcpy(h.data(), "PLUS3DOS", 8);
    h[8] = 0x1A;
    h[9] = 1;
    const uint32_t total = static_cast<uint32_t>(128 + body.size());
    for (int i = 0; i < 4; ++i) h[11 + i] = static_cast<uint8_t>(total >> (8 * i));
    h[15] = 0;
    h[16] = static_cast<uint8_t>(body.size());
    h[17] = static_cast<uint8_t>(body.size() >> 8);
    h[18] = 1;   // autostart: řádek 1
    h[19] = 0;
    h[20] = h[16];
    h[21] = h[17];
    unsigned sum = 0;
    for (int i = 0; i < 127; ++i) sum += h[i];
    h[127] = static_cast<uint8_t>(sum);
    h.insert(h.end(), body.begin(), body.end());
    return h;
}

bool is_our_autoexec(const std::vector<uint8_t>& bas) {
    const std::size_t n = std::strlen(kMark);
    // 128 B hlavička, pak řádek 1: číslo (2), délka (2), REM, značka.
    return bas.size() >= 128 + 5 + n && bas[128 + 4] == 0xEA &&
           std::memcmp(bas.data() + 128 + 5, kMark, n) == 0;
}

bool stage(const std::string& image, const std::string& folder, const std::string& host_root,
           const std::string& program, bool autorun, Staged& out, std::string& err) {
    std::string dir;
    if (!normalize_folder(folder, dir, err)) return false;
    Mounted m;
    if (!m.mount(image, err)) return false;
    const std::string root = "0:" + dir;
    if (!make_dirs(root, err)) return false;
    out = Staged{};

    // Obsah složky programu (bez skrytých položek a symbolických odkazů: .git a podobné na kartu
    // nepatří) a program.
    const fs::path hroot = host_root.empty() ? fs::path() : fs::u8path(host_root);
    const fs::path prog = fs::u8path(program);
    std::error_code ec;
    std::string prog_rel;
    if (!hroot.empty()) {
        if (!fs::is_directory(hroot, ec)) {
            err = "the folder " + host_root + " does not exist";
            return false;
        }
        const fs::path rel = fs::weakly_canonical(prog, ec).lexically_relative(fs::weakly_canonical(hroot, ec));
        if (!rel.empty() && *rel.begin() != "..") prog_rel = rel.generic_u8string();
        for (fs::recursive_directory_iterator it(hroot, fs::directory_options::none, ec), end;
             !ec && it != end; it.increment(ec)) {
            const std::string name = it->path().filename().u8string();
            if (it->is_symlink() || name.empty() || name[0] == '.') {
                if (it->is_directory()) it.disable_recursion_pending();
                continue;
            }
            const std::string rel_name = it->path().lexically_relative(hroot).generic_u8string();
            bool ok = true;
            for (const auto& part : fs::path(rel_name)) ok = ok && fat_name_ok(part.u8string());
            if (!ok) {
                err = "the name \"" + rel_name + "\" cannot be stored on the card (only ASCII names "
                      "without \" * : < > ? \\ | are possible)";
                return false;
            }
            if (it->is_directory()) {
                if (!make_dirs(root + "/" + rel_name, err)) return false;
            } else if (it->is_regular_file()) {
                std::vector<uint8_t> data;
                if (!host_read(it->path(), data)) {
                    err = "cannot read " + it->path().u8string();
                    return false;
                }
                if (!write_card_file(root + "/" + rel_name, data, err)) return false;
                ++out.files;
            }
        }
        if (ec) {
            err = "cannot list " + host_root + ": " + ec.message();
            return false;
        }
    }
    if (prog_rel.empty()) {
        prog_rel = prog.filename().u8string();
        if (!fat_name_ok(prog_rel)) {
            err = "the program name \"" + prog_rel + "\" cannot be stored on the card";
            return false;
        }
        std::vector<uint8_t> data;
        if (!host_read(prog, data)) {
            err = "cannot read " + program;
            return false;
        }
        if (!write_card_file(root + "/" + prog_rel, data, err)) return false;
        ++out.files;
    }
    out.program_on_card = dir + "/" + prog_rel;

    // Autoexec: uživatelův se odloží (jen pokud už odložený není – ten po pádu nepřepsat).
    std::vector<uint8_t> cur;
    FILINFO fi;
    if (read_card_file(kAutoexec, cur) && !is_our_autoexec(cur) && f_stat(kBackup, &fi) != FR_OK) {
        const FRESULT r = f_rename(kAutoexec, kBackup);
        if (r != FR_OK) {
            err = std::string("cannot set aside the card's own autoexec.bas (") + fr_text(r) + ")";
            return false;
        }
    }
    auto quoted = [](const std::string& s) {
        return s.find(' ') == std::string::npos ? s : "\"" + s + "\"";
    };
    // Bez písmene jednotky: ':' v řádku BASICu odděluje příkazy, ".cd c:/MBX" by dostal jen "c"
    // (změřeno: ".cd c:/MBXA" ani ".nexload c:/MBXA/HELLO.NEX" program nespustí, bez "c:" ano).
    std::vector<std::string> lines = {".cd " + quoted(dir)};
    lines.push_back(autorun ? ".nexload " + quoted(prog_rel) : std::string(".browse"));
    return write_card_file(kAutoexec, make_autoexec(lines), err);
}

bool finish(const std::string& image, std::string& err) {
    Mounted m;
    if (!m.mount(image, err)) return false;
    std::vector<uint8_t> cur;
    if (read_card_file(kAutoexec, cur) && is_our_autoexec(cur)) {
        const FRESULT r = f_unlink(kAutoexec);
        if (r != FR_OK) {
            err = std::string("cannot remove the debugger's autoexec.bas (") + fr_text(r) + ")";
            return false;
        }
    }
    FILINFO fi;
    if (f_stat(kBackup, &fi) == FR_OK && f_stat(kAutoexec, &fi) != FR_OK) {
        const FRESULT r = f_rename(kBackup, kAutoexec);
        if (r != FR_OK) {
            err = std::string("cannot restore the card's own autoexec.bas (") + fr_text(r) + ")";
            return false;
        }
    }
    return true;
}

bool sync_back(const std::string& image, const std::string& folder, const std::string& host_root,
               const std::string& program_on_card, Synced& out, std::string& err) {
    std::string dir;
    if (!normalize_folder(folder, dir, err)) return false;
    Mounted m;
    if (!m.mount(image, err)) return false;
    out = Synced{};
    const std::string root = "0:" + dir;
    const fs::path hroot = fs::u8path(host_root);
    const std::string skip = program_on_card.size() > dir.size() + 1 ? program_on_card.substr(dir.size() + 1) : "";
    bool skip_program = true;
    {
        std::error_code ec;
        skip_program = !fs::exists(hroot / fs::u8path(skip), ec);   // program mimo složku se nevrací
    }
    std::vector<std::pair<std::string, bool>> entries;
    list_card(root, "", entries);
    std::vector<std::string> on_card;
    for (const auto& [rel, is_dir] : entries) {
        on_card.push_back(rel);
        if (is_dir || (skip_program && rel == skip)) continue;
        std::vector<uint8_t> data, host;
        if (!read_card_file(root + "/" + rel, data)) {
            err = "cannot read " + dir.substr(1) + "/" + rel + " on the card";
            return false;
        }
        const fs::path dst = hroot / fs::u8path(rel);
        if (host_read(dst, host) && host == data) continue;
        std::error_code ec;
        fs::create_directories(dst.parent_path(), ec);
        std::ofstream f(dst, std::ios::binary | std::ios::trunc);
        f.write(reinterpret_cast<const char*>(data.data()), static_cast<std::streamsize>(data.size()));
        if (!f) {
            err = "cannot write " + dst.u8string();
            return false;
        }
        out.copied.push_back(rel);
    }
    std::error_code ec;
    for (fs::recursive_directory_iterator it(hroot, fs::directory_options::none, ec), end;
         !ec && it != end; it.increment(ec)) {
        const std::string name = it->path().filename().u8string();
        if (it->is_symlink() || name.empty() || name[0] == '.') {
            if (it->is_directory()) it.disable_recursion_pending();
            continue;
        }
        if (!it->is_regular_file()) continue;
        const std::string rel = it->path().lexically_relative(hroot).generic_u8string();
        bool found = false;
        for (const auto& c : on_card) {
            if (c.size() != rel.size()) continue;
            bool same = true;   // FAT nerozlišuje velikost písmen
            for (std::size_t i = 0; i < c.size() && same; ++i)
                same = std::tolower(static_cast<unsigned char>(c[i])) == std::tolower(static_cast<unsigned char>(rel[i]));
            if (same) { found = true; break; }
        }
        if (!found) out.missing.push_back(rel);
    }
    return true;
}

bool clean(const std::string& image, const std::string& folder, std::string& err) {
    std::string dir;
    if (!normalize_folder(folder, dir, err)) return false;
    Mounted m;
    if (!m.mount(image, err)) return false;
    return remove_tree("0:" + dir, err);
}

}  // namespace card
