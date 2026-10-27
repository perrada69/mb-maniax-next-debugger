# MB Maniax Next Debugger – ladicí server: jádro JNEXT bez okna, ovládané rozšířením VS Code.
# Přidává ho kořenový CMakeLists.txt JNEXT (jnext.patch) přes -DJNEXT_SERVER_DIR=<tato složka>;
# celé sestavení zařídí build.ps1 v kořeni repozitáře.

add_executable(mbx-next-server main.cpp card.cpp esp_tap.cpp)
target_link_libraries(mbx-next-server PRIVATE
    jnext_core jnext_cpu jnext_memory
    jnext_video jnext_audio jnext_port
    jnext_peripheral jnext_input
    jnext_save jnext_debug jnext_script jnext_profiler
    ${JNEXT_SDL3_TARGET})
if(WIN32)
    target_link_libraries(mbx-next-server PRIVATE winmm)
endif()
target_include_directories(mbx-next-server PRIVATE ${CMAKE_SOURCE_DIR} ${CMAKE_SOURCE_DIR}/src "${CMAKE_BINARY_DIR}/generated")
set_target_properties(mbx-next-server PROPERTIES RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/bin")
