// Samostatný ladicí adaptér přes stdin/stdout (bez VS Code a bez obrazovky) – pro testy DAP
// a pro jiné editory. Cesta k serveru v proměnné prostředí MBX_NEXT_SERVER.

import { DebugSession } from '@vscode/debugadapter';
import { NextDebugSession } from './session';

class StandaloneSession extends NextDebugSession {
    constructor() {
        super(process.env.MBX_NEXT_SERVER || '');
    }
}

DebugSession.run(StandaloneSession);
