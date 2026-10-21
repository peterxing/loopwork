/*!
 * LoopWork simulated chain: a tiny stand-in for BNB Smart Chain holding the THC token, so anyone can
 * try THC payments with the built-in demo wallet and no real funds. It answers the JSON-RPC calls a
 * wallet and the app make (balances, transfers, receipts), mirrors THC's SafeMoon-style fee settings
 * and max-transfer limit, and emits receipts shaped like real BSC ones, so the same verification code
 * checks both. It runs in the browser (offline / GitHub Pages) or on the server (POST /api/chain/rpc).
 * There are no signatures: it is a simulation, never a ledger of value.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./thc.js'));
  else root.LoopChain = factory(root.LoopThc);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Thc) {
  'use strict';

  const SCHEMA = 1;
  const NATIVE = 10n ** 18n;
  const GAS_PRICE = 100000000n; // 0.1 gwei, typical on BSC
  const MAX_TXS = 300;
  const MAX_FAUCET_ACCOUNTS = 5000;
  const MAX_ACCOUNTS = 20000; // bounds memory if a public server's chain is spammed with fresh addresses
  const FAUCET_THC = 5000000n * Thc.UNIT; // about $200 of demo THC
  const FAUCET_NATIVE = NATIVE / 20n; // 0.05 tBNB for gas
  const TREASURY_THC = 2000000000n * Thc.UNIT;
  const MUTATING = Object.freeze({ eth_sendTransaction: true, loopchain_faucet: true });

  function rpcError(code, message) { const e = new Error(message); e.code = code; return e; }

  function createState() {
    const treasury = Thc.demoAddress('treasury');
    const s = {
      schema: SCHEMA, chainId: Thc.NETWORKS.sim.chainId, block: 1000000, txCount: 0, nonces: {}, native: {}, faucet: {},
      token: {
        address: Thc.TOKEN.address, totalSupply: (7000000000n * Thc.UNIT).toString(), balances: {},
        taxFee: 0, liquidityFee: 0, maxTx: (80000000n * Thc.UNIT).toString(), owner: Thc.demoAddress('thc-owner'),
      },
      txs: {}, order: [],
    };
    s.token.balances[treasury] = TREASURY_THC.toString();
    s.native[treasury] = NATIVE.toString();
    return s;
  }

  function abiString(str) {
    let h = '';
    for (let i = 0; i < str.length; i++) h += (str.charCodeAt(i) & 0x7f).toString(16).padStart(2, '0');
    return '0x' + Thc.word(32) + Thc.word(str.length) + h.padEnd(Math.ceil(h.length / 64) * 64, '0');
  }
  function clone(o) { return o == null ? null : JSON.parse(JSON.stringify(o)); }

  function Chain(state) { this.s = state && state.schema === SCHEMA ? state : createState(); }

  Chain.prototype.addr = function (a) {
    if (!Thc.isAddress(a)) throw rpcError(-32602, 'Invalid address');
    return a.toLowerCase();
  };
  Chain.prototype.thcOf = function (a) { return BigInt(this.s.token.balances[this.addr(a)] || '0'); };
  Chain.prototype.nativeOf = function (a) { return BigInt(this.s.native[this.addr(a)] || '0'); };

  /** Demo faucet: once per address, enough THC to sponsor a few bounties plus gas money. */
  Chain.prototype.faucet = function (a) {
    const who = this.addr(a);
    if (this.s.faucet[who]) return { thc: '0', native: '0', already: true };
    if (Object.keys(this.s.faucet).length >= MAX_FAUCET_ACCOUNTS) throw rpcError(-32000, 'The demo faucet is empty');
    this.s.faucet[who] = true;
    this.s.token.balances[who] = (this.thcOf(who) + FAUCET_THC).toString();
    this.s.native[who] = (this.nativeOf(who) + FAUCET_NATIVE).toString();
    return { thc: FAUCET_THC.toString(), native: FAUCET_NATIVE.toString(), already: false };
  };

  Chain.prototype.call = function (tx) {
    const t = this.s.token;
    if (!tx || !Thc.isAddress(tx.to) || tx.to.toLowerCase() !== t.address) return '0x';
    const d = String(tx.data || tx.input || '').toLowerCase();
    switch (d.slice(0, 10)) {
      case Thc.SEL.balanceOf:
        if (!/^0x70a08231[0-9a-f]{64}$/.test(d)) throw rpcError(3, 'execution reverted');
        return '0x' + Thc.word(this.thcOf('0x' + d.slice(34, 74)));
      case Thc.SEL.decimals: return '0x' + Thc.word(Thc.TOKEN.decimals);
      case Thc.SEL.totalSupply: return '0x' + Thc.word(t.totalSupply);
      case Thc.SEL.taxFee: return '0x' + Thc.word(t.taxFee);
      case Thc.SEL.liquidityFee: return '0x' + Thc.word(t.liquidityFee);
      case Thc.SEL.maxTxAmount: return '0x' + Thc.word(t.maxTx);
      case Thc.SEL.symbol: return abiString(Thc.TOKEN.symbol);
      case Thc.SEL.name: return abiString(Thc.TOKEN.name);
      default: throw rpcError(3, 'execution reverted');
    }
  };

  /** Execute a THC transfer(address,uint256) the way the real contract would. Returns the tx hash. */
  Chain.prototype.send = function (tx, now) {
    if (!tx || typeof tx !== 'object') throw rpcError(-32602, 'Missing transaction');
    const from = this.addr(tx.from);
    const t = this.s.token;
    if (!Thc.isAddress(tx.to) || tx.to.toLowerCase() !== t.address) throw rpcError(-32000, 'The simulated chain only supports THC transfers');
    if (tx.value && !/^0x0*$/.test(String(tx.value))) throw rpcError(-32000, 'The simulated chain does not support sending tBNB');
    const call = Thc.decodeTransferCall(String(tx.data || tx.input || ''));
    if (!call) throw rpcError(-32000, 'Only THC transfer(address,uint256) calls are supported');
    const gasCost = Thc.TRANSFER_GAS * GAS_PRICE;
    if (this.nativeOf(from) < gasCost) throw rpcError(-32000, 'insufficient funds for gas * price + value');
    const balance = this.thcOf(from);
    if (call.units > balance) throw rpcError(3, 'execution reverted: transfer amount exceeds balance');
    if (call.units > BigInt(t.maxTx) && from !== t.owner && call.to !== t.owner) throw rpcError(3, 'execution reverted: Transfer amount exceeds the maxTxAmount.');
    if (!(call.to in t.balances) && Object.keys(t.balances).length >= MAX_ACCOUNTS) throw rpcError(-32000, 'The simulated chain is full; reset the demo to start a fresh one');
    const fee = call.units * BigInt(t.taxFee + t.liquidityFee) / 100n;
    const liquidity = call.units * BigInt(t.liquidityFee) / 100n;
    const net = call.units - fee;

    this.s.native[from] = (this.nativeOf(from) - gasCost).toString();
    t.balances[from] = (balance - call.units).toString();
    t.balances[call.to] = (this.thcOf(call.to) + net).toString();
    if (liquidity > 0n) t.balances[t.address] = (this.thcOf(t.address) + liquidity).toString();
    // The reflection share is simply taken out of circulation in this simulation.

    const nonce = this.s.nonces[from] || 0;
    this.s.nonces[from] = nonce + 1;
    this.s.txCount += 1;
    this.s.block += 1;
    const hash = Thc.hexHash('tx:' + this.s.chainId + ':' + from + ':' + nonce + ':' + this.s.txCount + ':' + call.to + ':' + call.units, 8);
    const blockHash = Thc.hexHash('block:' + this.s.chainId + ':' + this.s.block, 8);
    const blockNumber = Thc.hexQty(this.s.block);
    const log = {
      address: t.address, topics: [Thc.TRANSFER_TOPIC, '0x' + Thc.addressWord(from), '0x' + Thc.addressWord(call.to)],
      data: '0x' + Thc.word(net), blockNumber: blockNumber, transactionHash: hash, transactionIndex: '0x0', blockHash: blockHash,
      blockTimestamp: Thc.hexQty(Math.floor((now || Date.now()) / 1000)), logIndex: '0x0', removed: false,
    };
    const receipt = {
      type: '0x0', from: from, to: t.address, status: '0x1', cumulativeGasUsed: Thc.hexQty(Thc.TRANSFER_GAS), logsBloom: '0x' + '0'.repeat(512),
      logs: [log], transactionHash: hash, contractAddress: null, gasUsed: Thc.hexQty(Thc.TRANSFER_GAS), blockHash: blockHash,
      blockNumber: blockNumber, transactionIndex: '0x0', effectiveGasPrice: Thc.hexQty(GAS_PRICE),
    };
    const txv = { hash: hash, from: from, to: t.address, input: String(tx.data || tx.input).toLowerCase(), value: '0x0', nonce: Thc.hexQty(nonce), gas: Thc.hexQty(Thc.TRANSFER_GAS), gasPrice: Thc.hexQty(GAS_PRICE), blockNumber: blockNumber, blockHash: blockHash };
    this.s.txs[hash] = { tx: txv, receipt: receipt };
    this.s.order.push(hash);
    while (this.s.order.length > MAX_TXS) delete this.s.txs[this.s.order.shift()];
    return hash;
  };

  Chain.prototype.receipt = function (hash) {
    if (!Thc.isTxHash(hash)) return null;
    const e = this.s.txs[hash.toLowerCase()];
    return e ? clone(e.receipt) : null;
  };

  /** JSON-RPC entry point: { method, params } -> result (throws errors with EIP-1193/JSON-RPC codes). */
  Chain.prototype.rpc = function (req, now) {
    const method = req && req.method;
    const p = req && Array.isArray(req.params) ? req.params : [];
    switch (method) {
      case 'eth_chainId': return this.s.chainId;
      case 'net_version': return String(parseInt(this.s.chainId, 16));
      case 'eth_blockNumber': return Thc.hexQty(this.s.block);
      case 'eth_gasPrice': return Thc.hexQty(GAS_PRICE);
      case 'eth_estimateGas': return Thc.hexQty(Thc.TRANSFER_GAS);
      case 'eth_getBalance': return Thc.hexQty(this.nativeOf(p[0]));
      case 'eth_call': return this.call(p[0]);
      case 'eth_sendTransaction': return this.send(p[0], now);
      case 'eth_getTransactionReceipt': return this.receipt(p[0]);
      case 'eth_getTransactionByHash': {
        const e = Thc.isTxHash(p[0]) ? this.s.txs[p[0].toLowerCase()] : null;
        return e ? clone(e.tx) : null;
      }
      case 'loopchain_faucet': return this.faucet(p[0]);
      default: throw rpcError(-32601, 'The LoopWork simulated chain does not support ' + String(method).slice(0, 60));
    }
  };

  return {
    SCHEMA: SCHEMA, GAS_PRICE: GAS_PRICE, FAUCET_THC: FAUCET_THC, TREASURY_THC: TREASURY_THC,
    createState: createState, Chain: Chain, isMutating: function (m) { return !!MUTATING[m]; },
  };
});
