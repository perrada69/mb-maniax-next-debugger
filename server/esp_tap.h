// MB Maniax Next Debugger – záznam provozu mezi programem a emulovaným ESP-01 (UART 0).
//
// JNEXT připojí na UART 0 svůj EspUartAdapter (peripheral/esp_uart_adapter.h). Server mezi UART
// a adaptér vloží Tap: sám je UartDevice na UART 0, bajty programu (TX) předá adaptéru a bajty
// modulu (RX) přes sink adaptéru pošle do FIFO programu – obojí cestou zapíše do záznamu.
// Jádro se tím nemění; po každém studeném startu a nahrání programu (stroj se sestaví znovu,
// adaptér je nový) se Tap vloží znovu (install). Mezi zánikem starého stroje a install Tapa
// nikdo nevolá: nový UART ho nezná.
//
// Záznam je po kusech: kus = souvislé bajty jedním směrem, končí koncem řádku (\n), změnou
// směru nebo délkou kMaxChunk. Kusy mají pořadové číslo (seq) rostoucí po celé sezení, takže
// pohled si bere jen nové (since). Při přehrávání (krok zpět, RZX) je adaptér netečný
// (set_inert) a Tap nic nezapisuje – bajty by na síť stejně nešly.

#pragma once

#include "peripheral/uart_device.h"

#include <cstdint>
#include <deque>
#include <functional>
#include <memory>
#include <string>
#include <vector>

class EspUartAdapter;
class Uart;

namespace esptap {

/// Jeden kus záznamu.
struct Chunk {
    uint64_t seq = 0;
    bool rx = false;         ///< true = ESP → program, false = program → ESP
    uint32_t frame = 0;      ///< snímek prvního bajtu
    uint64_t tstates = 0;    ///< T-stavy od startu u prvního bajtu
    std::string data;
};

class Tap : public UartDevice {
public:
    static constexpr size_t kMaxChunk = 1024;           ///< nejdelší kus (dlouhá data bez \n)
    static constexpr size_t kMaxBytes = 4u << 20;       ///< záznam nejvýš 4 MB, starší kusy odpadnou
    static constexpr size_t kMaxChunks = 50000;

    /// Čas pro nový kus: snímek a T-stavy (z backendu ladění).
    using Clock = std::function<void(uint32_t& frame, uint64_t& tstates)>;

    explicit Tap(Clock clock) : clock_(std::move(clock)) {}
    ~Tap() override;

    /// Vloží se mezi UART 0 a adaptér ESP, pokud tam je (ESP zapnuté). Volat po každém studeném
    /// startu a nahrání programu: když stroj zůstal (na UART 0 jsme pořád my), nic nemění; nový
    /// stroj má na UART 0 nový adaptér (nebo nic, ESP vypnuté). Vrací, jestli je vložený.
    bool install(Uart& uart);

    bool active() const { return adapter_ != nullptr; }

    // ---- UartDevice
    void receive(uint8_t byte) override;
    void tick(uint32_t master_cycles, uint32_t byte_ticks) override;

    // ---- záznam
    /// Kusy se seq >= since (nejvýš max). Poslední kus může ještě růst: pohled se ptá znovu od
    /// jeho seq a nahradí ho.
    std::vector<Chunk> since(uint64_t seq, size_t max) const;
    uint64_t first_seq() const { return log_.empty() ? next_seq_ : log_.front().seq; }
    uint64_t next_seq() const { return next_seq_; }
    uint64_t bytes_tx() const { return bytes_tx_; }
    uint64_t bytes_rx() const { return bytes_rx_; }
    /// Mění se při clear() a liší se mezi procesy serveru: pohled podle něj pozná, že má svůj
    /// obsah zahodit (nové sezení, vymazání).
    uint32_t epoch() const { return epoch_; }
    void clear();

private:
    void record(bool rx, uint8_t byte);

    Clock clock_;
    EspUartAdapter* adapter_ = nullptr;
    std::deque<Chunk> log_;
    size_t log_bytes_ = 0;
    uint64_t next_seq_ = 1;
    bool open_ = false;          ///< poslední kus ještě nekončí (\n, změna směru)
    uint64_t bytes_tx_ = 0, bytes_rx_ = 0;
    uint32_t epoch_ = initial_epoch();

    static uint32_t initial_epoch();
};

/// Skládá řádky z bajtů jedním směrem (breakpointy na příkaz / odpověď): vrací true, když bajt
/// řádek ukončil (\n); řádek bez \r\n je pak v line().
class LineAssembler {
public:
    static constexpr size_t kMaxLine = 256;   ///< delší řádek se ořízne zleva (konec zůstane)
    bool push(uint8_t byte);
    const std::string& line() const { return done_; }

private:
    std::string cur_, done_;
};

/// Vzor breakpointu: prázdný = každý řádek, "/regex/" nebo "/regex/i" = regulární výraz
/// (ECMAScript), jinak podřetězec bez ohledu na velikost písmen. Neplatný regex → false a `err`.
class Pattern {
public:
    bool compile(const std::string& text, std::string& err);
    bool matches(const std::string& line) const;

private:
    struct Impl;
    std::string text_;
    bool regex_ = false;
    std::shared_ptr<Impl> impl_;
};

/// Řádek pro člověka: řídicí znaky jako \r \n \xNN.
std::string printable(const std::string& s);

}  // namespace esptap
