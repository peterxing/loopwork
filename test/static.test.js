'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { build, assertSafeOut, normalizeBaseUrl } = require('../scripts/build-static.js');

const ROOT = path.join(__dirname, '..');

test('static build runs in-browser, keeps asset paths relative and adds link-preview tags', () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'loopwork-site-'));
  try {
    const res = build(out, { baseUrl: 'https://example.github.io/loopwork' });
    assert.equal(res.baseUrl, 'https://example.github.io/loopwork/');
    const html = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
    assert.match(html, /<meta name="loopwork-mode" content="static">/);
    assert.match(html, /<meta property="og:image" content="https:\/\/example\.github\.io\/loopwork\/og-image\.png">/);
    assert.match(html, /<link rel="canonical" href="https:\/\/example\.github\.io\/loopwork\/">/);
    const scripts = Array.from(html.matchAll(/<script src="([^"]+)"/g), (m) => m[1]);
    assert.ok(scripts.length >= 10, 'all app scripts are referenced');
    for (const src of scripts) {
      assert.doesNotMatch(src, /^(\/|[a-z]+:)/i, 'project Pages sites live under /<repo>/, so paths must be relative: ' + src);
      assert.ok(fs.existsSync(path.join(out, src)), 'missing ' + src);
    }
    assert.ok(fs.existsSync(path.join(out, 'og-image.png')));
    assert.ok(fs.existsSync(path.join(out, '.nojekyll')));
    const source = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
    assert.doesNotMatch(source, /loopwork-mode/, 'the server copy keeps looking for the live server');
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test('static build refuses unsafe output folders and base URLs', () => {
  assert.throws(() => assertSafeOut(path.join(ROOT, 'public')));
  assert.throws(() => assertSafeOut(path.join(ROOT, 'public', 'sub')));
  assert.throws(() => assertSafeOut(ROOT));
  assert.throws(() => assertSafeOut(path.parse(ROOT).root));
  assert.equal(assertSafeOut(path.join(ROOT, '_site')), path.join(ROOT, '_site'));
  assert.throws(() => normalizeBaseUrl('javascript:alert(1)'));
  assert.throws(() => normalizeBaseUrl('https://x.io/"><script>'));
  assert.equal(normalizeBaseUrl(''), null);
});
