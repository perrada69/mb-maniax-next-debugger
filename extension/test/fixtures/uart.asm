; Test: most mezi pamětí a UART 0 (ESP-01). Test zapíše do `tx_len` délku a hned za ni bajty
; (jedním writeMemory), program je pošle do UART a `tx_len` vynuluje. Všechno, co z UART přijde,
; připisuje do `rx_buf` a počítá v `rx_len` (16 bitů, nejvýš RX_MAX bajtů).
; Porty: $133B zápis = vysílaný bajt, čtení = stav (bit 0 přijatý bajt, bit 1 plný vysílač),
; $143B čtení = přijatý bajt; $153B bit 6 = 0 vybírá UART 0 (ESP).
        DEVICE ZXSPECTRUMNEXT
UART_TX     equ $133B
UART_RX     equ $143B
UART_SEL    equ $153B
RX_MAX      equ $4000

        ORG $8000
start:  di
        ld sp, stack_top
        nextreg $07, 3          ; 28 MHz
        ld bc, UART_SEL
        xor a
        out (c), a              ; UART 0 = ESP
        ld hl, 0
        ld (tx_len), hl
        ld (tx_pos), hl
        ld (rx_len), hl
loop:   ld bc, UART_TX
        in a, (c)
        rra                     ; bit 0: přijatý bajt?
        jr nc, .send
        ld bc, UART_RX
        in e, (c)
        ld hl, (rx_len)
        ld a, h
        cp high RX_MAX
        jr nc, loop             ; plný buffer: bajt zahodit
        push hl
        ld bc, rx_buf
        add hl, bc
        ld (hl), e
        pop hl
        inc hl
        ld (rx_len), hl
        jr loop
.send:  ld hl, (tx_len)
        ld a, h
        or l
        jr z, loop
        ld de, (tx_pos)
        or a
        sbc hl, de
        jr nz, .byte
        ld (tx_len), hl         ; vše odesláno: HL = 0
        ld (tx_pos), hl
        jr loop
.byte:  in a, (c)               ; BC = UART_TX
        and 2                   ; vysílač plný?
        jr nz, loop
        ld hl, tx_buf
        add hl, de
        ld a, (hl)
        out (c), a
        inc de
        ld (tx_pos), de
        jr loop

tx_pos:     dw 0
rx_len:     dw 0
            ds 64
stack_top:
tx_len:     dw 0                ; hned za ním tx_buf (test zapisuje obojí najednou)
tx_buf:     ds 1024
            ALIGN 256
rx_buf:     ds RX_MAX

        SAVENEX OPEN "uart.nex", start, stack_top
        SAVENEX CORE 3, 0, 0
        SAVENEX AUTO
        SAVENEX CLOSE
