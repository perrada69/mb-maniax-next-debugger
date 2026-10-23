// Uživatelská příručka (PDF) přibalená k rozšíření: manual/MB-Maniax-Next-Debugger-manual-<cs|en>.pdf
// (build.ps1 -Balicek ji tam zkopíruje z docs/manual/out). Otevře se ve výchozím prohlížeči PDF.

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { language, t } from './i18n';

/** Příručka existuje česky a anglicky: čeština i pro slovenštinu, jinak angličtina. */
export function manualLanguage(lang: string): 'cs' | 'en' {
    return lang === 'cs' || lang === 'sk' ? 'cs' : 'en';
}

/** Cesta k PDF v jazyce rozšíření; když chybí, zkusí druhý jazyk; nic → undefined. */
export function manualFile(extensionPath: string, lang: string): string | undefined {
    const first = manualLanguage(lang);
    for (const l of [first, first === 'cs' ? 'en' : 'cs']) {
        const p = path.join(extensionPath, 'manual', `MB-Maniax-Next-Debugger-manual-${l}.pdf`);
        if (fs.existsSync(p)) return p;
    }
    return undefined;
}

export async function openManual(extensionPath: string): Promise<void> {
    const file = manualFile(extensionPath, language());
    if (!file) {
        void vscode.window.showWarningMessage(t('extension.manualMissing'));
        return;
    }
    await vscode.env.openExternal(vscode.Uri.file(file));
}
