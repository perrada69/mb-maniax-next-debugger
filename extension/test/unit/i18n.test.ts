// Překlady: výběr jazyka a dosazování parametrů (src/i18n.ts).
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { matchLanguage, setLanguage, t } from '../../src/i18n';

test('matchLanguage rozpozná locale', () => {
    assert.equal(matchLanguage('cs-CZ'), 'cs');
    assert.equal(matchLanguage('pt_BR'), 'pt-br');
    assert.equal(matchLanguage('zh-Hans'), 'zh-cn');
    assert.equal(matchLanguage('xx'), undefined);
});

test('setLanguage: nastavení má přednost, angličtina editoru se přeskočí', () => {
    assert.equal(setLanguage('de', 'cs'), 'de');
    assert.equal(setLanguage('auto', 'fr'), 'fr');
    process.env.LANG = 'sk_SK.UTF-8';
    assert.equal(setLanguage('auto', 'en'), 'sk');
});

test('t dosadí parametry a bez překladu vrátí klíč', () => {
    setLanguage('en');
    assert.equal(t('neexistuje.klic'), 'neexistuje.klic');
    assert.match(t('session.serverNotFound', 'X'), /X/);
});
