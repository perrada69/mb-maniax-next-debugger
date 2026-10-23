# MB Maniax – náhrada SDL3 pro ladicí server (find_package(SDL3) v JNEXT míří sem přes SDL3_DIR).
# Jádro JNEXT z SDL3 potřebuje jen typy, kódy kláves a pár funkcí pro joysticky; okno, zvuk
# i ovladače obsluhuje rozšíření VS Code, takže skutečná knihovna SDL3 není potřeba.
# Hlavičky SDL3 (licence zlib) připraví build.ps1 do .dev/next/sdl3/include.

if(NOT JNEXT_SDL3_INCLUDE OR NOT EXISTS "${JNEXT_SDL3_INCLUDE}/SDL3/SDL.h")
    message(FATAL_ERROR "Chybí hlavičky SDL3 (JNEXT_SDL3_INCLUDE='${JNEXT_SDL3_INCLUDE}') – spusť build.ps1")
endif()

if(NOT TARGET SDL3::SDL3)
    add_library(jnext_sdl3_stub STATIC "${CMAKE_CURRENT_LIST_DIR}/sdl3_stub.c")
    target_include_directories(jnext_sdl3_stub PUBLIC "${JNEXT_SDL3_INCLUDE}")
    add_library(SDL3::SDL3 ALIAS jnext_sdl3_stub)
endif()
set(SDL3_FOUND TRUE)
