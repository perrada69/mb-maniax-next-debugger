// MB Maniax Next Debugger – ladicí server: jádro JNEXT bez okna, ovládané rozšířením VS Code.
//
// Rozšíření server spouští jako podproces a mluví s ním přes stdin/stdout. Zprávy jdou v rámcích
// [u32 délka][u8 typ][data], délka = 1 + délka dat, little endian:
//   1 JSON  – příkazy rozšíření, odpovědi a události serveru (popis v docs/protocol.md)
//   2 obraz – u16 šířka, u16 výška, pixely RGBA (server → rozšíření, jen když se obraz změnil)
//   3 zvuk  – vzorky int16, stereo, 44,1 kHz (server → rozšíření)
// Výpisy JNEXT jdou na stderr.
//
// Ladění obstarává backend JNEXT (jnext::dbg::Debugger): server je jeho klient – služba
// (příkazy se vyřizují v pump()) a posluchač (zastavení, reset, výpisy). Podmínky breakpointů
// překládá jazyk výrazů JNEXT (script/expr_compiler.h) a vyhodnocuje je přímo emulátor, takže
// podmíněný breakpoint nezpomaluje víc než obyčejný.
//
// Copyright (C) 2026 MB Maniax. Licence GNU GPL 3 nebo novější (stejně jako JNEXT).

#include "card.h"
#include "esp_tap.h"
#include "audio/mixer.h"
#include "core/emulator.h"
#include "core/emulator_config.h"
#include "core/log.h"
#include "core/nex_loader.h"
#include "core/saveable.h"
#include "debug/debugger.h"
#include "esp01/esp_socket.h"
#include "peripheral/esp_host_policy.h"
#include "peripheral/uart.h"
#include "platform/emulator_boot.h"
#include "script/expr_compiler.h"
#include "third_party/nlohmann-json/nlohmann/json.hpp"
#include "video/renderer.h"

#include <spdlog/sinks/stdout_sinks.h>

#ifdef _WIN32
#  include <fcntl.h>
#  include <io.h>
#  include <windows.h>
#  include <timeapi.h>
#endif

#include <algorithm>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <deque>
#include <filesystem>
#include <fstream>
#include <functional>
#include <map>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

using json = nlohmann::json;
namespace dbg = jnext::dbg;

namespace {

constexpr int kVersion = 1;
constexpr uint8_t kJson = 1, kVideo = 2, kAudio = 3;

// ------------------------------------------------------------------ přenos

std::mutex g_out_mutex;

void write_frame(uint8_t type, const void* data, size_t n) {
    std::lock_guard<std::mutex> lock(g_out_mutex);
    const uint32_t len = static_cast<uint32_t>(n + 1);
    uint8_t head[5] = {static_cast<uint8_t>(len), static_cast<uint8_t>(len >> 8), static_cast<uint8_t>(len >> 16),
                       static_cast<uint8_t>(len >> 24), type};
    std::fwrite(head, 1, sizeof head, stdout);
    if (n) std::fwrite(data, 1, n, stdout);
    std::fflush(stdout);
}

void send(const json& j) {
    const std::string s = j.dump(-1, ' ', false, json::error_handler_t::replace);
    write_frame(kJson, s.data(), s.size());
}

/// Příkazy z stdin (čte je vlastní vlákno, vyřizují se v pump() hlavního vlákna).
class Inbox {
public:
    void push(json j) {
        {
            std::lock_guard<std::mutex> lock(m_);
            q_.push_back(std::move(j));
        }
        cv_.notify_all();
    }

    bool pop(json& out, int wait_ms) {
        std::unique_lock<std::mutex> lock(m_);
        if (q_.empty() && wait_ms > 0) cv_.wait_for(lock, std::chrono::milliseconds(wait_ms), [this] { return !q_.empty(); });
        if (q_.empty()) return false;
        out = std::move(q_.front());
        q_.pop_front();
        return true;
    }

    bool empty() {
        std::lock_guard<std::mutex> lock(m_);
        return q_.empty();
    }

private:
    std::mutex m_;
    std::condition_variable cv_;
    std::deque<json> q_;
};

void read_loop(Inbox& inbox) {
    std::vector<uint8_t> buf;
    for (;;) {
        uint8_t head[5];
        if (std::fread(head, 1, 5, stdin) != 5) break;
        const uint32_t len = head[0] | (head[1] << 8) | (head[2] << 16) | (static_cast<uint32_t>(head[3]) << 24);
        if (len == 0 || len > (64u << 20)) break;
        buf.resize(len - 1);
        if (len > 1 && std::fread(buf.data(), 1, buf.size(), stdin) != buf.size()) break;
        if (head[4] != kJson) continue;
        try {
            inbox.push(json::parse(buf.begin(), buf.end()));
        } catch (const std::exception& e) {
            std::fprintf(stderr, "mbx: bad JSON: %s\n", e.what());
        }
    }
    inbox.push(json{{"cmd", "quit"}});      // rozšíření skončilo
}

// ------------------------------------------------------------------ pomůcky

std::string base64(const uint8_t* p, size_t n) {
    static const char* t = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    std::string out;
    out.reserve((n + 2) / 3 * 4);
    for (size_t i = 0; i < n; i += 3) {
        const uint32_t v = (p[i] << 16) | (i + 1 < n ? p[i + 1] << 8 : 0) | (i + 2 < n ? p[i + 2] : 0);
        out += t[(v >> 18) & 63];
        out += t[(v >> 12) & 63];
        out += i + 1 < n ? t[(v >> 6) & 63] : '=';
        out += i + 2 < n ? t[v & 63] : '=';
    }
    return out;
}

std::vector<uint8_t> unbase64(const std::string& s) {
    std::vector<uint8_t> out;
    uint32_t v = 0;
    int bits = 0;
    for (char c : s) {
        int d;
        if (c >= 'A' && c <= 'Z') d = c - 'A';
        else if (c >= 'a' && c <= 'z') d = c - 'a' + 26;
        else if (c >= '0' && c <= '9') d = c - '0' + 52;
        else if (c == '+') d = 62;
        else if (c == '/') d = 63;
        else continue;
        v = (v << 6) | static_cast<uint32_t>(d);
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            out.push_back(static_cast<uint8_t>(v >> bits));
        }
    }
    return out;
}

/// Výpisy JNEXT (spdlog) jdou na stderr a rozšíření je ukazuje v Debug Console. Filtr (nastaví
/// ho Server) dostane každou zprávu a vrátí true, když ji spolkl (šum, nebo ji poslal sám jako
/// hlášku s `key`); ostatní jdou na stderr beze změny.
std::function<bool(const std::string&)> g_log_filter;

class FilterSink : public spdlog::sinks::sink {
public:
    explicit FilterSink(std::shared_ptr<spdlog::sinks::sink> inner) : inner_(std::move(inner)) {}
    void log(const spdlog::details::log_msg& msg) override {
        if (g_log_filter && g_log_filter(std::string(msg.payload.data(), msg.payload.size()))) return;
        inner_->log(msg);
    }
    void flush() override { inner_->flush(); }
    void set_pattern(const std::string& p) override { inner_->set_pattern(p); }
    void set_formatter(std::unique_ptr<spdlog::formatter> f) override { inner_->set_formatter(std::move(f)); }

private:
    std::shared_ptr<spdlog::sinks::sink> inner_;
};

const char* reason_name(dbg::PauseReason::Kind k) {
    switch (k) {
        case dbg::PauseReason::Kind::User: return "pause";
        case dbg::PauseReason::Kind::Breakpoint: return "breakpoint";
        case dbg::PauseReason::Kind::Watch: return "data breakpoint";
        case dbg::PauseReason::Kind::Step: return "step";
        case dbg::PauseReason::Kind::RunTo: return "goto";
        case dbg::PauseReason::Kind::Magic: return "magic";
        case dbg::PauseReason::Kind::Script: return "breakpoint";
        case dbg::PauseReason::Kind::Corrupt: return "exception";
        default: return "pause";
    }
}

struct RegName {
    const char* name;
    dbg::RegId id;
};
const RegName kRegs[] = {
    {"AF", dbg::RegId::AF}, {"BC", dbg::RegId::BC}, {"DE", dbg::RegId::DE}, {"HL", dbg::RegId::HL},
    {"AF'", dbg::RegId::AF2}, {"BC'", dbg::RegId::BC2}, {"DE'", dbg::RegId::DE2}, {"HL'", dbg::RegId::HL2},
    {"IX", dbg::RegId::IX}, {"IY", dbg::RegId::IY}, {"SP", dbg::RegId::SP}, {"PC", dbg::RegId::PC},
    {"A", dbg::RegId::A}, {"F", dbg::RegId::F}, {"B", dbg::RegId::B}, {"C", dbg::RegId::C},
    {"D", dbg::RegId::D}, {"E", dbg::RegId::E}, {"H", dbg::RegId::H}, {"L", dbg::RegId::L},
    {"IXH", dbg::RegId::IXH}, {"IXL", dbg::RegId::IXL}, {"IYH", dbg::RegId::IYH}, {"IYL", dbg::RegId::IYL},
    {"I", dbg::RegId::I}, {"R", dbg::RegId::R}, {"IFF1", dbg::RegId::IFF1}, {"IFF2", dbg::RegId::IFF2},
    {"IM", dbg::RegId::IM},
};

/// Podmínka počtu průchodů z VS Code: "5" / "==5", ">=5", ">5", "%5" (každý pátý).
bool hit_matches(const std::string& cond, uint64_t hits) {
    std::string s;
    for (char c : cond) if (c != ' ') s += c;
    if (s.empty()) return true;
    auto num = [&](size_t from) { return std::strtoull(s.c_str() + from, nullptr, 10); };
    if (s.rfind(">=", 0) == 0) return hits >= num(2);
    if (s.rfind("<=", 0) == 0) return hits <= num(2);
    if (s.rfind("==", 0) == 0) return hits == num(2);
    if (s[0] == '>') return hits > num(1);
    if (s[0] == '<') return hits < num(1);
    if (s[0] == '%') { const uint64_t n = num(1); return n && hits % n == 0; }
    if (s[0] == '=') return hits == num(1);
    return hits == num(0);
}

// ------------------------------------------------------------------ server

class Server : public dbg::Service, public dbg::Listener {
public:
    Server(Emulator& emu, dbg::Debugger& d, Inbox& inbox) : emu_(emu), dbg_(d), inbox_(inbox) {}
    ~Server() { g_log_filter = nullptr; }   // Emulator a backend končí až po serveru a ještě vypisují

    bool start() {
        const auto a = dbg_.attach(dbg::ClientInfo{"MB Maniax Next Debugger", dbg::ClientKind::Dzrp});
        if (!a) return false;
        cid_ = a.value;
        dbg_.set_listener(cid_, this);
        dbg_.add_service(*this);
        dbg_.set_call_stack_enabled(true);
        g_log_filter = [this](const std::string& text) { return filter_log(text); };
        return true;
    }

    bool running() const { return running_; }

    /// Jeden průchod smyčky: snímek (když stroj běží), služby, obraz a zvuk.
    void tick() {
        if (dbg_.state().paused) {
            dbg_.pump(dbg::PumpBudget{});
            flush_screen();
            wait_for_input(20);
            frame_due_ = std::chrono::steady_clock::now();
            return;
        }
        if (load_countdown_ == 0) {
            const std::string p = program_;
            load_countdown_ = -1;
            if (dbg_.load(cid_, p) != dbg::Result::Ok) output("loadFailed", {p}, "Failed to load the program: " + p);
            enable_rewind();
            if (stop_on_entry_) {
                stop_reason_ = "entry";
                dbg_.pause(cid_);
                stop_on_entry_ = false;   // jen při launch, ne po resetu, který vyvolá program
            }
        } else if (load_countdown_ > 0) {
            --load_countdown_;
        }
        emu_.joystick().set_joy_left(joy_);
        emu_.run_frame();
        const std::string nex = emu_.take_nex_load_request();
        if (!nex.empty()) {
            program_ = nex;   // tvrdý reset pak nahraje tento program (jako aplikace pro Android)
            dbg_.load(cid_, nex);
        }
        if (emu_.take_hard_reset_request()) {
            dbg_.reset(cid_, dbg::ResetKind::Hard);
            // Tvrdý reset vyvolaný programem: bez SD karty by stroj neměl co spustit (není NextZXOS) –
            // program se nahraje znovu, stejně jako v aplikaci pro Android (jnext_android.cpp).
            if (!program_.empty() && boot_cfg_.sd_card_image.empty()) load_countdown_ = emulator_load_delay_frames(program_);
        }
        dbg_.pump(dbg::PumpBudget{});
        send_screen(false);
        pace(send_audio());
    }

    // ---- dbg::Service

    dbg::ServiceStep service_once(int wait_ms) override {
        json cmd;
        if (!inbox_.pop(cmd, std::min(wait_ms, 50))) return dbg::ServiceStep::Idle;
        handle(cmd);
        return dbg::ServiceStep::Serviced;
    }

    void flush_notifications() override {}
    bool peer_connected() const override { return true; }

    // ---- dbg::Listener

    void on_paused(const dbg::PausedInfo& info) override {
        if (entry_hit_) {
            // Program spuštěný z NextZXOS dorazil na svou první instrukci: zastavení „entry“,
            // rozšíření pak pošle breakpointy (ty by dřív zastavovaly v kódu NextZXOS).
            entry_hit_ = false;
            disarm_entry();
            stop_reason_ = "entry";
        }
        json ids = json::array();
        for (const auto& h : info.matched) {
            auto it = by_event_.find(h.event_id);
            if (it == by_event_.end()) continue;
            auto bp = bps_.find(it->second);
            if (bp != bps_.end() && bp->second->ev == h.event_id) ids.push_back(it->second);
            auto wp = wps_.find(it->second);
            if (wp != wps_.end() && wp->second->ev == h.event_id) ids.push_back(it->second);
        }
        // Watchpoint: který (id) a kde se k paměti přistoupilo (addr), i když matched chybí.
        if (info.reason.kind == dbg::PauseReason::Kind::Watch) {
            auto it = by_event_.find(info.reason.id);
            if (it != by_event_.end() && wps_.count(it->second) && std::find(ids.begin(), ids.end(), it->second) == ids.end())
                ids.push_back(it->second);
        }
        // Zastavení, které vyvolal server sám (vstup programu, obnovení stavu za běhu), hlásí svůj důvod.
        std::string reason = stop_reason_.empty() ? reason_name(info.reason.kind) : stop_reason_;
        stop_reason_.clear();
        // Breakpoint na událost stroje: reason "event" a druh v eventKind (popisek dá rozšíření).
        std::string event_kind;
        for (const auto& h : info.matched) {
            auto it = by_event_.find(h.event_id);
            if (it == by_event_.end()) continue;
            auto ev = evs_.find(it->second);
            if (ev != evs_.end() && ev->second->ev == h.event_id) event_kind = ev->second->kind;
        }
        json msg = {{"event", "stopped"}, {"reason", event_kind.empty() ? reason : std::string("event")}, {"pc", info.pc}, {"ids", ids}, {"text", info.reason.text}};
        if (!event_kind.empty()) msg["eventKind"] = event_kind;
        if ((event_kind == "espTx" || event_kind == "espRx") && !esp_stop_text_.empty()) msg["text"] = esp_stop_text_;   // řádek, který zastavil
        esp_stop_text_.clear();
        if (info.reason.kind == dbg::PauseReason::Kind::Watch) msg["addr"] = info.reason.addr;
        send(msg);
        screen_dirty_ = true;
    }

    void on_resumed(dbg::ClientId) override { send({{"event", "continued"}}); }
    void on_reset(dbg::ResetKind kind) override {
        send({{"event", "reset"}, {"hard", kind == dbg::ResetKind::Hard}});
    }
    void on_frame_ended(uint32_t) override {}
    void on_subscriptions_changed(dbg::EventKindMask) override {}
    void on_exit_requested(int code) override { send({{"event", "exited"}, {"code", code}}); }
    void on_log(dbg::LogLevel, const std::string& text) override {
        if (own_mutation(text)) return;
        output(text + "\n");
    }

private:
    struct Bp {
        int id = 0;
        dbg::EventId ev = dbg::EVENT_NONE;
        uint64_t hits = 0;
        std::string hit_condition;
        std::string log_message;
        std::string kind;   // u breakpointů na události: druh (port, nextreg, …)
    };

    /// Stav breakpointu espTx / espRx: skládaný řádek a vzor.
    struct EspMatch {
        bool rx = false;
        esptap::LineAssembler lines;
        esptap::Pattern pattern;
    };

    void output(const std::string& text) { send({{"event", "output"}, {"text", text}}); }

    /// Řádek backendu `MUTATE … by <klient>` o změně, kterou udělal tento server (reset, nahrání
    /// programu, zápis do paměti či registru z VS Code): uživatel ji vyvolal sám, v Debug Console
    /// je to šum. Selhání („FAILED“) a změny jiných klientů projdou.
    bool own_mutation(const std::string& text) const {
        if (text.rfind("MUTATE ", 0) != 0 || text.find("FAILED") != std::string::npos) return false;
        const std::string tail = " by " + std::to_string(cid_);
        return text.size() >= tail.size() && text.compare(text.size() - tail.size(), tail.size(), tail) == 0;
    }

    /// Výpisy JNEXT, které při ladění bez SD karty chodí při každém startu, resetu a nahrání:
    /// - „warm start: no SD image is mounted …“ – bez karty je to očekávaná konfigurace (ROM dává
    ///   server sám, install_rom), zahodí se;
    /// - „--esxdos-stub-writable: …“ – esxDOS ve složce programu se zápisem (nastavuje launch):
    ///   jednou za launch jako informace s `key` esxdosWritable, dál se zahazuje.
    /// Vše ostatní (skutečné chyby) jde na stderr jako dřív.
    bool filter_log(const std::string& text) {
        if (text.rfind("warm start: no SD image is mounted", 0) == 0) return true;
        if (text.rfind("--esxdos-stub-writable:", 0) == 0) {
            if (!esxdos_reported_) {
                esxdos_reported_ = true;
                const std::string root = boot_cfg_.esxdos_stub_root;
                output("esxdosWritable", {root},
                       "esxDOS works in the folder " + root + " with write access: the program's writes "
                       "change files on disk immediately and Step Back cannot undo them.");
            }
            return true;
        }
        return false;
    }

    /// Hláška pro uživatele: anglický `text` (s koncem řádku) a k překladu v rozšíření `key`
    /// a `args` (docs/protocol.md, „Texty pro uživatele“).
    void output(const std::string& key, const std::vector<std::string>& args, const std::string& text) {
        send({{"event", "output"}, {"text", text + "\n"}, {"key", key}, {"args", args}});
    }

    void wait_for_input(int ms) {
        json cmd;
        if (inbox_.pop(cmd, ms)) {
            handle(cmd);
            while (inbox_.pop(cmd, 0)) handle(cmd);
        }
    }

    /// Tempo podle délky zvuku, který snímek vyrobil (snímek Nextu není přesně 20 ms; zvuk tak
    /// chodí stejně rychle, jak se přehrává); bez zvuku 50 snímků za sekundu. Mezitím se
    /// vyřizují příkazy.
    void pace(int samples) {
        using clock = std::chrono::steady_clock;
        frame_due_ += std::chrono::microseconds(samples > 0 ? samples * 1000000LL / Mixer::SAMPLE_RATE : 20000);
        auto now = clock::now();
        if (now > frame_due_ + std::chrono::milliseconds(100)) frame_due_ = now;   // nestíhá: nedohánět
        while (running_ && (now = clock::now()) < frame_due_) {
            const int ms = static_cast<int>(std::chrono::duration_cast<std::chrono::milliseconds>(frame_due_ - now).count());
            if (ms <= 0) break;
            json cmd;
            if (inbox_.pop(cmd, ms)) {
                handle(cmd);
                dbg_.pump(dbg::PumpBudget{});
                if (dbg_.state().paused) return;
            }
        }
    }

    void flush_screen() {
        if (screen_dirty_) send_screen(true);
    }

    void send_screen(bool force) {
        const int w = emu_.get_framebuffer_width();
        const int h = emu_.get_framebuffer_height();
        const uint32_t* fb = emu_.get_framebuffer();
        if (!fb || w <= 0 || h <= 0) return;
        const size_t n = static_cast<size_t>(w) * h;
        uint64_t hash = 1469598103934665603ull;
        for (size_t i = 0; i < n; ++i) {
            hash ^= fb[i];
            hash *= 1099511628211ull;
        }
        if (!force && hash == last_hash_) return;
        last_hash_ = hash;
        screen_dirty_ = false;
        video_.resize(4 + n * 4);
        video_[0] = static_cast<uint8_t>(w);
        video_[1] = static_cast<uint8_t>(w >> 8);
        video_[2] = static_cast<uint8_t>(h);
        video_[3] = static_cast<uint8_t>(h >> 8);
        uint8_t* o = video_.data() + 4;
        for (size_t i = 0; i < n; ++i) {
            const uint32_t p = fb[i];   // 0xAARRGGBB
            o[0] = static_cast<uint8_t>(p >> 16);
            o[1] = static_cast<uint8_t>(p >> 8);
            o[2] = static_cast<uint8_t>(p);
            o[3] = 0xFF;
            o += 4;
        }
        write_frame(kVideo, video_.data(), video_.size());
    }

    /// Vrací počet vyrobených vzorků (stereo párů).
    int send_audio() {
        Mixer& mixer = emu_.mixer();
        int avail = mixer.available();
        if (avail <= 0) return 0;
        audio_.resize(static_cast<size_t>(avail) * 2);
        const int n = mixer.read_samples(audio_.data(), avail);
        if (n > 0 && audio_on_) write_frame(kAudio, audio_.data(), static_cast<size_t>(n) * 4);
        return n;
    }

    // ---- příkazy

    void handle(const json& cmd) {
        const std::string name = cmd.value("cmd", "");
        json res = {{"ok", true}};
        try {
            if (name == "hello") res["version"] = kVersion;
            else if (name == "launch") launch(cmd, res);
            else if (name == "quit") {
                stop_profiler();   // jinak by ho destruktor Emulatoru zapsal do profile.dat
                json ignored;
                end_card(false, ignored);   // autoexec karty vrátit, i když endSession nepřišel
                running_ = false;
            }
            else if (name == "endSession") end_card(true, res);
            else if (name == "prepareSd") prepare_sd(cmd, res);
            else if (name == "cleanCard") clean_card(cmd, res);
            else if (name == "pause") check(dbg_.pause(cid_), res);
            else if (name == "continue") check(dbg_.run(cid_), res);
            else if (name == "stepIn") sync_step(dbg_.step_into(cid_), res);
            else if (name == "stepOver") maybe_sync_step(dbg_.step_over(cid_), res);
            else if (name == "stepOut") maybe_sync_step(dbg_.step_out(cid_), res);
            else if (name == "stepBack") check(dbg_.step_back(cid_, cmd.value("count", 1u)), res);   // zastavení přijde jako Paused
            else if (name == "runTo") check(dbg_.run_to(cid_, cmd.at("addr").get<uint16_t>()), res);
            else if (name == "runToEndOfFrame") check(dbg_.run_to_end_of_frame(cid_), res);
            else if (name == "reset") check(dbg_.reset(cid_, cmd.value("hard", true) ? dbg::ResetKind::Hard : dbg::ResetKind::Soft), res);
            else if (name == "state") state(res);
            else if (name == "registers") registers(res);
            else if (name == "setRegister") set_register(cmd, res);
            else if (name == "readMemory") read_memory(cmd, res);
            else if (name == "writeMemory") write_memory(cmd, res);
            else if (name == "disassemble") disassemble(cmd, res);
            else if (name == "callStack") call_stack(res);
            else if (name == "mmu") mmu(res);
            else if (name == "nextregs") nextregs(res);
            else if (name == "sprites") sprites(res);
            else if (name == "patternRam") pattern_ram(res);
            else if (name == "palettes") palettes(res);
            else if (name == "copper") copper(res);
            else if (name == "renderLayer") render_layer(cmd, res);
            else if (name == "raster") raster(res);
            else if (name == "soundState") sound_state(res);
            else if (name == "pageUsage") page_usage(res);
            else if (name == "evaluate") evaluate(cmd, res);
            else if (name == "loadSymbols") load_symbols(cmd, res);
            else if (name == "setBreakpoints") set_breakpoints(cmd, res);
            else if (name == "setWatchpoints") set_watchpoints(cmd, res);
            else if (name == "setEventBreakpoints") set_event_breakpoints(cmd, res);
            else if (name == "key") emu_.keyboard().set_key(static_cast<SDL_Scancode>(cmd.at("scancode").get<int>()), cmd.value("down", false));
            else if (name == "releaseKeys") { emu_.keyboard().release_all_keys(); joy_ = 0; }
            else if (name == "joy") joy_ = static_cast<uint16_t>(cmd.value("bits", 0) & 0x3F);
            else if (name == "mouse") mouse(cmd);
            else if (name == "audio") audio_on_ = cmd.value("on", true);
            else if (name == "screen") screen_dirty_ = true;
            else if (name == "stateSave") state_save(cmd, res);
            else if (name == "stateRestore") state_restore(cmd, res);
            else if (name == "stateList") res["names"] = dbg_.bookmarks(cid_);
            else if (name == "stateExport") state_export(cmd, res);
            else if (name == "stateImport") state_import(cmd, res);
            else if (name == "profilerStart") profiler_start(res);
            else if (name == "profilerStop") emu_.profiler().shutdown();
            else if (name == "profilerClear") profiler_clear(res);
            else if (name == "profilerState") res["active"] = emu_.profiler().active();
            else if (name == "profilerData") profiler_data(cmd, res);
            else if (name == "espLog") esp_log(cmd, res);
            else if (name == "espState") esp_state(res);
            else if (name == "espClear") tap_.clear();
            else {
                res["ok"] = false;
                res["error"] = "unknown command: " + name;
            }
        } catch (const std::exception& e) {
            res["ok"] = false;
            res["error"] = e.what();
        }
        if (cmd.contains("id")) {
            res["id"] = cmd["id"];
            send(res);
        }
    }

    /// Krok, který backend provede synchronně (bez události Paused): zastavení ohlásí server.
    void sync_step(dbg::Result r, json& res) {
        check(r, res);
        if (r != dbg::Result::Ok) return;
        // Krok přes instrukci BREAK zastaví magic breakpoint (stojí se za ní, stejně jako u kroku).
        const bool magic = dbg_.state().pause_reason.kind == dbg::PauseReason::Kind::Magic;
        send({{"event", "stopped"}, {"reason", magic ? "magic" : "step"}, {"pc", dbg_.registers().PC}, {"ids", json::array()}, {"text", ""}});
        screen_dirty_ = true;
    }

    /// Krok přes / ven: nad CALL běží stroj dál a zastavení přijde jako Paused; jinde je krok
    /// synchronní jako step_into a stroj už zase stojí.
    void maybe_sync_step(dbg::Result r, json& res) {
        if (r == dbg::Result::Ok && !dbg_.state().paused) return;
        sync_step(r, res);
    }

    static void check(dbg::Result r, json& res) {
        if (r != dbg::Result::Ok) {
            res["ok"] = false;
            res["error"] = dbg::result_name(r);
        }
    }

    void launch(const json& cmd, json& res) {
        EmulatorConfig cfg;
        cfg.nextzxos_like_direct_load = true;   // bez nahraného NextZXOS: registry jako po NextZXOS
        cfg.live_raster_render = true;
        cfg.sd_card_image = cmd.value("sdImage", "");
        program_ = cmd.value("program", "");
        MachineType type = MachineType::ZXN_ISSUE2;
        if (parse_machine_type(cmd.value("machine", "next"), type)) cfg.type = type;
        if (!esp_config(cmd, cfg, res)) return;
        json ignored;
        end_card(false, ignored);   // předchozí start do NextZXOS (restart sezení)
        if (cmd.value("boot", "") == "nextzxos") {
            // Start do NextZXOS: program a jeho složka na kartu, NextZXOS je spustí sám. esxDOS
            // obsluhuje NextZXOS, ne složka na disku.
            if (!start_card(cmd, cfg, res)) return;
        } else {
            if (!program_.empty() && cfg.sd_card_image.empty()) {
                // Bez karty vidí program přes esxDOS svou složku (data hry, uložené pozice).
                const auto slash = program_.find_last_of("/\\");
                cfg.esxdos_stub_root = slash == std::string::npos ? std::string(".") : program_.substr(0, slash);
                cfg.esxdos_stub_writable = true;
            }
            if (cmd.contains("esxdosRoot")) cfg.esxdos_stub_root = cmd["esxdosRoot"].get<std::string>();
        }
        if (cfg.esp_enabled) report_esp(cfg);
        magic_ = cmd.value("magicBreakpoint", true);
        esxdos_reported_ = false;   // informace o zápisu přes esxDOS jednou za launch
        cfg.magic_breakpoint = magic_;   // studený start (reset, launch) nastaví magic breakpoint z konfigurace
        boot_cfg_ = cfg;
        rom_.clear();
        if (cmd.contains("rom")) {
            if (std::FILE* f = std::fopen(cmd["rom"].get<std::string>().c_str(), "rb")) {
                rom_.resize(0x4000);
                rom_.resize(std::fread(rom_.data(), 1, rom_.size(), f));
                std::fclose(f);
            }
        }
        stop_on_entry_ = cmd.value("stopOnEntry", false);
        tap_.clear();   // nové sezení: záznam provozu s ESP od začátku (přes reset zůstává)
        check(dbg_.reset(cid_, dbg::ResetKind::Hard), res);
        dbg_.set_magic_breakpoint(magic_);
        rewind_ = cmd.value("rewind", false);
        enable_rewind();
        if (!card_image_.empty()) {
            // Program nahraje NextZXOS: vstup se pozná až ve stroji (arm_entry).
            load_countdown_ = -1;
            arm_entry(res);
            if (dbg_.state().paused) dbg_.run(cid_);
            frame_due_ = std::chrono::steady_clock::now();
            return;
        }
        load_countdown_ = program_.empty() ? -1 : emulator_load_delay_frames(program_);
        // Hard reset nechá pozastavený stroj pozastavený, program se ale nahrává až po pár
        // snímcích běhu: rozběhnout (zastavení na vstupu pak dá stop_on_entry_).
        if (load_countdown_ >= 0 && dbg_.state().paused) dbg_.run(cid_);
        if (program_.empty() && stop_on_entry_) {
            stop_reason_ = "entry";
            dbg_.pause(cid_);
        }
        frame_due_ = std::chrono::steady_clock::now();
    }

    // ---- WiFi (emulovaný ESP-01 na UART 0)

    /// Launch `esp`, `espAllowedHosts`, `espListenAddress`, `espIpAddress` → konfigurace JNEXT
    /// (EmulatorConfig::esp_*). Výchozí je modul vypnutý: program bez něj na síť nevidí. Platí
    /// pro oba starty (přímé nahrání i boot do NextZXOS) a přežije reset i nahrání programu
    /// (studený start bere boot_cfg_). Neplatná hodnota → chyba launch, nic se nespustí.
    static bool esp_config(const json& cmd, EmulatorConfig& cfg, json& res) {
        auto fail = [&res](const std::string& e) {
            res["ok"] = false;
            res["error"] = e;
            return false;
        };
        cfg.esp_enabled = cmd.value("esp", false);
        if (!cfg.esp_enabled) return true;
        if (cmd.contains("espAllowedHosts")) {
            const json& hosts = cmd["espAllowedHosts"];
            if (!hosts.is_array()) return fail("espAllowedHosts must be an array of host names or addresses");
            for (const json& h : hosts) {
                std::string host = h.is_string() ? h.get<std::string>() : std::string();
                host.erase(0, host.find_first_not_of(" \t"));
                host.erase(host.find_last_not_of(" \t") + 1);
                // Prázdná položka by seznam tiše nezúžila (prázdný seznam = jakýkoli host).
                if (host.empty()) return fail("espAllowedHosts: empty entry");
                cfg.esp_allowed_hosts.push_back(host);
            }
        }
        esp::IpAddress ip;
        if (cmd.contains("espListenAddress")) {
            cfg.esp_listen_address = cmd["espListenAddress"].get<std::string>();
            if (!esp::parse_ip(cfg.esp_listen_address, ip))
                return fail("espListenAddress must be a numeric IP address: " + cfg.esp_listen_address);
        }
        if (cmd.contains("espIpAddress")) {
            cfg.esp_ip_address = cmd["espIpAddress"].get<std::string>();
            if (!esp::parse_ip(cfg.esp_ip_address, ip) || std::all_of(ip.bytes.begin(), ip.bytes.end(), [](uint8_t b) { return b == 0; }))
                return fail("espIpAddress must be a numeric, non-zero IP address: " + cfg.esp_ip_address);
        }
        return true;
    }

    /// Jednou za launch: WiFi je zapnutá a kam smí. JNEXT to píše jen na úrovni info (server
    /// propouští warn a výš) a smyčku (127.0.0.1, localhost) odmítá vždy – na počítač se program
    /// dostane jen přes jeho adresu v místní síti.
    void report_esp(const EmulatorConfig& cfg) {
        if (cfg.esp_allowed_hosts.empty()) {
            output("espEnabled", {},
                   "Emulated ESP-01 WiFi on UART 0: the program can connect to any host. Loopback (127.0.0.1, localhost) is always refused – use this computer's LAN address.");
            return;
        }
        std::string list;
        for (const std::string& h : cfg.esp_allowed_hosts) list += (list.empty() ? "" : ", ") + h;
        output("espEnabledHosts", {list},
               "Emulated ESP-01 WiFi on UART 0: the program can connect only to " + list + ". Loopback (127.0.0.1, localhost) is always refused – use this computer's LAN address.");
    }

    /// Záznam provozu program ↔ ESP (esp_tap.h): kusy od `since` (poslední kus může ještě růst,
    /// pohled se pak ptá od jeho seq), nejvýš `max`.
    void esp_log(const json& cmd, json& res) {
        const uint64_t since = cmd.value("since", uint64_t{0});
        const size_t max = std::clamp<size_t>(cmd.value("max", size_t{2000}), 1, 20000);
        res["enabled"] = tap_.active();
        res["first"] = tap_.first_seq();
        res["next"] = tap_.next_seq();
        res["epoch"] = tap_.epoch();
        res["bytesTx"] = tap_.bytes_tx();
        res["bytesRx"] = tap_.bytes_rx();
        json entries = json::array();
        for (const esptap::Chunk& c : tap_.since(since, max))
            entries.push_back({{"seq", c.seq}, {"dir", c.rx ? "rx" : "tx"}, {"frame", c.frame}, {"t", c.tstates},
                               {"data", base64(reinterpret_cast<const uint8_t*>(c.data.data()), c.data.size())}});
        res["entries"] = std::move(entries);
    }

    /// Stav modulu, který JNEXT hlásí: připojení k síti, adresa, povolené hosty a poslední
    /// události spojení (EspConnectionLog: otevřeno, odmítnuto, selhalo, zavřeno).
    void esp_state(json& res) {
        res["enabled"] = emu_.esp_enabled();
        if (!emu_.esp_enabled()) return;
        res["associated"] = emu_.esp_associated();
        res["stationIp"] = emu_.esp_station_ip();
        res["allowedHosts"] = emu_.esp_allowed_hosts();
        res["listenAddress"] = boot_cfg_.esp_listen_address;
        json events = json::array();
        if (const EspConnectionLog* log = emu_.esp_events()) {
            for (const EspEvent& e : log->snapshot())
                events.push_back({{"kind", esp_event_text(e.kind)}, {"host", e.host}, {"port", e.port}, {"detail", e.detail}});
            res["eventsTotal"] = log->sequence();
        }
        res["events"] = std::move(events);
    }

    /// Breakpoint na řádek provozu s ESP (event breakpoint espTx / espRx): zápis na port $133B
    /// (program posílá) / čtení z $143B (program bere odpověď), jen s vybraným UART 0. Zastaví
    /// instrukce OUT / IN, která řádek dokončila (\n), když řádek odpovídá vzoru z podmínky
    /// (esptap::Pattern: podřetězec, nebo /regex/). Podmínku tu nepřekládá jazyk výrazů JNEXT.
    bool esp_breakpoint(bool rx, const json& b, dbg::Subscription& sub, std::string& err) {
        auto m = std::make_shared<EspMatch>();
        if (!m->pattern.compile(b.value("condition", ""), err)) return false;
        m->rx = rx;
        sub.kind = dbg::EventKind::Port;
        sub.filter.port_mask = 0xFFFF;
        sub.filter.port_value = rx ? 0x143B : 0x133B;
        sub.access = rx ? dbg::Access::Read : dbg::Access::Write;
        sub.handler = [this, m](const dbg::Event& e, dbg::Debugger&) {
            if (emu_.uart().selected_channel() != 0) return dbg::Action::Continue;
            if (!m->lines.push(e.value) || !m->pattern.matches(m->lines.line())) return dbg::Action::Continue;
            esp_stop_text_ = (m->rx ? "ESP → Z80: " : "Z80 → ESP: ") + esptap::printable(m->lines.line());
            return dbg::Action::Stop;
        };
        return true;
    }

    // ---- start do NextZXOS

    /// Jméno složky na kartě z názvu programu: písmena, číslice, _ a -.
    static std::string card_name(const std::string& program) {
        std::string stem = std::filesystem::u8path(program).stem().u8string();
        std::string out;
        for (unsigned char c : stem) out.push_back(std::isalnum(c) || c == '_' || c == '-' ? static_cast<char>(c) : '_');
        return out.empty() ? std::string("program") : out;
    }

    /// Launch "boot": "nextzxos": program a složku na kartu, autoexec, stroj bootuje z karty.
    bool start_card(const json& cmd, EmulatorConfig& cfg, json& res) {
        if (cfg.sd_card_image.empty() || program_.empty()) {
            res["ok"] = false;
            res["error"] = "boot \"nextzxos\" needs sdImage and program";
            return false;
        }
        cfg.nextzxos_like_direct_load = false;   // stroj připraví opravdový NextZXOS
        const std::string root = cmd.contains("esxdosRoot")
            ? cmd["esxdosRoot"].get<std::string>()
            : std::filesystem::u8path(program_).parent_path().u8string();
        const std::string folder = cmd.value("cardFolder", "/MBX/" + card_name(program_));
        card::Staged st;
        std::string err;
        if (!card::stage(cfg.sd_card_image, folder, root, program_, cmd.value("autorun", true), st, err)) {
            res["ok"] = false;
            res["error"] = err;
            return false;
        }
        card_image_ = cfg.sd_card_image;
        card::normalize_folder(folder, card_folder_, err);
        card_root_ = root;
        card_program_ = st.program_on_card;
        card_sync_ = cmd.value("syncBack", false);
        output("cardStaged", {std::to_string(st.files), "C:" + card_folder_},
               std::to_string(st.files) + " file(s) copied to C:" + card_folder_ + " on the SD card; NextZXOS starts the program.");
        return true;
    }

    /// Zastavení na první instrukci programu, který nahraje NextZXOS (.nexload): breakpoint na PC
    /// z hlavičky NEX, s podmínkou na stránku v $C000 a prvních 8 bajtů kódu ze souboru – ty
    /// jsou v paměti až po nahrání, takže kód NextZXOS na téže adrese ji nesplní. Podmínku
    /// vyhodnocuje jádro, boot se tím nezpomalí.
    void arm_entry(json& res) {
        disarm_entry();
        NexLoader nex;
        if (!nex.load(program_)) {
            output("entryUnknown", {program_}, "Cannot read " + program_ + " as a NEX file: the debugger will not stop when NextZXOS starts it.");
            return;
        }
        const NexHeader& h = nex.header();
        if (h.pc == 0) {
            output("entryNone", {program_}, "The NEX file has no start address (PC=0): the debugger cannot tell when NextZXOS starts it.");
            return;
        }
        static const int kOrder[] = {5, 2, 0, 1, 3, 4, 6, 7};
        int bank = h.pc < 0x4000 ? -1 : h.pc < 0x8000 ? 5 : h.pc < 0xC000 ? 2 : h.entry_bank;
        std::string cond;
        if (bank >= 0 && bank < 112 && h.banks[bank]) {
            // Pořadí bank v souboru: 5, 2, 0, 1, 3, 4, 6, 7, pak 8, 9, …
            uint64_t index = 0;
            auto before = [&](int b) {
                for (int i = 0; i < 8; ++i) if (kOrder[i] == b) return i;
                return b;
            };
            for (int b = 0; b < 112; ++b)
                if (h.banks[b] && before(b) < before(bank)) ++index;
            std::ifstream f(std::filesystem::u8path(program_), std::ios::binary);
            f.seekg(static_cast<std::streamoff>(nex.bank_data_offset() + index * 0x4000 + (h.pc & 0x3FFF)));
            uint8_t code[8] = {};
            f.read(reinterpret_cast<char*>(code), sizeof code);
            const int n = static_cast<int>(f.gcount());
            for (int i = 0; i < n && (h.pc & 0x3FFF) + i < 0x4000; ++i)
                cond += (cond.empty() ? "" : " and ") + std::string("mem[") + std::to_string(h.pc + i) + "] == " + std::to_string(code[i]);
        }
        if (h.pc >= 0xC000) cond += (cond.empty() ? "" : " and ") + std::string("mmu[6] == ") + std::to_string(h.entry_bank * 2);
        dbg::Subscription sub;
        sub.kind = dbg::EventKind::Execute;
        sub.filter.lo = sub.filter.hi = h.pc;
        sub.action = dbg::Action::Stop;
        std::string err;
        sub.condition = compile(json{{"condition", cond}}, dbg::EventKind::Execute, err);
        sub.handler = [this](const dbg::Event&, dbg::Debugger&) {
            entry_hit_ = true;
            return dbg::Action::Stop;
        };
        const auto r = dbg_.subscribe(cid_, sub);
        if (!r || !err.empty()) {
            output("entryUnknown", {program_}, "Cannot watch for the start of " + program_ + ": " + (err.empty() ? std::string(dbg::result_name(r.status)) : err));
            return;
        }
        entry_ev_ = r.value;
        res["waitsForNextZXOS"] = true;
    }

    void disarm_entry() {
        if (entry_ev_ == dbg::EVENT_NONE) return;
        dbg_.unsubscribe(cid_, entry_ev_);
        entry_ev_ = dbg::EVENT_NONE;
    }

    /// Konec startu do NextZXOS: autoexec karty zpět a (s `report` a syncBack) změněné soubory
    /// do složky na disku; odpověď nese seznamy (endSession).
    void end_card(bool report, json& res) {
        disarm_entry();
        if (card_image_.empty()) return;
        const std::string image = card_image_;
        card_image_.clear();
        std::string err;
        if (!card::finish(image, err)) output("cardFinishFailed", {err}, "SD card: " + err);
        if (!report || !card_sync_) return;
        card::Synced sy;
        if (!card::sync_back(image, card_folder_, card_root_, card_program_, sy, err)) {
            res["ok"] = false;
            res["error"] = err;
            return;
        }
        res["copied"] = sy.copied;
        res["missing"] = sy.missing;
        res["folder"] = card_root_;
    }

    void prepare_sd(const json& cmd, json& res) {
        std::string err;
        if (!card::prepare_from_zip(cmd.at("zip").get<std::string>(), cmd.at("sdImage").get<std::string>(), err)) {
            res["ok"] = false;
            res["error"] = err;
        }
    }

    void clean_card(const json& cmd, json& res) {
        std::string err;
        if (!card::clean(cmd.at("sdImage").get<std::string>(), cmd.value("folder", "/MBX"), err)) {
            res["ok"] = false;
            res["error"] = err;
        }
    }

public:
    /// Studený start stroje (LoopDriver::cold_boot) s konfigurací z posledního "launch".
    bool cold_boot() {
        const bool profiling = stop_profiler();
        emulator_cold_boot(emu_, boot_cfg_);
        tap_.install(emu_.uart());   // nový stroj má nový adaptér ESP
        if (profiling) emu_.profiler().init();
        return true;
    }

    bool load(const std::string& path) {
        const bool profiling = stop_profiler();
        const bool ok = emulator_apply_load_keeping(emu_, path, false, [this](MachineType t) { boot_cfg_.type = t; });
        tap_.install(emu_.uart());
        if (profiling) emu_.profiler().init();
        if (ok && !emulator_load_routes_to_snapshot(path)) install_rom();
        return ok;
    }

private:
    /// Stroj se při studeném startu a nahrání programu sestaví znovu (~Emulator + nový) a destruktor
    /// by běžící profiler zapsal do profile.dat v pracovní složce. Proto se před tím vypne a potom
    /// zase zapne (čítače začnou od nuly). Vrací, jestli běžel.
    bool stop_profiler() {
        if (!emu_.profiler().active()) return false;
        emu_.profiler().shutdown();
        return true;
    }

    /// Krokování zpět: stav za každý snímek obrazu, 10 s historie. Po startu i po nahrání
    /// programu (nahrání stroj sestaví znovu).
    void enable_rewind() {
        if (!rewind_) return;
        const dbg::Result a = dbg_.resize_rewind_buffer(500);
        const dbg::Result b = dbg_.set_rewind_enabled(true);
        if (a != dbg::Result::Ok || b != dbg::Result::Ok)
            output("rewindFailed", {dbg::result_name(a), dbg::result_name(b)},
                   std::string("Cannot enable Step Back: ") + dbg::result_name(a) + " / " + dbg::result_name(b));
    }

    /// Bez SD karty nemá Next žádnou ROM (bere ji z karty): ROM 48K do všech čtyř bank v SRAM,
    /// jinak by první přerušení (IM 1 → $0038) skočilo do prázdné paměti. Jako aplikace pro Android.
    void install_rom() {
        if (rom_.size() < 0x4000 || !boot_cfg_.sd_card_image.empty() || emu_.config().type != MachineType::ZXN_ISSUE2) return;
        for (int bank = 0; bank < 4; ++bank) {
            uint8_t* lo = emu_.ram().page_ptr(static_cast<uint16_t>(bank * 2));
            uint8_t* hi = emu_.ram().page_ptr(static_cast<uint16_t>(bank * 2 + 1));
            if (lo) std::memcpy(lo, rom_.data(), 0x2000);
            if (hi) std::memcpy(hi, rom_.data() + 0x2000, 0x2000);
        }
    }

    void state(json& res) {
        const dbg::RunState s = dbg_.state();
        const dbg::Time t = dbg_.time();
        res["paused"] = s.paused;
        res["pc"] = s.pc;
        res["frame"] = t.frame;
        res["tstates"] = t.tstates_total;
        res["cycleInFrame"] = t.cycle_in_frame;
    }

    void registers(json& res) {
        const Z80Registers r = dbg_.registers();
        json regs = {
            {"AF", r.AF}, {"BC", r.BC}, {"DE", r.DE}, {"HL", r.HL},
            {"AF'", r.AF2}, {"BC'", r.BC2}, {"DE'", r.DE2}, {"HL'", r.HL2},
            {"IX", r.IX}, {"IY", r.IY}, {"SP", r.SP}, {"PC", r.PC},
            {"I", r.I}, {"R", r.R}, {"IFF1", r.IFF1}, {"IFF2", r.IFF2}, {"IM", r.IM}, {"halted", r.halted},
        };
        res["registers"] = regs;
        state(res);
    }

    void set_register(const json& cmd, json& res) {
        const std::string n = cmd.at("name").get<std::string>();
        for (const auto& r : kRegs) {
            if (n == r.name) {
                check(dbg_.set_register(cid_, r.id, cmd.at("value").get<uint16_t>()), res);
                return;
            }
        }
        res["ok"] = false;
        res["error"] = "unknown register " + n;
    }

    /// Paměť CPU (nejvýš 64K), nebo s `page` fyzické 8K stránky: až 0x30000 bajtů souvisle přes
    /// stránky page, page+1, … (peek nad stránkou čte jen do jejího konce, proto po stránkách).
    void read_memory(const json& cmd, json& res) {
        uint32_t addr = cmd.at("addr").get<uint32_t>();
        const bool paged = cmd.contains("page");
        const size_t n = std::min<size_t>(cmd.value("length", 256u), paged ? 0x30000 : 0x10000);
        std::vector<uint8_t> buf(n);
        if (!paged) {
            const auto r = dbg_.peek(dbg::MemSpace::cpu(), addr, n, buf.data());
            if (!r) {
                check(r.status, res);
                return;
            }
            res["data"] = base64(buf.data(), r.value);
            return;
        }
        constexpr uint32_t kPage = 0x2000;
        uint32_t page = cmd["page"].get<uint32_t>() + addr / kPage;
        addr %= kPage;
        for (size_t done = 0; done < n; ++page, addr = 0) {
            const size_t part = std::min<size_t>(n - done, kPage - addr);
            if (page > 0xFF) {
                check(dbg::Result::InvalidPage, res);
                return;
            }
            const auto r = dbg_.peek(dbg::MemSpace::page(static_cast<uint16_t>(page)), addr, part, buf.data() + done);
            if (!r) {
                check(r.status, res);
                return;
            }
            done += part;
        }
        res["data"] = base64(buf.data(), buf.size());
    }

    void write_memory(const json& cmd, json& res) {
        const uint32_t addr = cmd.at("addr").get<uint32_t>();
        const std::vector<uint8_t> data = unbase64(cmd.at("data").get<std::string>());
        const dbg::MemSpace space = cmd.contains("page") ? dbg::MemSpace::page(cmd["page"].get<uint16_t>()) : dbg::MemSpace::cpu();
        const auto r = dbg_.poke(cid_, space, addr, data.size(), data.data());
        if (!r) check(r.status, res);
        else res["written"] = r.value;
        screen_dirty_ = true;
    }

    void disassemble(const json& cmd, json& res) {
        const uint16_t addr = cmd.at("addr").get<uint16_t>();
        const size_t n = std::min<size_t>(cmd.value("count", 16u), 4096);
        json lines = json::array();
        for (const DisasmLine& l : dbg_.disassemble(addr, n, &dbg_.symbols())) {
            char hex[16] = {0};
            for (int i = 0; i < l.byte_count && i < 4; ++i) std::snprintf(hex + i * 3, 4, "%02X ", l.bytes[i]);
            std::string bytes = hex;
            if (!bytes.empty()) bytes.pop_back();
            lines.push_back({{"addr", l.addr}, {"bytes", bytes}, {"text", l.mnemonic}});
        }
        res["lines"] = lines;
    }

    void call_stack(json& res) {
        json frames = json::array();
        for (const auto& f : dbg_.call_stack())
            frames.push_back({{"caller", f.caller_pc}, {"target", f.target_pc}, {"sp", f.sp_at_call},
                              {"type", static_cast<int>(f.type)}});
        res["frames"] = frames;
    }

    void mmu(json& res) {
        json slots = json::array();
        for (const auto& s : dbg_.mmu_slots()) slots.push_back({{"nr", s.nr_page}, {"page", s.effective_page}});
        res["slots"] = slots;
    }

    void nextregs(json& res) {
        std::vector<uint8_t> v(256);
        for (int i = 0; i < 256; ++i) v[i] = dbg_.nextreg_peek(static_cast<uint8_t>(i));
        res["data"] = base64(v.data(), v.size());
        // Ořezová okna celá: NR $18/$1A/$1B čtou jen souřadnici na indexu z NR $1C.
        const auto clip = [&](dbg::ClipLayer l) {
            const dbg::ClipWindow c = dbg_.clip_window(l);
            return json{{"x1", c.x1}, {"x2", c.x2}, {"y1", c.y1}, {"y2", c.y2}};
        };
        res["clips"] = {{"layer2", clip(dbg::ClipLayer::Layer2)}, {"sprites", clip(dbg::ClipLayer::Sprites)},
                        {"ula", clip(dbg::ClipLayer::Ula)}, {"tilemap", clip(dbg::ClipLayer::Tilemap)}};
    }

    /// Sprity: SpriteInfo z JNEXT, u relativních spritů ale výsledné hodnoty po připojení ke kotvě
    /// (JNEXT je v SpriteInfo nerozvádí – x/y tam jsou syrové posuny). Rozvedení je přepis
    /// SpriteEngine::update_anchor / resolve_relative (video/sprites.cpp), řetěz jde v pořadí 0–127.
    void sprites(json& res) {
        struct Anchor {
            int index = -1;
            bool type1 = false, h4bit = false, visible = false, rotate = false, xm = false, ym = false;
            int x = 0, y = 0;
            uint8_t pattern = 0, pal = 0, xs = 0, ys = 0;   // pattern: 7 bitů N5:N0:N6
        } anchor;
        const std::vector<dbg::SpriteInfo> info = dbg_.sprites();
        std::vector<uint8_t> attrs(dbg::SPRITE_COUNT * dbg::SPRITE_ATTR_BYTES);
        json list = json::array();
        for (size_t i = 0; i < dbg::SPRITE_COUNT && i < info.size(); ++i) {
            const auto raw = dbg_.sprite_attr_raw(static_cast<uint8_t>(i));
            uint8_t* b = attrs.data() + i * dbg::SPRITE_ATTR_BYTES;
            if (raw) std::memcpy(b, raw.value.data(), dbg::SPRITE_ATTR_BYTES);
            const bool ext = b[3] & 0x40;
            const bool relative = ext && (b[4] & 0xC0) == 0x40;
            dbg::SpriteInfo s = info[i];
            if (!relative) {
                anchor.index = static_cast<int>(i);
                anchor.type1 = ext && (b[4] & 0x20);
                anchor.h4bit = s.is_4bit;
                anchor.visible = s.visible;
                anchor.x = s.x;
                anchor.y = s.y;
                anchor.pattern = static_cast<uint8_t>(((b[3] & 0x3F) << 1) | (s.is_4bit ? (b[4] >> 6) & 1 : 0));
                anchor.pal = s.palette_offset;
                anchor.rotate = anchor.type1 && s.rotate;
                anchor.xm = anchor.type1 && s.x_mirror;
                anchor.ym = anchor.type1 && s.y_mirror;
                anchor.xs = anchor.type1 ? s.x_scale : 0;
                anchor.ys = anchor.type1 ? s.y_scale : 0;
            } else {
                // Posun: prohození při rotaci kotvy, zrcadlení, zvětšení, pak k pozici kotvy (9 bitů).
                const int8_t rx = static_cast<int8_t>(b[0]), ry = static_cast<int8_t>(b[1]);
                int ox = anchor.rotate ? ry : rx, oy = anchor.rotate ? rx : ry;
                if (anchor.rotate != anchor.xm) ox = static_cast<int8_t>(-ox);
                if (anchor.ym) oy = static_cast<int8_t>(-oy);
                s.x = (anchor.x + ox * (1 << anchor.xs)) & 0x1FF;
                s.y = (anchor.y + oy * (1 << anchor.ys)) & 0x1FF;
                s.palette_offset = static_cast<uint8_t>(b[2] & 0x01 ? ((b[2] >> 4) + anchor.pal) & 0x0F : b[2] >> 4);
                const bool xm = b[2] & 0x08, ym = b[2] & 0x04, rot = b[2] & 0x02;
                if (anchor.type1) {
                    const bool rxm = anchor.rotate ? ym != rot : xm;
                    const bool rym = anchor.rotate ? xm != rot : ym;
                    s.x_mirror = anchor.xm != rxm;
                    s.y_mirror = anchor.ym != rym;
                    s.rotate = anchor.rotate != rot;
                    s.x_scale = anchor.xs;
                    s.y_scale = anchor.ys;
                } else {
                    s.x_mirror = xm;
                    s.y_mirror = ym;
                    s.rotate = rot;
                    s.x_scale = (b[4] >> 3) & 3;
                    s.y_scale = (b[4] >> 1) & 3;
                }
                uint8_t pattern = static_cast<uint8_t>(((b[3] & 0x3F) << 1) | ((b[4] >> 5) & 1));   // N6 je u relativního v bitu 5
                if (b[4] & 0x01) pattern = (pattern + anchor.pattern) & 0x7F;
                s.is_4bit = anchor.h4bit;
                s.pattern = s.is_4bit ? pattern : static_cast<uint8_t>(pattern >> 1);
                s.visible = anchor.visible && (b[3] & 0x80);
            }
            list.push_back({{"x", s.x}, {"y", s.y}, {"pattern", s.pattern}, {"paletteOffset", s.palette_offset},
                            {"visible", s.visible}, {"xMirror", s.x_mirror}, {"yMirror", s.y_mirror},
                            {"rotate", s.rotate}, {"is4bit", s.is_4bit}, {"xScale", s.x_scale},
                            {"yScale", s.y_scale}, {"relative", relative}, {"anchor", relative ? anchor.index : -1}});
        }
        res["sprites"] = list;
        res["attrs"] = base64(attrs.data(), attrs.size());
        const dbg::ClipWindow c = dbg_.sprite_clip();
        res["clip"] = {{"x1", c.x1}, {"x2", c.x2}, {"y1", c.y1}, {"y2", c.y2}};
    }

    void pattern_ram(json& res) {
        const dbg::ConstBytes p = dbg_.pattern_ram();
        res["data"] = base64(p.data, p.data ? p.size : 0);
    }

    /// Osm bank palet po 256 položkách RGB333 (bity 8–6 R, 5–3 G, 2–0 B – stejně jako v JNEXT).
    void palettes(json& res) {
        static const std::pair<const char*, dbg::PaletteId> kBanks[] = {
            {"ula0", dbg::PaletteId::UlaFirst}, {"ula1", dbg::PaletteId::UlaSecond},
            {"layer2_0", dbg::PaletteId::Layer2First}, {"layer2_1", dbg::PaletteId::Layer2Second},
            {"sprite0", dbg::PaletteId::SpriteFirst}, {"sprite1", dbg::PaletteId::SpriteSecond},
            {"tilemap0", dbg::PaletteId::TilemapFirst}, {"tilemap1", dbg::PaletteId::TilemapSecond},
        };
        json banks = json::object();
        for (const auto& b : kBanks) {
            json entries = json::array();
            for (uint16_t c : dbg_.palette(b.second)) entries.push_back(c & 0x1FF);
            banks[b.first] = entries;
        }
        res["banks"] = banks;
        res["activeUla"] = dbg_.active_ula_palette_bank();
    }

    /// Copper: PC, běh, režim (NR 0x62 bity 7–6) a program 1024 slov u16 little endian.
    void copper(json& res) {
        const dbg::CopperState c = dbg_.copper();
        std::vector<uint8_t> prog(2048);
        for (size_t i = 0; i < 1024 && i < c.program.size; ++i) {
            prog[i * 2] = static_cast<uint8_t>(c.program.data[i]);
            prog[i * 2 + 1] = static_cast<uint8_t>(c.program.data[i] >> 8);
        }
        res["pc"] = c.pc;
        res["running"] = c.running;
        res["mode"] = c.mode;
        res["program"] = base64(prog.data(), prog.size());
    }

    /// Jedna vrstva obrazu (dbg::render_layer) přes celý snímek 640 × 256: všechny řádky 0..výška−1
    /// s registry přehranými po řádcích jako při skládání obrazu. Pixely RGBA, alfa 0 = průhledné.
    void render_layer(const json& cmd, json& res) {
        static const std::pair<const char*, dbg::Layer> kLayers[] = {
            {"composite", dbg::Layer::Composite}, {"ula", dbg::Layer::UlaPrimary},
            {"ulaShadow", dbg::Layer::UlaShadow}, {"layer2", dbg::Layer::Layer2Active},
            {"layer2Shadow", dbg::Layer::Layer2Shadow}, {"sprites", dbg::Layer::Sprites},
            {"tilemap", dbg::Layer::Tilemap}, {"background", dbg::Layer::Background},
        };
        const std::string name = cmd.value("layer", "composite");
        const dbg::Layer* layer = nullptr;
        for (const auto& l : kLayers) if (name == l.first) layer = &l.second;
        if (!layer) {
            res["ok"] = false;
            res["error"] = "unknown layer: " + name;
            return;
        }
        const int w = static_cast<int>(dbg::RENDER_WIDTH);
        const int h = emu_.get_framebuffer_height();
        std::vector<uint32_t> px(static_cast<size_t>(w) * h);
        const dbg::Result r = dbg_.render_layer(*layer, h - 1, px.data(), dbg::RENDER_WIDTH);   // vc = poslední řádek
        if (r != dbg::Result::Ok) {
            check(r, res);
            return;
        }
        std::vector<uint8_t> rgba(px.size() * 4);
        for (size_t i = 0; i < px.size(); ++i) {
            const uint32_t p = px[i];   // 0xAARRGGBB
            rgba[i * 4] = static_cast<uint8_t>(p >> 16);
            rgba[i * 4 + 1] = static_cast<uint8_t>(p >> 8);
            rgba[i * 4 + 2] = static_cast<uint8_t>(p);
            rgba[i * 4 + 3] = static_cast<uint8_t>(p >> 24);
        }
        res["width"] = w;
        res["height"] = h;
        res["data"] = base64(rgba.data(), rgba.size());
    }

    /// Paprsek: syrové čítače VHDL hc/vc a pozice v prostoru 320 × 256 (obraz 640 × 256 / 2
    /// vodorovně). Přepočet jako při kreslení obrazu v JNEXT: sloupec v rámci 640 = DISP_X + 2·phc
    /// (video/renderer.cpp), řádek = vc − vblank_top (core/emulator.cpp, fb_row). Každá osa mimo
    /// viditelnou oblast (zatemnění, okraj za rámcem obrazu) je −1 zvlášť.
    void raster(json& res) {
        const RasterState r = dbg_.raster();
        const dbg::MachineInfo m = dbg_.machine();
        const dbg::Time t = dbg_.time();
        const int w = Renderer::FB_WIDTH / 2, h = Renderer::FB_HEIGHT;
        const int x = Renderer::DISP_X / 2 + r.phc;
        const int y = r.raw_vc - m.vblank_top;
        res["vc"] = r.raw_vc;
        res["hc"] = r.raw_hc;
        res["x"] = x >= 0 && x < w ? x : -1;
        res["y"] = y >= 0 && y < h ? y : -1;
        res["frame"] = t.frame;
        res["cycleInFrame"] = t.cycle_in_frame;
        res["linesPerFrame"] = m.lines;
    }

    /// Zvuk: registry tří AY (TurboSound), zapnutí TurboSoundu, režim čipů a kanály DAC
    /// (Soundrive / Covox / Specdrum – v JNEXT Dac::ch_ A–D bez getteru, proto přes save_state:
    /// popis stavu DAC jsou právě ty 4 bajty). DAC vypnutý (NR 0x08 bit 3) → null.
    void sound_state(json& res) {
        json chips = json::array();
        for (int c = 0; c < static_cast<int>(dbg::AY_CHIP_COUNT); ++c) {
            json regs = json::array();
            const auto r = dbg_.ay_registers(c);
            for (size_t i = 0; i < dbg::AY_REGISTER_COUNT; ++i) regs.push_back(r ? r.value[i] : 0);
            chips.push_back({{"regs", regs}});
        }
        res["chips"] = chips;
        res["turbosound"] = dbg_.turbosound_enabled();
        // NR 0x06 bity 1–0: x0 YM, 01 AY, 11 všechny čipy drží v resetu (ay_mode() to nerozliší).
        const bool next = emu_.config().type == MachineType::ZXN_ISSUE2;
        if (next && (dbg_.nextreg_peek(0x06) & 0x03) == 0x03) res["ayMode"] = "reset";
        else res["ayMode"] = dbg_.ay_mode() == dbg::AyChipMode::Ay ? "AY" : "YM";
        res["dac"] = nullptr;
        if (emu_.dac_enabled()) {
            uint8_t ch[16] = {};
            StateWriter w(ch, sizeof ch);
            emu_.dac().save_state(w);
            if (w.position() == 4) res["dac"] = {ch[0], ch[1], ch[2], ch[3]};
        }
    }

    /// Obsazení paměti: počet nenulových bajtů v každé 8K stránce RAM 0–223 (čísla stránek jako
    /// NR 0x50–0x57); nečitelná stránka (stroj s menší pamětí) → −1. `rom` je prázdné: ROM
    /// v číslování stránek RAM neleží (u Nextu je v SRAM pod stránkou 0, jinde zvláštní obraz).
    void page_usage(json& res) {
        constexpr uint32_t kPage = 0x2000;
        constexpr uint16_t kPages = 224;
        std::vector<uint8_t> buf(kPage);
        json counts = json::array();
        for (uint16_t p = 0; p < kPages; ++p) {
            const auto r = dbg_.peek(dbg::MemSpace::page(p), 0, kPage, buf.data());
            if (!r) {
                counts.push_back(-1);
                continue;
            }
            const auto zeros = std::count(buf.begin(), buf.begin() + static_cast<std::ptrdiff_t>(r.value), uint8_t{0});
            counts.push_back(static_cast<int>(r.value) - static_cast<int>(zeros));
        }
        res["nonzero"] = counts;
        res["rom"] = json::array();
    }

    void evaluate(const json& cmd, json& res) {
        const auto r = jnext::script::eval_expr(cmd.at("expr").get<std::string>(), dbg_);
        if (!r.ok) {
            res["ok"] = false;
            res["error"] = r.errors.empty() ? std::string("error") : r.errors.front().message;
            return;
        }
        res["value"] = r.value;
    }

    void load_symbols(const json& cmd, json& res) {
        dbg_.clear_symbols();
        const auto r = dbg_.load_map(cmd.at("path").get<std::string>(), dbg::MapFormat::Simple);
        if (!r) check(r.status, res);
        else res["count"] = r.value;
    }

    /// Podmínka (jazyk výrazů JNEXT) pro událost `scope`; chyba → `err`.
    dbg::Condition compile(const json& b, jnext::script::PayloadScope scope, std::string& err) {
        const std::string text = b.value("condition", "");
        if (text.empty()) return {};
        jnext::script::CompileOptions opts;
        opts.symbols = jnext::script::symbols_of(dbg_);
        opts.on_runtime_error = [this, text](const jnext::script::Diagnostic& d) {
            output("conditionError", {text, d.to_string()}, "Condition \"" + text + "\": " + d.to_string());
        };
        auto c = jnext::script::compile_expr(text, scope, opts);
        if (!c) {
            err = c.errors.front().to_string();
            return {};
        }
        return c.predicate;
    }

    /// Logpoint: {výraz} v textu se nahradí hodnotou.
    std::string interpolate(const std::string& msg, const dbg::Debugger& d) {
        std::string out;
        for (size_t i = 0; i < msg.size(); ++i) {
            if (msg[i] == '{') {
                const size_t end = msg.find('}', i);
                if (end != std::string::npos) {
                    const auto r = jnext::script::eval_expr(msg.substr(i + 1, end - i - 1), d);
                    char buf[32];
                    if (r.ok) std::snprintf(buf, sizeof buf, "%d", r.value);
                    out += r.ok ? std::string(buf) : std::string("?");
                    i = end;
                    continue;
                }
            }
            out += msg[i];
        }
        return out;
    }

    /// Společné pro všechny druhy: počet průchodů a logpoint přes handler, zápis do seznamu.
    json add(std::map<int, std::unique_ptr<Bp>>& list, const json& b, dbg::Subscription sub, const std::string& err) {
        const int id = b.value("id", 0);
        if (!err.empty()) return {{"id", id}, {"verified", false}, {"message", err}};
        auto bp = std::make_unique<Bp>();
        bp->id = id;
        bp->hit_condition = b.value("hitCondition", "");
        bp->log_message = b.value("logMessage", "");
        Bp* raw = bp.get();
        if (!raw->hit_condition.empty() || !raw->log_message.empty()) {
            sub.handler = [this, raw](const dbg::Event&, dbg::Debugger& d) {
                ++raw->hits;
                if (!hit_matches(raw->hit_condition, raw->hits)) return dbg::Action::Continue;
                if (!raw->log_message.empty()) {
                    output(interpolate(raw->log_message, d) + "\n");
                    return dbg::Action::Continue;
                }
                return dbg::Action::Stop;
            };
        }
        const auto s = dbg_.subscribe(cid_, sub);
        if (!s) return {{"id", id}, {"verified", false}, {"message", dbg::result_name(s.status)}};
        bp->ev = s.value;
        by_event_[s.value] = id;
        list[id] = std::move(bp);
        return {{"id", id}, {"verified", true}};
    }

    void clear(std::map<int, std::unique_ptr<Bp>>& list) {
        for (auto& kv : list) {
            dbg_.unsubscribe(cid_, kv.second->ev);
            by_event_.erase(kv.second->ev);
        }
        list.clear();
    }

    /// Breakpointy na adresu (případně jen se stránkou `page` v daném slotu MMU).
    void set_breakpoints(const json& cmd, json& res) {
        clear(bps_);
        json out = json::array();
        for (const auto& b : cmd.value("breakpoints", json::array())) {
            dbg::Subscription sub;
            sub.kind = dbg::EventKind::Execute;
            sub.filter.lo = sub.filter.hi = b.at("addr").get<uint16_t>();
            if (b.contains("page")) sub.filter.page = b["page"].get<uint16_t>();
            sub.action = dbg::Action::Stop;
            std::string err;
            sub.condition = compile(b, dbg::EventKind::Execute, err);
            out.push_back(add(bps_, b, sub, err));
        }
        res["breakpoints"] = out;
    }

    /// Watchpointy: čtení / zápis paměti v rozsahu adres.
    void set_watchpoints(const json& cmd, json& res) {
        clear(wps_);
        json out = json::array();
        for (const auto& b : cmd.value("watchpoints", json::array())) {
            dbg::Subscription sub;
            sub.kind = dbg::EventKind::Mem;
            sub.filter.lo = b.at("addr").get<uint16_t>();
            const uint32_t len = std::max<uint32_t>(1, b.value("length", 1u));
            sub.filter.hi = static_cast<uint16_t>(std::min<uint32_t>(0xFFFF, sub.filter.lo + len - 1));
            const std::string a = b.value("access", "write");
            sub.access = a == "read" ? dbg::Access::Read : a == "readWrite" ? dbg::Access::ReadWrite : dbg::Access::Write;
            sub.action = dbg::Action::Stop;
            std::string err;
            jnext::script::PayloadScope scope(dbg::EventKind::Mem);
            sub.condition = compile(b, scope, err);
            out.push_back(add(wps_, b, sub, err));
        }
        res["watchpoints"] = out;
    }

    /// Breakpointy na události stroje: přerušení, NMI, zápis do NEXTREG, port, řádek, snímek, Copper, DMA, reset.
    void set_event_breakpoints(const json& cmd, json& res) {
        clear(evs_);
        json out = json::array();
        for (const auto& b : cmd.value("events", json::array())) {
            const std::string kind = b.value("kind", "");
            dbg::Subscription sub;
            sub.action = dbg::Action::Stop;
            std::string err;
            if (kind == "interrupt") sub.kind = dbg::EventKind::IntAck;
            else if (kind == "nmi") sub.kind = dbg::EventKind::Nmi;
            else if (kind == "nextreg") {
                sub.kind = dbg::EventKind::NextRegWrite;
                for (const auto& r : b.value("regs", json::array())) sub.filter.regs.push_back(r.get<uint8_t>());
            } else if (kind == "port") {
                sub.kind = dbg::EventKind::Port;
                sub.filter.port_mask = b.value("mask", 0);       // výchozí: všechny porty (zúží je podmínka)
                sub.filter.port_value = b.value("value", 0);
                const std::string a = b.value("access", "readWrite");
                sub.access = a == "read" ? dbg::Access::Read : a == "write" ? dbg::Access::Write : dbg::Access::ReadWrite;
            } else if (kind == "scanline") {
                sub.kind = dbg::EventKind::Scanline;
                sub.filter.scanline = static_cast<int16_t>(b.value("line", 0));
            } else if (kind == "frame") sub.kind = dbg::EventKind::Frame;
            else if (kind == "copper") sub.kind = dbg::EventKind::Copper;
            else if (kind == "dma") sub.kind = dbg::EventKind::Dma;
            else if (kind == "reset") sub.kind = dbg::EventKind::Reset;
            else if (kind == "espTx" || kind == "espRx") {
                // vlastní handler a vzor místo podmínky; add() bez hitCondition/logMessage ho nepřepíše
                esp_breakpoint(kind == "espRx", b, sub, err);
                out.push_back(add(evs_, json{{"id", b.value("id", 0)}}, sub, err));
                if (evs_.count(b.value("id", 0))) evs_[b.value("id", 0)]->kind = kind;
                continue;
            }
            else err = "unknown event kind: " + kind;
            if (err.empty()) sub.condition = compile(b, sub.kind, err);
            out.push_back(add(evs_, b, sub, err));
            if (evs_.count(b.value("id", 0))) evs_[b.value("id", 0)]->kind = kind;
        }
        res["events"] = out;
    }

    // ---- uložené stavy (záložky JNEXT, CAP-03) a export / import stavu (ST-01/02)

    static constexpr size_t kMaxStates = 8;   // JNEXT: nejvýš 8 záložek na klienta

    /// Chyba uložení: hranice snímku a limit mají vlastní kódy, ostatní jdou jako dbg::result_name.
    static void state_error(dbg::Result r, json& res) {
        if (r == dbg::Result::Ok) return;
        res["ok"] = false;
        res["error"] = r == dbg::Result::NotAtFrameBoundary ? std::string("notAtFrameBoundary") : std::string(dbg::result_name(r));
    }

    static dbg::SaveStateMode save_mode(const json& cmd) {
        return cmd.value("advance", false) ? dbg::SaveStateMode::AdvanceToBoundary : dbg::SaveStateMode::RefuseMidFrame;
    }

    /// Po uložení s `advance`: stroj v pauze se posunul na hranici snímku → zastavení „frameBoundary“
    /// (rozšíření obnoví registry, paměť, obraz). Běžící stroj stojí na hranici vždy, nic se neposouvá.
    void after_advance(uint64_t tstates_before) {
        if (!dbg_.state().paused || dbg_.time().tstates_total == tstates_before) return;
        send({{"event", "stopped"}, {"reason", "frameBoundary"}, {"pc", dbg_.registers().PC}, {"ids", json::array()}, {"text", ""}});
        screen_dirty_ = true;
    }

    void state_save(const json& cmd, json& res) {
        const std::string name = cmd.at("name").get<std::string>();
        const std::vector<std::string> names = dbg_.bookmarks(cid_);
        if (std::find(names.begin(), names.end(), name) == names.end() && names.size() >= kMaxStates) {
            res["ok"] = false;
            res["error"] = "limit";
            return;
        }
        const uint64_t before = dbg_.time().tstates_total;
        const dbg::Result r = dbg_.bookmark_save(cid_, name, save_mode(cmd));
        state_error(r, res);
        if (r == dbg::Result::Ok) after_advance(before);
    }

    /// Načtení stavu (záložka nebo bajty): běžící stroj se nejdřív zastaví (a zastavení se ohlásí
    /// jako „restore“), stojící stroj ohlásí „restore“ hned.
    template <typename Load>
    void restore(Load load, json& res) {
        const bool was_running = !dbg_.state().paused;
        if (was_running) dbg_.pause(cid_);
        const dbg::Result r = load();
        if (r != dbg::Result::Ok) {
            state_error(r, res);
            if (was_running) dbg_.run(cid_);
            return;
        }
        screen_dirty_ = true;
        if (was_running) {
            stop_reason_ = "restore";   // ohlásí on_paused při nejbližším pump()
            return;
        }
        send({{"event", "stopped"}, {"reason", "restore"}, {"pc", dbg_.registers().PC}, {"ids", json::array()}, {"text", ""}});
    }

    void state_restore(const json& cmd, json& res) {
        const std::string name = cmd.at("name").get<std::string>();
        const std::vector<std::string> names = dbg_.bookmarks(cid_);
        if (std::find(names.begin(), names.end(), name) == names.end()) {
            res["ok"] = false;
            res["error"] = "notFound";
            return;
        }
        restore([&] { return dbg_.bookmark_restore(cid_, name); }, res);
    }

    void state_export(const json& cmd, json& res) {
        const uint64_t before = dbg_.time().tstates_total;
        const auto r = dbg_.save_state_bytes(cid_, save_mode(cmd));
        if (!r) {
            state_error(r.status, res);
            return;
        }
        res["data"] = base64(r.value.data(), r.value.size());
        res["size"] = r.value.size();
        after_advance(before);
    }

    /// Bajty z jiného stroje (jiný typ, jiná velikost stavu) by load_state rozbily napůl a JNEXT by
    /// stroj označil za poškozený – proto se nejdřív porovná délka se stavem tohoto stroje.
    void state_import(const json& cmd, json& res) {
        const std::vector<uint8_t> data = unbase64(cmd.at("data").get<std::string>());
        StateWriter measure;
        emu_.save_state(measure);
        if (data.empty() || data.size() != measure.position()) {
            res["ok"] = false;
            res["error"] = "incompatible";
            return;
        }
        restore([&] { return dbg_.load_state_bytes(cid_, data.data(), data.size()); }, res);
    }

    // ---- profiler (T-stavy na fyzickou adresu, Emulator::profiler())

    void profiler_start(json& res) {
        if (!emu_.profiler().init()) {
            res["ok"] = false;
            res["error"] = "allocFailed";
        }
        res["active"] = emu_.profiler().active();
    }

    /// Vynulování bez zastavení: Profiler nemá clear, nové pole (anonymní paměť) je nulové.
    void profiler_clear(json& res) {
        Profiler& p = emu_.profiler();
        if (!p.active()) return;
        p.shutdown();
        profiler_start(res);
    }

    /// Nenulové položky ve vzestupném pořadí fyzické adresy (stránka, posun). `format` "binary":
    /// místo pole `entries` base64 `data`, 16 B na položku (viz docs/protocol.md).
    void profiler_data(const json& cmd, json& res) {
        const Profiler& p = emu_.profiler();
        res["active"] = p.active();
        const bool binary = cmd.value("format", "json") == "binary";
        uint64_t total = 0;
        size_t count = 0;
        json entries = json::array();
        std::vector<uint8_t> bin;
        if (const Profiler::Entry* e = p.entries()) {
            for (uint32_t key = 0; key < Profiler::kNumEntries; ++key) {
                const uint64_t t = e[key].tstates;
                if (!t) continue;
                total += t;
                ++count;
                const uint32_t page = key >> 13, offset = key & 0x1FFF;
                const uint16_t pc = e[key].last_logical_pc;
                if (!binary) {
                    entries.push_back({{"page", page}, {"offset", offset}, {"pc", pc}, {"t", t}});
                    continue;
                }
                uint8_t b[16] = {static_cast<uint8_t>(page), 0, static_cast<uint8_t>(offset), static_cast<uint8_t>(offset >> 8),
                                 static_cast<uint8_t>(pc), static_cast<uint8_t>(pc >> 8), 0, 0};
                for (int i = 0; i < 8; ++i) b[8 + i] = static_cast<uint8_t>(t >> (8 * i));
                bin.insert(bin.end(), b, b + 16);
            }
        }
        res["total"] = total;
        res["count"] = count;
        if (binary) res["data"] = base64(bin.data(), bin.size());
        else res["entries"] = std::move(entries);
    }

    void mouse(const json& cmd) {
        if (cmd.contains("dx") || cmd.contains("dy")) emu_.mouse().inject_delta(cmd.value("dx", 0), -cmd.value("dy", 0));
        if (cmd.contains("buttons")) {
            // VS Code: bit 0 levé, 1 pravé, 2 prostřední; KempstonMouse: bit 0 pravé, 1 levé.
            const int b = cmd["buttons"].get<int>();
            emu_.mouse().set_buttons(static_cast<uint8_t>(((b & 1) << 1) | ((b >> 1) & 1) | (b & 4)));
        }
    }

    Emulator& emu_;
    dbg::Debugger& dbg_;
    Inbox& inbox_;
    dbg::ClientId cid_{};
    std::atomic<bool> running_{true};
    EmulatorConfig boot_cfg_;
    std::string program_;
    std::vector<uint8_t> rom_;
    int load_countdown_ = -1;
    bool stop_on_entry_ = false;
    bool rewind_ = false;
    std::string stop_reason_;   // důvod příštího zastavení, které vyvolal server (entry, restore)
    bool magic_ = true;
    bool esxdos_reported_ = false;   // informace esxdosWritable už v tomto launch odešla
    bool screen_dirty_ = true;
    bool audio_on_ = true;
    uint16_t joy_ = 0;
    uint64_t last_hash_ = 0;
    std::vector<uint8_t> video_;
    std::vector<int16_t> audio_;
    std::chrono::steady_clock::time_point frame_due_ = std::chrono::steady_clock::now();
    std::map<int, std::unique_ptr<Bp>> bps_, wps_, evs_;
    std::map<dbg::EventId, int> by_event_;

    // ---- WiFi: záznam provozu s ESP a breakpointy na řádky (esp_tap.h)
    esptap::Tap tap_{[this](uint32_t& frame, uint64_t& tstates) {
        const dbg::Time t = dbg_.time();
        frame = t.frame;
        tstates = t.tstates_total;
    }};
    std::string esp_stop_text_;   // řádek, na kterém zastavil breakpoint espTx / espRx

    // ---- start do NextZXOS (launch "boot": "nextzxos")
    std::string card_image_;       // pracovní karta; prázdné = program se nahrává přímo
    std::string card_folder_;      // složka programu na kartě ("/MBX/hra")
    std::string card_root_;        // složka na disku, která se na kartu nahrála
    std::string card_program_;     // program na kartě
    bool card_sync_ = false;       // po sezení vrátit změněné soubory do card_root_
    dbg::EventId entry_ev_ = dbg::EVENT_NONE;
    bool entry_hit_ = false;
};

}  // namespace

int main(int, char**) {
#ifdef _WIN32
    _setmode(_fileno(stdin), _O_BINARY);
    _setmode(_fileno(stdout), _O_BINARY);
    timeBeginPeriod(1);
#endif
    // Výpisy JNEXT na stderr – stdout patří protokolu.
    Log::init();
    auto sink = std::make_shared<FilterSink>(std::make_shared<spdlog::sinks::stderr_sink_mt>());
    spdlog::apply_all([&](const std::shared_ptr<spdlog::logger>& l) {
        l->sinks().clear();
        l->sinks().push_back(sink);
    });
    spdlog::set_level(spdlog::level::warn);

    auto emu = std::make_unique<Emulator>();
    EmulatorConfig cfg;
    cfg.live_raster_render = true;
    if (!emu->init(cfg)) {
        std::fprintf(stderr, "mbx: emulator init failed\n");
        return 1;
    }
    dbg::Debugger debugger(*emu);
    Inbox inbox;
    Server server(*emu, debugger, inbox);
    dbg::LoopDriver driver;
    driver.cold_boot = [&server]() { return server.cold_boot(); };
    driver.load = [&server](const std::string& path) { return server.load(path); };
    debugger.set_loop_driver(driver);
    if (!server.start()) {
        std::fprintf(stderr, "mbx: cannot attach to the debugger backend\n");
        return 1;
    }
    std::thread reader(read_loop, std::ref(inbox));
    reader.detach();
    send({{"event", "ready"}, {"version", kVersion}});
    while (server.running()) server.tick();
    return 0;
}
