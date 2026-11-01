'use strict';

// One test per translated file/language is generated from the repo's files while the suite loads.
/* eslint-disable mocha/no-setup-in-describe */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const LANGUAGES = ['en', 'de', 'sv', 'nl', 'no'];

function readJson(...parts) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, ...parts), 'utf8'));
}

function listJsonFiles(dir) {
  const result = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) result.push(...listJsonFiles(full));
    else if (entry.name.endsWith('.json')) result.push(full);
  }
  return result;
}

// Everything in a compose file that looks like { en: "...", de: "..." } (or the tags arrays).
function collectTranslations(node, trail, found) {
  if (Array.isArray(node)) {
    node.forEach((item, i) => collectTranslations(item, `${trail}[${i}]`, found));
  } else if (node && typeof node === 'object') {
    if (typeof node.en === 'string' || Array.isArray(node.en)) found.push({ trail, value: node });
    else Object.entries(node).forEach(([k, v]) => collectTranslations(v, `${trail}.${k}`, found));
  }
  return found;
}

const tokens = (text, pattern) => (String(text).match(pattern) || []).sort().join(',');

describe('compose files (flow cards, capabilities, driver, widget, app)', () => {
  const files = [
    ...listJsonFiles(path.join(ROOT, '.homeycompose')),
    path.join(ROOT, 'drivers', 'watchdog', 'driver.compose.json'),
    path.join(ROOT, 'widgets', 'status', 'widget.compose.json'),
  ];

  for (const file of files) {
    const relative = path.relative(ROOT, file);
    const found = collectTranslations(JSON.parse(fs.readFileSync(file, 'utf8')), '', []);
    if (!found.length) continue;

    test(`${relative}: every text exists in all five languages`, () => {
      for (const { trail, value } of found) {
        for (const lang of LANGUAGES) {
          assert.ok(lang in value, `${trail || '(root)'} is missing "${lang}"`);
          if (typeof value.en === 'string') {
            assert.equal(typeof value[lang], 'string', `${trail} "${lang}" is not a string`);
            if (value.en !== '') assert.notEqual(value[lang], '', `${trail} "${lang}" is empty`);
          } else {
            assert.ok(Array.isArray(value[lang]) && value[lang].length > 0, `${trail} "${lang}" has no entries`);
          }
        }
      }
    });

    test(`${relative}: [[tokens]] and !{{a|b}} switches match the English text`, () => {
      for (const { trail, value } of found) {
        if (typeof value.en !== 'string') continue;
        for (const lang of LANGUAGES) {
          assert.equal(tokens(value[lang], /\[\[[^\]]+\]\]/g), tokens(value.en, /\[\[[^\]]+\]\]/g), `${trail} "${lang}": [[tokens]]`);
          const switches = (text) => (String(text).match(/!\{\{[^}]*\}\}/g) || []).map((s) => s.split('|').length).join(',');
          assert.equal(switches(value[lang]), switches(value.en), `${trail} "${lang}": !{{a|b}}`);
        }
      }
    });
  }
});

describe('locales/*.json (settings page, widget, backend texts)', () => {
  const flatten = (obj, prefix = '') => Object.entries(obj).flatMap(([k, v]) => (
    v && typeof v === 'object' ? flatten(v, `${prefix}${k}.`) : [[`${prefix}${k}`, v]]
  ));
  const english = flatten(readJson('locales', 'en.json'));

  for (const lang of LANGUAGES.filter((l) => l !== 'en')) {
    test(`${lang}.json has exactly the keys of en.json, none empty`, () => {
      const other = new Map(flatten(readJson('locales', `${lang}.json`)));
      const missing = english.filter(([key]) => !other.has(key)).map(([key]) => key);
      const extra = [...other.keys()].filter((key) => !english.some(([k]) => k === key));
      assert.deepEqual(missing, [], `missing in ${lang}.json`);
      assert.deepEqual(extra, [], `extra in ${lang}.json`);
      for (const [key, value] of english) {
        if (value !== '') assert.notEqual(other.get(key), '', `${lang}.json "${key}" is empty`);
      }
    });

    test(`${lang}.json keeps the __placeholders__ of en.json`, () => {
      const other = new Map(flatten(readJson('locales', `${lang}.json`)));
      for (const [key, value] of english) {
        assert.equal(tokens(other.get(key), /__[A-Za-z]+__/g), tokens(value, /__[A-Za-z]+__/g), `${lang}.json "${key}"`);
      }
    });
  }
});

describe('store texts and changelog', () => {
  test('there is a README for every language', () => {
    for (const lang of LANGUAGES) {
      const file = lang === 'en' ? 'README.txt' : `README.${lang}.txt`;
      assert.ok(fs.existsSync(path.join(ROOT, file)), `${file} is missing`);
    }
  });

  test('the newest changelog entry is written in all five languages', () => {
    const changelog = readJson('.homeychangelog.json');
    const newest = Object.keys(changelog)[0];
    for (const lang of LANGUAGES) {
      assert.ok(changelog[newest][lang], `changelog ${newest} is missing "${lang}"`);
    }
  });

  test('the newest changelog entry is the app version', () => {
    const changelog = readJson('.homeychangelog.json');
    assert.equal(Object.keys(changelog)[0], readJson('.homeycompose', 'app.json').version);
  });
});
