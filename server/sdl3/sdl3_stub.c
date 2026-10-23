/*
 * MB Maniax – náhrada funkcí SDL3, které volá jádro JNEXT (výběr joysticku).
 * V ladicím serveru se SDL neinicializuje: joysticky „nejsou“, ovládání posílá rozšíření VS Code.
 *
 * Copyright (C) 2026 MB Maniax. Licence GNU GPL 3 nebo novější (stejně jako JNEXT).
 */
#include <SDL3/SDL.h>
#include <stdlib.h>
#include <string.h>

const char *SDL_GetError(void) { return "SDL is not available in the debugger server"; }
void SDL_free(void *mem) { free(mem); }

SDL_JoystickID *SDL_GetJoysticks(int *count)
{
    if (count) *count = 0;
    return (SDL_JoystickID *)calloc(1, sizeof(SDL_JoystickID));
}
SDL_JoystickID SDL_AttachVirtualJoystick(const SDL_VirtualJoystickDesc *desc) { (void)desc; return 0; }
bool SDL_IsGamepad(SDL_JoystickID id) { (void)id; return false; }
bool SDL_IsJoystickVirtual(SDL_JoystickID id) { (void)id; return false; }
SDL_Gamepad *SDL_OpenGamepad(SDL_JoystickID id) { (void)id; return NULL; }
SDL_Joystick *SDL_OpenJoystick(SDL_JoystickID id) { (void)id; return NULL; }
void SDL_CloseGamepad(SDL_Gamepad *gamepad) { (void)gamepad; }
void SDL_CloseJoystick(SDL_Joystick *joystick) { (void)joystick; }
SDL_Joystick *SDL_GetGamepadJoystick(SDL_Gamepad *gamepad) { (void)gamepad; return NULL; }
SDL_JoystickID SDL_GetJoystickID(SDL_Joystick *joystick) { (void)joystick; return 0; }
const char *SDL_GetJoystickNameForID(SDL_JoystickID id) { (void)id; return NULL; }
int SDL_GetNumJoystickAxes(SDL_Joystick *joystick) { (void)joystick; return -1; }
int SDL_GetNumJoystickButtons(SDL_Joystick *joystick) { (void)joystick; return -1; }
int SDL_GetNumJoystickHats(SDL_Joystick *joystick) { (void)joystick; return -1; }

SDL_GUID SDL_GetJoystickGUIDForID(SDL_JoystickID id)
{
    SDL_GUID guid;
    (void)id;
    memset(&guid, 0, sizeof(guid));
    return guid;
}

void SDL_GUIDToString(SDL_GUID guid, char *pszGUID, int cbGUID)
{
    static const char hex[] = "0123456789abcdef";
    int i;
    if (!pszGUID || cbGUID <= 0) return;
    for (i = 0; i < 16 && i * 2 + 2 < cbGUID; ++i) {
        pszGUID[i * 2] = hex[guid.data[i] >> 4];
        pszGUID[i * 2 + 1] = hex[guid.data[i] & 15];
    }
    pszGUID[i * 2] = '\0';
}
