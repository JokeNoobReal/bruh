// test/glossary.test.js — Integration & Unit Tests for Glossary Module
import test from 'node:test';
import assert from 'node:assert';
import {
  wordRegex, namesOf, appearsIn, selectRelevant,
  auditGlossary, enforceHard, checkLength
} from '../services/glossary.js';

test('wordRegex creates valid unicode-aware boundary matching', () => {
  const re = wordRegex('Sunny', 'gi');
  assert.strictEqual(re.test('Sunny is sleeping'), true);
  assert.strictEqual(re.test('Sunless'), false);
});

test('appearsIn detects term in text correctly', () => {
  const term = { id: 't1', en: 'Sunny', vi: 'Sunny', aliases: ['Sunless'] };
  assert.strictEqual(appearsIn('Sunny woke up early.', term), true);
  assert.strictEqual(appearsIn('Sunless woke up early.', term), true);
  assert.strictEqual(appearsIn('Jack woke up early.', term), false);
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

  const { terms, honorifics } = selectRelevant(glossary, 'Sunny met Nephis at the Forgotten Shore.');
  assert.strictEqual(terms.length, 3);
  assert.strictEqual(honorifics.length, 1);
});

test('auditGlossary flags missing term translations', () => {
  const terms = [{ id: 't1', en: 'Shadow Slave', vi: 'Nô Lệ Bóng Tối', type: 'title' }];
  const source = 'He became a Shadow Slave.';
  const translatedFail = 'Anh ấy trở thành một người làm bóng.';
  const translatedPass = 'Anh ấy trở thành một Nô Lệ Bóng Tối.';

  assert.strictEqual(auditGlossary(source, translatedFail, terms).length, 1);
  assert.strictEqual(auditGlossary(source, translatedPass, terms).length, 0);
});

test('enforceHard replaces missing 1:1 proper nouns', () => {
  const violations = [{ id: 't1', en: 'Shadow Slave', vi: 'Nô Lệ Bóng Tối', type: 'title' }];
  const result = enforceHard('Anh ấy trở thành Shadow Slave.', violations);
  assert.strictEqual(result.text.includes('Nô Lệ Bóng Tối'), true);
});

test('checkLength detects swallowed output', () => {
  const source = 'A very long text sentence '.repeat(20);
  const shortTranslation = 'Ngắn.';
  assert.strictEqual(checkLength(source, shortTranslation).ok, false);
});
