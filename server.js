'use strict';
/**
 * LoopWork server: zero-dependency Node HTTP server.
 *  - Serves the web app from ./public
 *  - Exposes the platform API (routes are defined once in public/lib/engine.js)
 *  - Is the authoritative copy of the state: it re-simulates every teleop submission,
 *    prices bounties, settles pay and pays data dividends.
 *  - Persists state as JSON outside the project folder (~/.loopwork/state.json by default).
 *  - Hosts the simulated BNB Smart Chain used by the THC demo wallet (POST /api/chain/rpc) and,
 *    when settling, dropping or re-sending THC payments, looks up their transactions on-chain itself
 *    (never trusting the client).
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const Engine = require('./public/lib/engine.js');
const Thc = require('./public/lib/thc.js');
const LoopChain = require('./public/lib/chain.js');

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

/**
 * Receipt of a real BNB Smart Chain transaction from public RPCs (null while still pending), with its
 * block time. With { pending: true }, a transaction the network still holds unmined comes back as
 * { pending: true } instead of null.
 */
async function fetchBscReceipt(hash, fetchImpl, opts) {
  const doFetch = fetchImpl || fetch;
  let lastError = null;
  for (const url of Thc.NETWORKS.bsc.rpc) {
    try {
      const call = async function (method, params) {
        const res = await doFetch(url, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: method, params: params }),
          signal: AbortSignal.timeout(8000),
        });
        const j = await res.json();
        if (j.error) throw new Error(j.error.message || 'RPC error');
        return j.result;
      };
      const receipt = await call('eth_getTransactionReceipt', [hash]);
      if (receipt && receipt.blockNumber && !receipt.blockTimestamp) {
        // The time check ("sent after the request was made") needs the block's timestamp.
        try { const block = await call('eth_getBlockByNumber', [receipt.blockNumber, false]); if (block && block.timestamp) receipt.blockTimestamp = block.timestamp; } catch (e) { /* time stays unknown */ }
      }
      if (!receipt && opts && opts.pending && (await call('eth_getTransactionByHash', [hash]))) return { pending: true, transactionHash: hash };
      return receipt || null;
    } catch (e) { lastError = e; }
  }
  throw Object.assign(new Error('Could not reach BNB Smart Chain to check the transaction (' + (lastError ? lastError.message : 'no RPC') + ')'), { status: 502 });
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

/** Create (but don't start) a LoopWork server. Options: { dataDir, reset, seed, log, fetchBscReceipt }. */
function createServer(opts) {
  opts = opts || {};
  const dataDir = opts.dataDir || process.env.LOOPWORK_DATA || path.join(os.homedir(), '.loopwork');
  const stateFile = path.join(dataDir, 'state.json');
  const chainFile = path.join(dataDir, 'chain.json');
  const logger = opts.log === false ? function () {} : console.log;
  const bscReceipt = opts.fetchBscReceipt || fetchBscReceipt;

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
  function loadChain() {
    if (!opts.reset) {
      try {
        const c = JSON.parse(fs.readFileSync(chainFile, 'utf8'));
        if (c && c.schema === LoopChain.SCHEMA) return c;
      } catch (e) {
        if (e.code !== 'ENOENT') logger('Could not read the simulated chain (' + e.message + '); starting a fresh one.');
      }
    }
    return LoopChain.createState();
  }

  const box = { state: load(), rt: Engine.createRuntime() };
  let chain = new LoopChain.Chain(loadChain());
  let timer = null;

  function writeAtomic(file, obj) {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj));
    fs.renameSync(tmp, file);
  }
  function save() {
    fs.mkdirSync(dataDir, { recursive: true });
    writeAtomic(stateFile, box.state);
    writeAtomic(chainFile, chain.s);
  }
  function scheduleSave() {
    clearTimeout(timer);
    timer = setTimeout(function () {
      try { save(); } catch (e) { console.error('Failed to save state:', e.message); }
    }, 150);
  }
  function flush() { clearTimeout(timer); save(); }
  save();

  /** JSON-RPC for the simulated chain (what the built-in demo wallet talks to in server mode). */
  async function chainRpc(req, res) {
    let body;
    try { body = await readBody(req); } catch (e) { return sendJson(res, e.status || 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: e.message } }); }
    const id = body.id === undefined ? null : body.id;
    try {
      const result = chain.rpc(body, Date.now());
      if (LoopChain.isMutating(body.method)) scheduleSave();
      return sendJson(res, 200, { jsonrpc: '2.0', id: id, result: result === undefined ? null : result });
    } catch (e) {
      return sendJson(res, 200, { jsonrpc: '2.0', id: id, error: { code: typeof e.code === 'number' ? e.code : -32000, message: e.message } });
    }
  }

  const server = http.createServer(async function (req, res) {
    let url;
    try { url = new URL(req.url, 'http://localhost'); } catch (e) { return sendJson(res, 400, { error: 'Bad URL' }); }
    if (url.pathname === '/api/chain/rpc' && req.method === 'POST') return chainRpc(req, res);
    if (url.pathname.startsWith('/api/')) {
      const match = Engine.matchRoute(req.method, url.pathname);
      if (!match) return sendJson(res, 404, { error: 'No such endpoint: ' + req.method + ' ' + url.pathname });
      try {
        const body = req.method === 'GET' ? {} : await readBody(req);
        const query = {};
        url.searchParams.forEach(function (v, k) { query[k] = v; });
        const args = Object.assign({}, query, body, match.params);
        const op = match.route.op;
        const needsChain = op === 'settleThc' || (args.refType === 'payout' && (op === 'dropThcTx' || (op === 'startThcTx' && args.resend === true)));
        if (needsChain) {
          // What the chain says about a record's transactions always comes from the chain itself, never from
          // the client: the receipt of every transaction recorded against it (and, before dropping or sending
          // again, whether BNB Smart Chain still holds one unmined).
          const rec = Engine.thcRecord(box, args.refType, args.refId);
          delete args.receipt; delete args.txHash;
          const hashes = Engine.claimedHashes(rec); // at most a handful per record, looked up in parallel
          const seen = await Promise.all(hashes.map(function (h) {
            return rec.network === 'sim' ? chain.receipt(h) : bscReceipt(h, undefined, { pending: op !== 'settleThc' });
          }));
          args.chain = {};
          hashes.forEach(function (h, i) { args.chain[h] = seen[i]; });
        } else if (op === 'submitThcTx') {
          // Past the per-record limit, a new transaction is only recorded once the chain shows it arrived.
          delete args.proof;
          const rec = Engine.thcRecord(box, args.refType, args.refId);
          const claimed = Engine.claimedHashes(rec);
          const h = String(args.txHash || '').toLowerCase();
          if (Thc.isTxHash(h) && claimed.indexOf(h) < 0 && claimed.length >= Engine.MAX_TX_PER_RECORD) {
            args.proof = rec.network === 'sim' ? chain.receipt(h) : await bscReceipt(h);
          }
        }
        const result = Engine.dispatch(box, op, args, { now: Date.now(), trusted: false });
        if (op === 'reset') chain = new LoopChain.Chain(LoopChain.createState());
        if (match.route.method !== 'GET') scheduleSave();
        return sendJson(res, 200, result);
      } catch (e) {
        const status = e.status || 500;
        if (status >= 500 && status !== 502) console.error(e);
        return sendJson(res, status, { error: status >= 500 && status !== 502 ? 'Internal error: ' + e.message : e.message });
      }
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'Method not allowed' });
    serveStatic(req, res, url.pathname);
  });

  return { server: server, box: box, save: save, flush: flush, stateFile: stateFile, chain: function () { return chain; } };
}

module.exports = { createServer: createServer, fetchBscReceipt: fetchBscReceipt };

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
