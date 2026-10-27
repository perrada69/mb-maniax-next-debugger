// MB Maniax Next Debugger – záznam provozu mezi programem a emulovaným ESP-01 (popis v esp_tap.h).

#include "esp_tap.h"

#include "peripheral/esp_uart_adapter.h"
#include "peripheral/uart.h"

#include <algorithm>
#include <cctype>
#include <chrono>
#include <regex>

namespace esptap {

Tap::~Tap() = default;

bool Tap::install(Uart& uart) {
    UartDevice* dev = uart.device(0);
    if (dev == this) return adapter_ != nullptr;
    adapter_ = dynamic_cast<EspUartAdapter*>(dev);
    if (!adapter_) return false;
    // attach_device adaptéru sink vynuluje a dá nový tomuto zařízení; adaptér pak posílá přes nás.
    uart.attach_device(0, this);
    adapter_->set_rx_sink([this](uint8_t byte) {
        record(true, byte);
        send_to_guest(byte);
    });
    // Brána tick() adaptéru se mění i mimo nás (poll na začátku snímku, socket ve vlákně ESP),
    // proto je naše stále zvednutá a adaptér se ptá až v tick().
    set_tick_wanted(true);
    open_ = false;
    return true;
}

void Tap::receive(uint8_t byte) {
    if (!adapter_) return;
    if (!adapter_->inert()) record(false, byte);
    adapter_->receive(byte);
}

void Tap::tick(uint32_t master_cycles, uint32_t byte_ticks) {
    if (adapter_ && adapter_->tick_wanted()) adapter_->tick(master_cycles, byte_ticks);
}

void Tap::record(bool rx, uint8_t byte) {
    (rx ? bytes_rx_ : bytes_tx_)++;
    if (!open_ || log_.empty() || log_.back().rx != rx || log_.back().data.size() >= kMaxChunk) {
        Chunk c;
        c.seq = next_seq_++;
        c.rx = rx;
        if (clock_) clock_(c.frame, c.tstates);
        log_.push_back(std::move(c));
        open_ = true;
    }
    log_.back().data.push_back(static_cast<char>(byte));
    ++log_bytes_;
    if (byte == '\n') open_ = false;
    while (log_.size() > 1 && (log_bytes_ > kMaxBytes || log_.size() > kMaxChunks)) {
        log_bytes_ -= log_.front().data.size();
        log_.pop_front();
    }
}

std::vector<Chunk> Tap::since(uint64_t seq, size_t max) const {
    std::vector<Chunk> out;
    // seq rostou o 1 bez děr: první hledaný je na indexu seq - první
    const uint64_t first = first_seq();
    size_t i = seq > first ? static_cast<size_t>(seq - first) : 0;
    for (; i < log_.size() && out.size() < max; ++i) out.push_back(log_[i]);
    return out;
}

void Tap::clear() {
    log_.clear();
    log_bytes_ = 0;
    open_ = false;
    bytes_tx_ = bytes_rx_ = 0;
    ++epoch_;
}

uint32_t Tap::initial_epoch() {
    return static_cast<uint32_t>(std::chrono::steady_clock::now().time_since_epoch().count() & 0xFFFFFF) << 8;
}

bool LineAssembler::push(uint8_t byte) {
    if (byte != '\n') {
        cur_.push_back(static_cast<char>(byte));
        if (cur_.size() > kMaxLine) cur_.erase(0, cur_.size() - kMaxLine);
        return false;
    }
    if (!cur_.empty() && cur_.back() == '\r') cur_.pop_back();
    done_.swap(cur_);
    cur_.clear();
    return true;
}

struct Pattern::Impl {
    std::regex re;
};

bool Pattern::compile(const std::string& text, std::string& err) {
    text_ = text;
    regex_ = false;
    impl_.reset();
    if (text.size() >= 2 && text.front() == '/') {
        const size_t end = text.rfind('/');
        const std::string flags = text.substr(end + 1);
        if (end > 0 && (flags.empty() || flags == "i")) {
            try {
                auto opts = std::regex::ECMAScript;
                if (flags == "i") opts |= std::regex::icase;
                impl_ = std::make_shared<Impl>(Impl{std::regex(text.substr(1, end - 1), opts)});
                regex_ = true;
            } catch (const std::regex_error& e) {
                err = std::string("invalid regular expression ") + text + ": " + e.what();
                return false;
            }
            return true;
        }
    }
    std::transform(text_.begin(), text_.end(), text_.begin(), [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
    return true;
}

bool Pattern::matches(const std::string& line) const {
    if (regex_) return std::regex_search(line, impl_->re);
    if (text_.empty()) return true;
    std::string low(line);
    std::transform(low.begin(), low.end(), low.begin(), [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
    return low.find(text_) != std::string::npos;
}

std::string printable(const std::string& s) {
    static const char* hex = "0123456789ABCDEF";
    std::string out;
    for (unsigned char c : s) {
        if (c == '\r') out += "\\r";
        else if (c == '\n') out += "\\n";
        else if (c == '\\') out += "\\\\";
        else if (c < 0x20 || c == 0x7F) {
            out += "\\x";
            out += hex[c >> 4];
            out += hex[c & 15];
        } else out += static_cast<char>(c);
    }
    return out;
}

}  // namespace esptap
