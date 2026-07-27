// test/glossary.test.js — Regression & Unit Test Suite
import test from 'node:test';
import assert from 'node:assert/strict';
import * as G from '../services/glossary.js';

test('glossary exports required helpers', () => {
  for (const name of [
    'wordRegex', 'namesOf', 'appearsIn', 'selectRelevant',
    'auditGlossary', 'enforceHard', 'checkLength', 'loadGlossary', 'saveGlossary'
  ]) {
    assert.equal(typeof G[name], 'function', `${name} must be exported`);
  }
});

test('wordRegex handles Vietnamese Unicode boundaries', () => {
  const re = G.wordRegex('Bóng Tối', 'i');
  assert.equal(re.test('Nô lệ Bóng Tối xuất hiện.'), true);
  assert.equal(re.test('Bóng Tối hóa'), true);
  assert.equal(re.test('SiêuBóng Tối'), false);
});

test('wordRegex boundary matching independence', () => {
  const re = G.wordRegex('Sunny', 'gi');
  assert.equal(re.test('Sunny is sleeping'), true);
  assert.equal(re.test('Sunless'), false);
});

test('appearsIn detects term in text correctly for en and aliases', () => {
  const term = { id: 't1', en: 'Sunny', vi: 'Sunny', aliases: ['Sunless'] };
  assert.equal(G.appearsIn('Sunny woke up early.', term), true);
  assert.equal(G.appearsIn('Sunless woke up early.', term), true);
  assert.equal(G.appearsIn('Jack woke up early.', term), false);
});

test('selectRelevant picks matching terms for prompt', () => {
  const glossary = {
    terms: [
      { id: 't1', en: 'Sunny', vi: 'Sunny', type: 'character', count: 100 },
      { id: 't2', en: 'Nephis', vi: 'Nephis', type: 'character', count: 90 },
      { id: 't3', en: 'Forgotten Shore', vi: 'Bờ Quên', type: 'place', count: 10 }
    ],
    honorifics: [
      { a: 'Sunny', b: 'Nephis', aSelf: 'tôi', aCallsB: 'cậu', bSelf: 'tôi', bCallsA: 'cậu', stage: 'đồng minh' }
    ]
  };

  const { terms, honorifics } = G.selectRelevant(glossary, 'Sunny met Nephis at the Forgotten Shore.');
  assert.equal(terms.length, 3);
  assert.equal(honorifics.length, 1);
});

test('auditGlossary flags missing term translations', () => {
  const terms = [{ id: 't1', en: 'Shadow Slave', vi: 'Nô Lệ Bóng Tối', type: 'title' }];
  const source = 'He became a Shadow Slave.';
  const translatedFail = 'Anh ấy trở thành một người làm bóng.';
  const translatedPass = 'Anh ấy trở thành một Nô Lệ Bóng Tối.';

  assert.equal(G.auditGlossary(source, translatedFail, terms).length, 1);
  assert.equal(G.auditGlossary(source, translatedPass, terms).length, 0);
});

test('enforceHard replaces missing 1:1 proper nouns', () => {
  const violations = [{ id: 't1', en: 'Shadow Slave', vi: 'Nô Lệ Bóng Tối', type: 'title' }];
  const result = G.enforceHard('Anh ấy trở thành Shadow Slave.', violations);
  assert.equal(result.text.includes('Nô Lệ Bóng Tối'), true);
});

test('checkLength detects swallowed output', () => {
  const source = 'A very long text sentence '.repeat(20);
  const shortTranslation = 'Ngắn.';
  assert.equal(G.checkLength(source, shortTranslation).ok, false);
});

test('loadGlossary returns valid default schema for new series', () => {
  const g = G.loadGlossary('non-existent-series-12345');
  assert.equal(typeof g, 'object');
  assert.equal(Array.isArray(g.terms), true);
  assert.equal(Array.isArray(g.honorifics), true);
});

test('saveGlossary writes atomically and updates version', async () => {
  const g = G.loadGlossary('test-atomic-save');
  g.terms.push({ id: 't1', en: 'Test', vi: 'Thử nghiệm', locked: true });
  const saved = await G.saveGlossary(g);
  assert.equal(saved.version > 0, true);
  assert.equal(saved.updatedAt !== null, true);
});
