'use strict';
/**
 * LoopWork server: zero-dependency Node HTTP server.
 *  - Serves the web app from ./public
 *  - Exposes the platform API (routes are defined once in public/lib/engine.js)
 *  - Is the authoritative copy of the state: it re-simulates every teleop submission,
 *    prices bounties, settles pay and pays data dividends.
 *  - Persists state as JSON outside the project folder (~/.loopwork/state.json by default).
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const Engine = require('./public/lib/engine.js');

const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_BODY = 1024 * 1024;
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
};

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body), 'X-Content-Type-Options': 'nosniff' });
  res.end(body);
}

function readBody(req) {
  return new Promise(function (resolve, reject) {
    let size = 0;
    const chunks = [];
    req.on('data', function (c) {
      size += c.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error('Request body too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', function () {
      if (!chunks.length) return resolve({});
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolve(v && typeof v === 'object' && !Array.isArray(v) ? v : {});
      } catch (e) { reject(Object.assign(new Error('Invalid JSON body'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res, pathname) {
  let rel;
  try { rel = decodeURIComponent(pathname); } catch (e) { return sendJson(res, 400, { error: 'Bad path' }); }
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (file !== PUBLIC_DIR && !file.startsWith(PUBLIC_DIR + path.sep)) return sendJson(res, 403, { error: 'Forbidden' });
  fs.stat(file, function (err, st) {
    if (err || !st.isFile()) return sendJson(res, 404, { error: 'Not found' });
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': st.size, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff',
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

/** Create (but don't start) a LoopWork server. Options: { dataDir, reset, seed, log }. */
function createServer(opts) {
  opts = opts || {};
  const dataDir = opts.dataDir || process.env.LOOPWORK_DATA || path.join(os.homedir(), '.loopwork');
  const stateFile = path.join(dataDir, 'state.json');
  const logger = opts.log === false ? function () {} : console.log;

  function load() {
    if (!opts.reset) {
      try {
        const s = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
        if (s && s.schema === Engine.SCHEMA) return s;
        logger('Saved state uses an older schema; starting a fresh demo.');
      } catch (e) {
        if (e.code !== 'ENOENT') logger('Could not read saved state (' + e.message + '); starting a fresh demo.');
      }
    }
    return Engine.createState({ seed: opts.seed });
  }

  const box = { state: load(), rt: Engine.createRuntime() };
  let timer = null;

  function save() {
    fs.mkdirSync(dataDir, { recursive: true });
    const tmp = stateFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(box.state));
    fs.renameSync(tmp, stateFile);
  }
  function scheduleSave() {
    clearTimeout(timer);
    timer = setTimeout(function () {
      try { save(); } catch (e) { console.error('Failed to save state:', e.message); }
    }, 150);
  }
  function flush() { clearTimeout(timer); save(); }
  save();

  const server = http.createServer(async function (req, res) {
    let url;
    try { url = new URL(req.url, 'http://localhost'); } catch (e) { return sendJson(res, 400, { error: 'Bad URL' }); }
    if (url.pathname.startsWith('/api/')) {
      const match = Engine.matchRoute(req.method, url.pathname);
      if (!match) return sendJson(res, 404, { error: 'No such endpoint: ' + req.method + ' ' + url.pathname });
      try {
        const body = req.method === 'GET' ? {} : await readBody(req);
        const query = {};
        url.searchParams.forEach(function (v, k) { query[k] = v; });
        const args = Object.assign({}, query, body, match.params);
        const result = Engine.dispatch(box, match.route.op, args, { now: Date.now(), trusted: false });
        if (match.route.method !== 'GET') scheduleSave();
        return sendJson(res, 200, result);
      } catch (e) {
        const status = e.status || 500;
        if (status >= 500) console.error(e);
        return sendJson(res, status, { error: status >= 500 ? 'Internal error: ' + e.message : e.message });
      }
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'Method not allowed' });
    serveStatic(req, res, url.pathname);
  });

  return { server: server, box: box, save: save, flush: flush, stateFile: stateFile };
}

module.exports = { createServer: createServer };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const arg = function (name) { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };
  const port = Number(arg('--port') || process.env.PORT || 8787);
  const host = process.env.HOST || '127.0.0.1';
  const app = createServer({ reset: argv.indexOf('--reset') >= 0 });
  app.server.listen(port, host, function () {
    console.log('LoopWork is running at http://' + (host === '0.0.0.0' ? 'localhost' : host) + ':' + port);
    console.log('State file: ' + app.stateFile + '   (start with --reset for a fresh demo)');
  });
  const stop = function () {
    try { app.flush(); } catch (e) { console.error('Failed to save on exit:', e.message); }
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
