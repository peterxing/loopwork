/*!
 * LoopWork THC: Transhuman Coin constants and helpers shared by the browser, the server and tests.
 * THC is a BEP-20 token on BNB Smart Chain (chainId 56) at 0x56083560594e314b5cdd1680ec6a493bb851bbd8,
 * 9 decimals (verified on-chain, Oct 2026). Amounts are BigInt base units (1 THC = 10^9 units) and
 * prices are USD per THC scaled by 10^18, so no money maths ever touches floating point.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.LoopThc = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const TOKEN = Object.freeze({
    name: 'Transhuman Coin', symbol: 'THC', decimals: 9,
    address: '0x56083560594e314b5cdd1680ec6a493bb851bbd8',
    coingeckoId: 'transhuman-coin', website: 'https://transhumancoin.finance/',
  });
  const UNIT = 10n ** 9n;
  const RATE_SCALE = 10n ** 18n;
  const MAX_UINT256 = (1n << 256n) - 1n;

  const NETWORKS = Object.freeze({
    sim: Object.freeze({ id: 'sim', label: 'Simulated BNB Smart Chain', short: 'Simulated chain', chainId: '0x7a69', native: 'tBNB', simulated: true, explorer: null, rpc: Object.freeze([]) }),
    bsc: Object.freeze({
      id: 'bsc', label: 'BNB Smart Chain', short: 'BNB Smart Chain', chainId: '0x38', native: 'BNB', simulated: false, explorer: 'https://bscscan.com',
      rpc: Object.freeze(['https://bsc-dataseed.bnbchain.org', 'https://bsc-dataseed.binance.org', 'https://1rpc.io/bnb']),
    }),
  });
  /** wallet_addEthereumChain parameters for wallets that don't know BNB Smart Chain yet. */
  const ADD_BSC_PARAMS = Object.freeze({
    chainId: '0x38', chainName: 'BNB Smart Chain',
    nativeCurrency: { name: 'BNB', symbol: 'BNB', decimals: 18 },
    rpcUrls: ['https://bsc-dataseed.bnbchain.org'], blockExplorerUrls: ['https://bscscan.com'],
  });
  const SEL = Object.freeze({
    transfer: '0xa9059cbb', balanceOf: '0x70a08231', name: '0x06fdde03', symbol: '0x95d89b41', decimals: '0x313ce567',
    totalSupply: '0x18160ddd', taxFee: '0x3b124fe7', liquidityFee: '0x6bc87c3a', maxTxAmount: '0x7d1db4a5',
  });
  const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
  const TRANSFER_GAS = 128763n; // gas used by a real THC transfer on BSC

  // ---------------------------------------------------------------- values
  function isAddress(a) { return typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a); }
  function normAddress(a) {
    if (!isAddress(a)) throw new Error('Not a valid wallet address: ' + String(a).slice(0, 60));
    return a.toLowerCase();
  }
  function isTxHash(h) { return typeof h === 'string' && /^0x[0-9a-fA-F]{64}$/.test(h); }
  function toBig(v) {
    if (typeof v === 'bigint') return v;
    if (typeof v === 'number' && Number.isSafeInteger(v)) return BigInt(v);
    if (typeof v === 'string' && /^(0x[0-9a-fA-F]+|\d+)$/.test(v)) return BigInt(v);
    throw new Error('Not an integer amount: ' + String(v).slice(0, 40));
  }
  function decodeUint(h) {
    if (typeof h !== 'string' || !/^0x[0-9a-fA-F]*$/.test(h)) throw new Error('Not a hex value');
    return h === '0x' ? 0n : BigInt(h);
  }
  function hexQty(n) { return '0x' + toBig(n).toString(16); }
  function word(n) {
    const v = toBig(n);
    if (v < 0n || v > MAX_UINT256) throw new Error('uint256 out of range');
    return v.toString(16).padStart(64, '0');
  }
  function addressWord(a) { return normAddress(a).slice(2).padStart(64, '0'); }

  // ---------------------------------------------------------------- calls
  function encodeTransfer(to, units) {
    const u = toBig(units);
    if (u <= 0n) throw new Error('Transfer amount must be positive');
    return SEL.transfer + addressWord(to) + word(u);
  }
  function encodeBalanceOf(a) { return SEL.balanceOf + addressWord(a); }
  /** Decode transfer(address,uint256) calldata, or null if it is anything else. */
  function decodeTransferCall(data) {
    if (typeof data !== 'string' || data.length !== 138 || data.slice(0, 10).toLowerCase() !== SEL.transfer) return null;
    const body = data.slice(10);
    if (!/^[0-9a-fA-F]{128}$/.test(body) || !/^0{24}$/.test(body.slice(0, 24))) return null;
    return { to: '0x' + body.slice(24, 64).toLowerCase(), units: BigInt('0x' + body.slice(64)) };
  }

  // ---------------------------------------------------------------- amounts & prices
  function groupThousands(s) {
    // A plain loop (not a regex): linear time however long the number is.
    let out = '';
    for (let i = s.length; i > 0; i -= 3) out = s.slice(Math.max(0, i - 3), i) + (out ? ',' + out : '');
    return out;
  }
  function formatUnits(units, maxFrac) {
    const u = toBig(units);
    const a = u < 0n ? -u : u;
    const digits = maxFrac == null ? 2 : maxFrac;
    const frac = (a % UNIT).toString().padStart(TOKEN.decimals, '0').slice(0, digits).replace(/0+$/, '');
    return (u < 0n ? '-' : '') + groupThousands((a / UNIT).toString()) + (frac ? '.' + frac : '');
  }
  function parseUnits(str) {
    const m = /^\s*(\d{1,15})(?:\.(\d{0,9}))?\s*$/.exec(String(str));
    if (!m) throw new Error('Enter a THC amount like 1000 or 1000.5');
    return BigInt(m[1]) * UNIT + BigInt((m[2] || '').padEnd(TOKEN.decimals, '0'));
  }
  /** USD per THC (number or numeric string, exponent form allowed) -> integer scaled by 10^18. */
  function rateToE18(v) {
    const n = typeof v === 'string' ? Number(v) : v;
    if (typeof n !== 'number' || !isFinite(n) || n <= 0) throw new Error('Price must be a positive number');
    const m = /^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(n.toPrecision(15));
    if (!m) throw new Error('Unsupported price format');
    const frac = m[2] || '';
    const exp = (m[3] ? parseInt(m[3], 10) : 0) - frac.length + 18;
    let r = BigInt(m[1] + frac);
    r = exp >= 0 ? r * 10n ** BigInt(exp) : r / 10n ** BigInt(-exp);
    if (r <= 0n) throw new Error('Price is too small');
    return r;
  }
  function rateFromE18(e18) { return Number(toBig(e18)) / 1e18; }
  /** US cents -> THC base units at a price (rounds down unless roundUp). */
  function centsToUnits(cents, rateE18, roundUp) {
    const num = toBig(Math.round(Number(cents))) * UNIT * RATE_SCALE;
    const den = 100n * toBig(rateE18);
    return roundUp ? (num + den - 1n) / den : num / den;
  }
  /** THC base units -> US cents at a price (rounds down). */
  function unitsToCents(units, rateE18) {
    return Number(toBig(units) * toBig(rateE18) * 100n / (UNIT * RATE_SCALE));
  }
  /** Amount to send so the recipient still nets `net` after a percentage transfer fee. */
  function grossUp(net, feePct) {
    const n = toBig(net);
    const f = Math.max(0, Math.min(99, Math.floor(Number(feePct) || 0)));
    if (!f) return n;
    const keep = BigInt(100 - f);
    return (n * 100n + keep - 1n) / keep;
  }

  // ---------------------------------------------------------------- receipts
  function sameHex(a, b) { return typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase(); }
  function receiptSucceeded(rc) { const s = rc && rc.status; return s === '0x1' || s === 1 || s === true; }
  /** All THC Transfer events in a receipt (works for real BSC receipts and the simulated chain). */
  function parseTransfers(receipt, token) {
    const tk = normAddress(token || TOKEN.address);
    const logs = receipt && Array.isArray(receipt.logs) ? receipt.logs : [];
    const out = [];
    logs.forEach(function (l) {
      if (!l || !sameHex(l.address, tk) || l.removed === true) return;
      const t = l.topics;
      if (!Array.isArray(t) || t.length !== 3 || !sameHex(t[0], TRANSFER_TOPIC)) return;
      if (typeof l.data !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(l.data)) return;
      if (!/^0x0{24}[0-9a-fA-F]{40}$/.test(t[1]) || !/^0x0{24}[0-9a-fA-F]{40}$/.test(t[2])) return;
      out.push({ from: '0x' + t[1].slice(26).toLowerCase(), to: '0x' + t[2].slice(26).toLowerCase(), units: BigInt(l.data), logIndex: l.logIndex, time: timeOf(l.blockTimestamp) });
    });
    return out;
  }
  /**
   * Check that a mined transaction moved THC to `to`. Uses the amount the Transfer events say
   * actually arrived, so it stays correct if THC's owner switches transfer fees back on.
   * Options: txHash, to, from (an address or a list of acceptable senders), notBefore (unix
   * seconds: transfers stamped earlier don't count), token.
   */
  function verifyTransfer(receipt, opts) {
    if (!receipt || typeof receipt !== 'object') return { ok: false, pending: true, reason: 'The transaction is not confirmed yet' };
    if (opts.txHash && !sameHex(receipt.transactionHash, opts.txHash)) return { ok: false, reason: 'The receipt is for a different transaction' };
    if (!receiptSucceeded(receipt)) return { ok: false, reverted: true, reason: 'The transaction failed (reverted) on-chain' };
    const to = normAddress(opts.to);
    const froms = opts.from == null ? null : [].concat(opts.from).filter(isAddress).map(function (a) { return a.toLowerCase(); });
    const blockTs = timeOf(receipt.blockTimestamp);
    let early = false;
    const hits = parseTransfers(receipt, opts.token).filter(function (t) {
      if (t.to !== to || (froms && froms.indexOf(t.from) < 0)) return false;
      const ts = t.time != null ? t.time : blockTs;
      if (opts.notBefore != null && ts != null && ts < opts.notBefore) { early = true; return false; }
      return true;
    });
    if (!hits.length) {
      if (early) return { ok: false, reason: 'That transfer happened before this payment was requested' };
      return { ok: false, reason: 'This transaction has no ' + TOKEN.symbol + ' transfer to ' + shortAddress(to) + (froms ? ' from ' + froms.map(shortAddress).join(' or ') : '') };
    }
    const received = hits.reduce(function (a, t) { return a + t.units; }, 0n);
    const bn = receipt.blockNumber;
    return { ok: true, received: received, from: hits[0].from, blockNumber: typeof bn === 'string' ? parseInt(bn, 16) : (bn == null ? null : Number(bn)) };
  }
  function timeOf(v) {
    if (typeof v === 'string' && /^0x[0-9a-fA-F]{1,12}$/.test(v)) return parseInt(v, 16);
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    return null;
  }

  // ---------------------------------------------------------------- display & demo identities
  function shortAddress(a) { return typeof a === 'string' && a.length > 12 ? a.slice(0, 6) + '…' + a.slice(-4) : String(a || ''); }
  function explorerTx(network, hash) { const n = NETWORKS[network]; return n && n.explorer && isTxHash(hash) ? n.explorer + '/tx/' + hash : null; }
  function explorerAddress(network, a) { const n = NETWORKS[network]; return n && n.explorer && isAddress(a) ? n.explorer + '/address/' + a : null; }
  function explorerToken() { return NETWORKS.bsc.explorer + '/token/' + TOKEN.address; }

  function hash32(str, seed) {
    let h = (0x811c9dc5 ^ seed) >>> 0;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b) >>> 0;
    h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35) >>> 0;
    return (h ^ (h >>> 16)) >>> 0;
  }
  /** Deterministic pseudo-hash for simulated identifiers (not cryptographic). */
  function hexHash(str, words) {
    let out = '';
    for (let i = 0; i < (words || 8); i++) out += hash32(str, Math.imul(i + 1, 0x9e3779b9) >>> 0).toString(16).padStart(8, '0');
    return '0x' + out;
  }
  /** Address of a built-in demo wallet account on the simulated chain. */
  function demoAddress(label) { return '0x' + hexHash('loopwork-demo-wallet:' + label, 5).slice(2); }

  return {
    TOKEN: TOKEN, UNIT: UNIT, RATE_SCALE: RATE_SCALE, NETWORKS: NETWORKS, ADD_BSC_PARAMS: ADD_BSC_PARAMS, SEL: SEL,
    TRANSFER_TOPIC: TRANSFER_TOPIC, TRANSFER_GAS: TRANSFER_GAS,
    isAddress: isAddress, normAddress: normAddress, isTxHash: isTxHash, toBig: toBig, decodeUint: decodeUint, hexQty: hexQty,
    word: word, addressWord: addressWord, encodeTransfer: encodeTransfer, encodeBalanceOf: encodeBalanceOf, decodeTransferCall: decodeTransferCall,
    formatUnits: formatUnits, parseUnits: parseUnits, rateToE18: rateToE18, rateFromE18: rateFromE18,
    centsToUnits: centsToUnits, unitsToCents: unitsToCents, grossUp: grossUp,
    receiptSucceeded: receiptSucceeded, parseTransfers: parseTransfers, verifyTransfer: verifyTransfer, sameHex: sameHex,
    shortAddress: shortAddress, explorerTx: explorerTx, explorerAddress: explorerAddress, explorerToken: explorerToken,
    hexHash: hexHash, demoAddress: demoAddress,
  };
});
