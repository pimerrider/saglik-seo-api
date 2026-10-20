'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const code = fs.readFileSync(require('node:path').join(__dirname, '..', 'index.js'), 'utf8');
// GitHub checkout can preserve Windows CRLF; normalize only for source extraction.
const source = code.replace(/\r\n/g, '\n');

// Exercise the actual production function, not a reimplementation.
const fnSource = source.match(/function normalizedPagePath\(value\) \{[\s\S]*?\n\}/)?.[0];
assert.ok(fnSource, 'normalizedPagePath source missing');
const normalize = vm.runInNewContext(fnSource + '\nnormalizedPagePath;', { URL, decodeURI });

test('GSC full URL matches GA4 landing path', () => {
  assert.equal(normalize('https://turkishdishes.net/recipes/menemen/?utm_source=google'), '/recipes/menemen');
  assert.equal(normalize('/recipes/menemen?source=organic'), '/recipes/menemen');
});

test('different paths stay different', () => {
  assert.notEqual(normalize('/recipes/menemen'), normalize('/recipes/mercimek-soup'));
});

test('missing GA4 path does not become a real page', () => {
  assert.equal(normalize('(not set)'), '');
  assert.equal(normalize(''), '');
});

const verdictSource = source.match(/if \(impressions === 0 && clicks === 0\) \{[\s\S]*?\n    \}\n\n    const actionList/)?.[0];
assert.ok(verdictSource, 'revision decision block missing');
const decisionCode = verdictSource.replace(/\n\n    const actionList$/, '');
const choose = new Function('impressions', 'clicks', 'score',
  "let decision, worthRevising;\n" + decisionCode + "\nreturn { decision, worthRevising };");

test('zero GSC evidence never recommends deletion', () => {
  assert.deepEqual(choose(0, 0, 20), {decision:'needs_investigation', worthRevising:false});
});

test('regular scoring branches are preserved', () => {
  assert.equal(choose(250, 12, 85).decision, 'keep_as_is');
  assert.equal(choose(250, 12, 65).decision, 'refresh');
  assert.equal(choose(250, 12, 45).decision, 'revise');
  assert.equal(choose(250, 12, 25).decision, 'rewrite');
});

test('site summary distinguishes sampled GSC rows from indexed pages', () => {
  assert.match(source, /gscPageRowCount:content\.length/);
  assert.match(source, /indexedPageCount is a legacy alias of gscPageRowCount/);
  assert.match(source, /Dead pages here means sitemap URLs absent from the sampled GSC page rows/);
});
