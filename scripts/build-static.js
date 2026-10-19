#!/usr/bin/env node
'use strict';
/**
 * Builds the public static site (GitHub Pages). It is a copy of public/ switched to
 * in-browser mode: the whole platform (engine, "server", fleet) runs in each visitor's
 * browser, with state kept in their localStorage, so no server is involved.
 *
 *   node scripts/build-static.js [outDir] [--base-url=https://user.github.io/repo/]
 *
 * --base-url adds the absolute canonical, og:url and og:image tags that link previews need.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'public');
const OG_IMAGE = path.join(ROOT, 'docs', 'overview.png');
const MARKER = '<meta charset="UTF-8">';

/** Refuse output folders that would delete or recurse into the source tree. */
function assertSafeOut(out) {
  const p = path.resolve(out);
  const inside = function (child, parent) { return child === parent || child.startsWith(parent + path.sep); };
  if (inside(SRC, p) || inside(p, SRC) || p === ROOT || p === path.parse(p).root) {
    throw new Error('Refusing to build into ' + p);
  }
  return p;
}

function normalizeBaseUrl(url) {
  if (url == null || url === '') return null;
  const s = String(url).trim();
  if (!/^https?:\/\/[^\s"'<>`]+$/i.test(s)) throw new Error('--base-url must be an http(s) URL, got: ' + s);
  return s.replace(/\/?$/, '/');
}

function build(outDir, opts) {
  opts = opts || {};
  const base = normalizeBaseUrl(opts.baseUrl);
  const out = assertSafeOut(outDir || path.join(ROOT, '_site'));
  fs.rmSync(out, { recursive: true, force: true });
  fs.cpSync(SRC, out, { recursive: true });
  fs.writeFileSync(path.join(out, '.nojekyll'), '');
  if (fs.existsSync(OG_IMAGE)) fs.copyFileSync(OG_IMAGE, path.join(out, 'og-image.png'));

  const indexPath = path.join(out, 'index.html');
  let html = fs.readFileSync(indexPath, 'utf8');
  if (html.indexOf(MARKER) < 0) throw new Error('public/index.html is missing ' + MARKER);
  const tags = ['<meta name="loopwork-mode" content="static">'];
  if (base) {
    tags.push('<link rel="canonical" href="' + base + '">');
    tags.push('<meta property="og:url" content="' + base + '">');
    tags.push('<meta property="og:image" content="' + base + 'og-image.png">');
    tags.push('<meta name="twitter:image" content="' + base + 'og-image.png">');
  }
  html = html.replace(MARKER, MARKER + '\n' + tags.join('\n'));
  fs.writeFileSync(indexPath, html);
  return { out: out, baseUrl: base };
}

module.exports = { build: build, assertSafeOut: assertSafeOut, normalizeBaseUrl: normalizeBaseUrl };

if (require.main === module) {
  const args = process.argv.slice(2);
  const flag = args.find(function (a) { return a.indexOf('--base-url=') === 0; });
  const outDir = args.find(function (a) { return a.indexOf('--') !== 0; });
  try {
    const res = build(outDir, { baseUrl: flag ? flag.slice('--base-url='.length) : null });
    console.log('Static site built in ' + res.out + (res.baseUrl ? ' for ' + res.baseUrl : ''));
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
