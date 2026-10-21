/* LoopWork: Transhuman Coin (THC) wallet integration.
 * - Real wallets: EIP-6963 discovery (MetaMask, Trust, Coinbase, Rabby, OKX, Binance Web3…) with a
 *   window.ethereum fallback, switched to BNB Smart Chain. Every transfer is signed in the user's own
 *   wallet; LoopWork never sees keys or seed phrases.
 * - Demo wallet: built in, on a simulated chain, so anyone can try THC payments with no real funds.
 * - Payouts (treasury -> worker) and payments (sponsor -> treasury) settle only after the transaction
 *   receipt proves the THC arrived. */
(function (LW) {
  'use strict';
  const Thc = window.LoopThc;
  const LoopChain = window.LoopChain;
  const esc = LW.esc;
  const CHAIN_KEY = 'loopwork-demo-chain-v1';
  const SLOT_KEY = 'loopwork-wallet-slots-v1';
  const COINGECKO = 'https://api.coingecko.com/api/v3/simple/price?ids=' + Thc.TOKEN.coingeckoId + '&vs_currencies=usd';
  const DEXSCREENER = 'https://api.dexscreener.com/latest/dex/tokens/' + Thc.TOKEN.address;
  const THC_IMAGE = 'https://coin-images.coingecko.com/coins/images/20328/large/kdEastmD_400x400.jpg';

  function rpcError(code, message) { const e = new Error(message); e.code = code; return e; }
  function save(key, val) { try { if (val == null) localStorage.removeItem(key); else localStorage.setItem(key, JSON.stringify(val)); } catch (e) { /* storage unavailable */ } }
  function load(key) { try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch (e) { return null; } }
  function formatNative(wei) {
    const v = Number(Thc.toBig(wei)) / 1e18;
    return v === 0 ? '0' : v < 0.0001 ? v.toFixed(7) : v.toFixed(4);
  }
  /** Friendlier messages for the standard EIP-1193 wallet errors. */
  function walletError(e) {
    const code = e && (e.code || (e.data && e.data.originalError && e.data.originalError.code));
    if (code === 4001) return new Error('You rejected the request in your wallet.');
    if (code === -32002) return new Error('Your wallet already has a request open. Check the wallet window.');
    if (code === 4100) return new Error('Your wallet has not shared this account with LoopWork yet.');
    return e instanceof Error ? e : new Error(String((e && e.message) || e));
  }
  LW.thcFormat = function (units) { return Thc.formatUnits(units); };

  // ---------------------------------------------------------------- simulated chain (demo wallet backend)
  let localChain = null;
  function demoChainRpc(method, params) {
    if (LW.api.mode === 'server') {
      return fetch('api/chain/rpc', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, cache: 'no-store',
        body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method: method, params: params || [] }),
      }).then(function (r) { return r.json(); }).then(function (j) {
        if (j.error) throw rpcError(j.error.code, j.error.message);
        return j.result;
      });
    }
    if (!localChain) localChain = new LoopChain.Chain(load(CHAIN_KEY));
    try {
      const out = localChain.rpc({ method: method, params: params || [] }, Date.now());
      if (LoopChain.isMutating(method)) save(CHAIN_KEY, localChain.s);
      return Promise.resolve(out);
    } catch (e) { return Promise.reject(e); }
  }

  /** Public BNB Smart Chain RPC for reads that don't need a wallet. */
  async function bscRpc(method, params) {
    let last = null;
    for (const url of Thc.NETWORKS.bsc.rpc) {
      try {
        const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: method, params: params }) });
        const j = await r.json();
        if (j.error) throw new Error(j.error.message || 'RPC error');
        return j.result;
      } catch (e) { last = e; }
    }
    throw new Error('BNB Smart Chain is unreachable right now' + (last ? ' (' + last.message + ')' : ''));
  }

  // ---------------------------------------------------------------- the built-in demo wallet
  function approveDemoTx(tx, label, preapproved) {
    if (preapproved) return Promise.resolve(true);
    const call = Thc.decodeTransferCall(String(tx.data || ''));
    return new Promise(function (resolve) {
      let decided = false;
      const m = LW.modal({
        title: '🧪 Demo wallet · confirm transfer',
        body: '<div class="paylines">' +
          '<div><span class="muted">Network</span><span>' + esc(Thc.NETWORKS.sim.label) + '</span></div>' +
          '<div><span class="muted">From</span><span>' + esc(label) + ' <span class="addr">' + esc(Thc.shortAddress(tx.from)) + '</span></span></div>' +
          '<div><span class="muted">To</span><span class="addr">' + esc(call ? Thc.shortAddress(call.to) : 'unknown') + '</span></div>' +
          '<div><span class="muted">Network fee</span><span>≈ ' + formatNative(Thc.TRANSFER_GAS * LoopChain.GAS_PRICE) + ' tBNB</span></div>' +
          '<div class="total"><span>Amount</span><span>' + (call ? esc(Thc.formatUnits(call.units)) + ' THC' : 'unknown') + '</span></div></div>' +
          '<p class="small muted" style="margin-top:10px">This is LoopWork\'s built-in demo wallet on a simulated chain, so no real THC moves. A real wallet such as MetaMask or Trust Wallet shows a screen like this before every transfer.</p>' +
          '<div class="row" style="margin-top:12px;justify-content:flex-end"><button class="btn" data-demo="reject">Reject</button><button class="btn primary" data-demo="confirm">Confirm</button></div>',
        onClose: function () { if (!decided) { decided = true; resolve(false); } },
      });
      m.el.addEventListener('click', function (e) {
        const b = e.target.closest('[data-demo]');
        if (!b || decided) return;
        decided = true;
        resolve(b.getAttribute('data-demo') === 'confirm');
        m.close();
      });
    });
  }
  /** An EIP-1193 provider backed by the simulated chain, with its own approval screen. */
  function demoProvider(account, label) {
    const p = {
      isLoopWorkDemo: true, preapproved: 0,
      request: function (req) {
        const method = req && req.method;
        const params = (req && req.params) || [];
        switch (method) {
          case 'eth_requestAccounts': case 'eth_accounts': return Promise.resolve([account]);
          case 'eth_chainId': return Promise.resolve(Thc.NETWORKS.sim.chainId);
          case 'wallet_switchEthereumChain': case 'wallet_addEthereumChain': case 'wallet_watchAsset': return Promise.resolve(null);
          case 'eth_sendTransaction': {
            const tx = params[0] || {};
            if (String(tx.from || '').toLowerCase() !== account) return Promise.reject(rpcError(4100, 'The demo wallet can only send from ' + Thc.shortAddress(account)));
            const pre = p.preapproved > 0;
            if (pre) p.preapproved--;
            return approveDemoTx(tx, label, pre).then(function (ok) {
              if (!ok) throw rpcError(4001, 'You rejected the transfer in the demo wallet.');
              return demoChainRpc('eth_sendTransaction', [tx]);
            });
          }
          default: return demoChainRpc(method, params);
        }
      },
      on: function () {}, removeListener: function () {},
    };
    return p;
  }

  // ---------------------------------------------------------------- wallet discovery (EIP-6963)
  const announced = new Map();
  window.addEventListener('eip6963:announceProvider', function (e) {
    const d = e.detail;
    if (!d || !d.info || !d.provider || typeof d.provider.request !== 'function') return;
    const key = String(d.info.rdns || d.info.uuid || d.info.name || '').slice(0, 80);
    if (key) announced.set(key, d);
  });
  function requestWallets() { window.dispatchEvent(new Event('eip6963:requestProvider')); }
  requestWallets();
  function safeIcon(icon) { return typeof icon === 'string' && icon.length < 200000 && /^data:image\/(svg\+xml|png|jpeg|webp|gif)[;,]/i.test(icon) ? icon : null; }
  function walletOptions() {
    const list = [{ id: 'demo', name: 'LoopWork demo wallet', note: 'Simulated chain · no real funds', demo: true }];
    announced.forEach(function (d, key) { list.push({ id: 'eip6963:' + key, name: String(d.info.name || 'Wallet').slice(0, 40), icon: safeIcon(d.info.icon), provider: d.provider, note: 'BNB Smart Chain · real THC' }); });
    if (!announced.size && window.ethereum && typeof window.ethereum.request === 'function') {
      const p = window.ethereum;
      const name = p.isTrust || p.isTrustWallet ? 'Trust Wallet' : p.isCoinbaseWallet ? 'Coinbase Wallet' : p.isMetaMask ? 'MetaMask' : 'Browser wallet';
      list.push({ id: 'injected', name: name, provider: p, note: 'BNB Smart Chain · real THC' });
    }
    return list;
  }

  // ---------------------------------------------------------------- connections: "personal" (worker/sponsor) and "treasury" (ops)
  const slots = { personal: null, treasury: null };
  function possessive(name) { return name === 'You' ? 'Your' : name + '\'s'; }
  function slotLabel(slot) {
    if (slot === 'treasury') return 'Platform treasury (demo)';
    const w = LW.workerById(LW.me());
    return possessive(w ? w.name : 'You') + ' demo wallet';
  }
  function demoAccount(slot) { return slot === 'treasury' ? Thc.demoAddress('treasury') : Thc.demoAddress('worker:' + LW.me()); }
  function refreshWalletViews() { const r = LW.route().name; if (r === 'wallet' || r === 'ops') LW.render(); }

  async function ensureBsc(provider) {
    try {
      await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: Thc.NETWORKS.bsc.chainId }] });
    } catch (e) {
      const code = e && (e.code || (e.data && e.data.originalError && e.data.originalError.code));
      if (code !== 4902) throw walletError(e);
      await provider.request({ method: 'wallet_addEthereumChain', params: [Thc.ADD_BSC_PARAMS] });
    }
  }

  async function connect(slot, optionId, opts) {
    const silent = !!(opts && opts.silent);
    const opt = walletOptions().find(function (o) { return o.id === optionId; });
    if (!opt) throw new Error('That wallet is not available in this browser');
    const provider = opt.demo ? demoProvider(demoAccount(slot), slotLabel(slot)) : opt.provider;
    try {
      const accounts = await provider.request({ method: silent ? 'eth_accounts' : 'eth_requestAccounts' });
      if (!accounts || !accounts.length) { if (silent) return null; throw new Error('The wallet did not share an account'); }
      const account = Thc.normAddress(accounts[0]);
      let chainId = await provider.request({ method: 'eth_chainId' });
      if (!opt.demo && chainId !== Thc.NETWORKS.bsc.chainId && !silent) {
        await ensureBsc(provider);
        chainId = await provider.request({ method: 'eth_chainId' });
      }
      const conn = { slot: slot, id: opt.id, name: opt.name, icon: opt.icon || null, demo: !!opt.demo, provider: provider, account: account, chainId: chainId, network: opt.demo ? 'sim' : chainId === Thc.NETWORKS.bsc.chainId ? 'bsc' : null };
      if (slots[slot] && slots[slot].unsubscribe) slots[slot].unsubscribe();
      slots[slot] = conn;
      const saved = load(SLOT_KEY) || {};
      saved[slot] = opt.id;
      save(SLOT_KEY, saved);
      if (!opt.demo && typeof provider.on === 'function') {
        const onAccounts = function (accs) {
          if (slots[slot] !== conn) return;
          if (!accs || !accs.length) { disconnect(slot); } else { try { conn.account = Thc.normAddress(accs[0]); } catch (err) { disconnect(slot); } }
          refreshWalletViews();
        };
        const onChain = function (cid) {
          if (slots[slot] !== conn) return;
          conn.chainId = cid; conn.network = cid === Thc.NETWORKS.bsc.chainId ? 'bsc' : null;
          refreshWalletViews();
        };
        provider.on('accountsChanged', onAccounts);
        provider.on('chainChanged', onChain);
        conn.unsubscribe = function () {
          if (typeof provider.removeListener === 'function') { provider.removeListener('accountsChanged', onAccounts); provider.removeListener('chainChanged', onChain); }
        };
      }
      return conn;
    } catch (e) {
      if (silent) return null;
      throw walletError(e);
    }
  }
  function disconnect(slot) {
    const c = slots[slot];
    if (c && c.unsubscribe) c.unsubscribe();
    slots[slot] = null;
    const saved = load(SLOT_KEY) || {};
    delete saved[slot];
    save(SLOT_KEY, saved);
  }
  /** The slot's connection, reconnecting silently to the last wallet used (no pop-up). */
  async function restore(slot) {
    const c = slots[slot];
    if (c && !(c.demo && c.account !== demoAccount(slot))) return c;
    if (c) slots[slot] = null; // the demo wallet follows the "Acting as" persona
    const saved = load(SLOT_KEY) || {};
    if (!saved[slot]) return null;
    return connect(slot, saved[slot], { silent: true });
  }

  async function balancesOf(conn) {
    if (!conn || !conn.network) return null;
    const res = await Promise.all([
      conn.provider.request({ method: 'eth_call', params: [{ to: Thc.TOKEN.address, data: Thc.encodeBalanceOf(conn.account) }, 'latest'] }),
      conn.provider.request({ method: 'eth_getBalance', params: [conn.account, 'latest'] }),
    ]);
    return { thc: Thc.decodeUint(res[0]), native: Thc.decodeUint(res[1]) };
  }

  // ---------------------------------------------------------------- prices & token settings
  LW.thcRefreshPrice = async function () {
    let usd = null, source = null;
    try {
      const j = await (await fetch(COINGECKO, { cache: 'no-store' })).json();
      usd = Number(j && j[Thc.TOKEN.coingeckoId] && j[Thc.TOKEN.coingeckoId].usd);
      source = 'CoinGecko';
    } catch (e) { usd = null; }
    if (!(usd > 0)) {
      try {
        const j = await (await fetch(DEXSCREENER, { cache: 'no-store' })).json();
        const pairs = ((j && j.pairs) || []).filter(function (p) { return p.chainId === 'bsc' && Number(p.priceUsd) > 0; })
          .sort(function (a, b) { return ((b.liquidity && b.liquidity.usd) || 0) - ((a.liquidity && a.liquidity.usd) || 0); });
        if (pairs[0]) { usd = Number(pairs[0].priceUsd); source = 'DexScreener'; }
      } catch (e) { usd = null; }
    }
    if (!(usd > 0)) throw new Error('Could not fetch a live THC price (CoinGecko and DexScreener are unreachable)');
    return LW.api.call('setThcRate', { usdPerThc: usd, source: source });
  };
  /** Read THC's current transfer fee and max-transfer limit from the contract on BNB Smart Chain. */
  LW.thcRefreshChainInfo = async function () {
    const r = await Promise.all([Thc.SEL.taxFee, Thc.SEL.liquidityFee, Thc.SEL.maxTxAmount].map(function (sel) {
      return bscRpc('eth_call', [{ to: Thc.TOKEN.address, data: sel }, 'latest']);
    }));
    return LW.api.call('setThcChainInfo', { feePct: Number(Thc.decodeUint(r[0]) + Thc.decodeUint(r[1])), maxTxUnits: Thc.decodeUint(r[2]).toString() });
  };

  // ---------------------------------------------------------------- transfers
  async function preflight(conn, units) {
    if (!conn.network) throw new Error('Switch ' + conn.name + ' to BNB Smart Chain first');
    const b = await balancesOf(conn);
    if (b.thc < units) {
      throw new Error('Not enough THC in ' + Thc.shortAddress(conn.account) + ': it has ' + Thc.formatUnits(b.thc) + ' THC and this needs ' + Thc.formatUnits(units) + ' THC.' + (conn.demo ? ' Use "Get demo THC" first.' : ''));
    }
    let gasPrice = LoopChain.GAS_PRICE;
    if (!conn.demo) { try { gasPrice = Thc.decodeUint(await conn.provider.request({ method: 'eth_gasPrice' })); } catch (e) { gasPrice = LoopChain.GAS_PRICE; } }
    const gas = Thc.TRANSFER_GAS * gasPrice;
    if (b.native < gas) throw new Error('Not enough ' + Thc.NETWORKS[conn.network].native + ' for the network fee (about ' + formatNative(gas) + ' needed).');
  }
  /** Extra confirmation before real tokens move (the wallet will still ask too). */
  function confirmLive(conn, units, to, purpose) {
    return new Promise(function (resolve) {
      let decided = false;
      const m = LW.modal({
        title: 'Send real THC on BNB Smart Chain?',
        body: '<div class="paylines">' +
          '<div><span class="muted">For</span><span>' + esc(purpose) + '</span></div>' +
          '<div><span class="muted">From</span><span class="addr">' + esc(conn.account) + '</span></div>' +
          '<div><span class="muted">To</span><span class="addr">' + esc(to) + '</span></div>' +
          '<div class="total"><span>Amount</span><span>' + esc(Thc.formatUnits(units)) + ' THC</span></div></div>' +
          '<label class="check" style="margin-top:10px"><input type="checkbox" data-live="ack"><span>I understand this moves real tokens on BNB Smart Chain and can\'t be reversed. My wallet will ask me to confirm.</span></label>' +
          '<div class="row" style="justify-content:flex-end"><button class="btn" data-live="cancel">Cancel</button><button class="btn primary" data-live="go" disabled>Continue to wallet</button></div>',
        onClose: function () { if (!decided) { decided = true; resolve(false); } },
      });
      m.el.addEventListener('change', function (e) { if (e.target.closest('[data-live="ack"]')) LW.$('[data-live="go"]', m.el).disabled = !e.target.checked; });
      m.el.addEventListener('click', function (e) {
        const b = e.target.closest('button[data-live]');
        if (!b || b.disabled || decided) return;
        decided = true;
        resolve(b.getAttribute('data-live') === 'go');
        m.close();
      });
    });
  }
  async function sendThc(conn, from, to, units) {
    try {
      return await conn.provider.request({ method: 'eth_sendTransaction', params: [{ from: from, to: Thc.TOKEN.address, data: Thc.encodeTransfer(to, units), value: '0x0' }] });
    } catch (e) { throw walletError(e); }
  }
  async function waitReceipt(conn, hash, onStatus) {
    const until = Date.now() + 180000;
    let tries = 0;
    while (Date.now() < until) {
      let rc = null;
      try { rc = await conn.provider.request({ method: 'eth_getTransactionReceipt', params: [hash] }); } catch (e) { rc = null; }
      if (!rc && conn.network === 'bsc') { try { rc = await bscRpc('eth_getTransactionReceipt', [hash]); } catch (e) { rc = null; } }
      if (rc) return rc;
      tries++;
      if (onStatus && tries % 3 === 0) onStatus('Still waiting for BNB Smart Chain to confirm the transaction…');
      await LW.sleep(conn.demo ? 250 : 2000);
    }
    throw new Error('The transaction has not confirmed yet. It may still go through: press "Check again" in a minute.');
  }
  /**
   * Settle once the receipt is in. The server looks up every transaction recorded against the record
   * itself; the browser build sends what it sees on-chain for each of them.
   */
  async function settle(refType, rec, hash, receipt) {
    for (let i = 0; ; i++) {
      try {
        const args = { refType: refType, refId: rec.id };
        if (LW.api.mode !== 'server') { const known = {}; known[hash] = receipt; args.chain = await chainMap(refType, rec, { known: known }); }
        return await LW.api.call('settleThc', args);
      } catch (e) { if (!/not confirmed yet|waiting to be mined/i.test(e.message) || i >= 5) throw e; await LW.sleep(2000); }
    }
  }

  /**
   * Sign and send one transfer for a payout or payment. The record is locked ("sending") on the platform
   * before the wallet opens, and only this window's lock token can record the transaction or release
   * the lock, so another window can't pay, cancel or release it meanwhile. The sender is pinned when
   * the flow starts: if the wallet has switched accounts by the time it's asked to send, nothing is sent.
   */
  async function sendLocked(refType, rec, conn, sender, to, units, onStatus, resend) {
    const startArgs = { refType: refType, refId: rec.id, resend: !!resend };
    // Before sending again, every earlier transaction must be gone (the server checks this itself).
    if (resend && LW.api.mode !== 'server') startArgs.chain = await chainMap(refType, rec, { pending: true });
    const lock = (await LW.api.call('startThcTx', startArgs)).lock;
    let hash = null;
    try {
      if (conn.account !== sender) throw new Error('Your wallet switched to another account (' + Thc.shortAddress(conn.account) + '). Switch back to ' + Thc.shortAddress(sender) + ' and try again.');
      onStatus(conn.demo ? 'Waiting for the demo wallet…' : 'Waiting for your wallet…');
      hash = await sendThc(conn, sender, to, units);
    } catch (e) {
      await LW.api.call('releaseThcTx', { refType: refType, refId: rec.id, lock: lock }).catch(function () { return null; });
      throw e;
    }
    // The THC has left the wallet now, so recording the hash must not be lost to a network blip.
    // Re-recording the same hash is harmless, so retry; refusals (4xx) are final.
    let recorded = null;
    for (let i = 0; ; i++) {
      try { recorded = (await LW.api.call('submitThcTx', { refType: refType, refId: rec.id, txHash: hash, lock: lock, replace: !!resend })).record; break; }
      catch (e) {
        if (i < 3 && (!e.status || e.status >= 500)) { await LW.sleep(1500 * (i + 1)); continue; }
        const what = refType === 'payout' ? 'payout' : 'payment';
        const url = Thc.explorerTx(conn.network, hash);
        LW.modal({
          title: 'Sent, but not recorded yet',
          body: '<p style="margin:0 0 10px">Your wallet sent the transaction, but LoopWork could not record it: ' + esc(e.message) + '</p>' +
            '<p style="margin:0 0 10px"><b>Do not send it again.</b> Copy this hash. Once the ' + what + ' shows as stuck (about 10 minutes), press <b>Attach transaction</b> on it and paste the hash.</p>' +
            '<p style="margin:0 0 10px"><code class="addr" style="user-select:all;word-break:break-all">' + esc(hash) + '</code></p>' +
            (url ? '<p style="margin:0"><a href="' + esc(url) + '" target="_blank" rel="noopener">View it on the explorer ↗</a></p>' : ''),
        });
        throw new Error('The transaction was sent but not recorded. Keep the hash shown and attach it later.');
      }
    }
    onStatus('Sent. Waiting for the transaction to confirm…');
    const rc = await waitReceipt(conn, hash, onStatus);
    onStatus('Confirmed on-chain. Verifying the transfer…');
    return settle(refType, recorded, hash, rc);
  }
  /** Treasury pays a queued worker payout (simulated-chain payouts come from the demo treasury). */
  async function payPayout(p, onStatus, opts) {
    const conn = p.network === 'sim' ? demoTreasury() : await restore('treasury');
    if (!conn) throw new Error('Connect the treasury wallet first (Ops & pay → THC treasury)');
    if (conn.network !== p.network) throw new Error('This payout is on ' + p.networkLabel + ', but the treasury wallet is on ' + (conn.network ? Thc.NETWORKS[conn.network].label : 'another network') + '.');
    const treasury = (await LW.api.call('thc')).treasury[p.network];
    if (!treasury) throw new Error('Set the ' + p.networkLabel + ' treasury first (Ops & pay → THC treasury)');
    const sender = conn.account;
    if (sender !== treasury) throw new Error('Payouts must come from the treasury wallet ' + Thc.shortAddress(treasury) + ', but ' + conn.name + ' is using ' + Thc.shortAddress(sender) + '.');
    const units = BigInt(p.grossUnits);
    await preflight(conn, units);
    if (conn.network === 'bsc' && !(await confirmLive(conn, units, p.to, 'THC payout to ' + p.workerName + ' (' + LW.money(p.cents) + ')'))) return null;
    return sendLocked('payout', p, conn, sender, p.to, units, onStatus, opts && opts.resend);
  }
  /** Anyone pays THC into the treasury to fund a sponsored bounty. */
  async function sponsor(skill, cents, onStatus) {
    const conn = await restore('personal');
    if (!conn) throw new Error('Connect a wallet first');
    if (!conn.network) throw new Error('Switch ' + conn.name + ' to BNB Smart Chain first');
    const sender = conn.account;
    const inv = (await LW.api.call('createThcInvoice', { workerId: LW.me(), network: conn.network, payer: sender, skill: skill, usdCents: cents })).invoice;
    const units = BigInt(inv.grossUnits);
    const abandon = function () { return LW.api.call('cancelThc', { refType: 'invoice', refId: inv.id }).catch(function () { return null; }); };
    try {
      await preflight(conn, units);
      if (conn.network === 'bsc' && !(await confirmLive(conn, units, inv.to, 'Sponsoring "' + inv.skillName + '" demos (' + LW.money(cents) + ')'))) { await abandon(); return null; }
    } catch (e) { await abandon(); throw e; }
    try {
      return await sendLocked('invoice', inv, conn, sender, inv.to, units, onStatus, false);
    } catch (e) {
      // Nothing was sent if the request is back to "open": tidy it away.
      const st = (await LW.api.call('thc').catch(function () { return { invoices: [] }; })).invoices.find(function (i) { return i.id === inv.id; });
      if (st && st.status === 'open') await abandon();
      throw e;
    }
  }
  /** Re-check every transaction recorded for a payout or payment (after a timeout or a closed tab). */
  async function checkAgain(refType, rec) {
    if (!window.LoopEngine.claimedHashes(rec).length) throw new Error('No transaction has been recorded for this yet');
    const args = { refType: refType, refId: rec.id };
    if (LW.api.mode !== 'server') args.chain = await chainMap(refType, rec, {}); // the server looks them up itself
    return LW.api.call('settleThc', args);
  }
  /**
   * Record a transaction sent outside this flow: a wallet "speed up" that replaced the original, a
   * replacement for a failed attempt, or a send whose window closed before it was recorded.
   */
  async function attachTx(refType, rec) {
    const hash = (window.prompt('Paste the transaction hash from your wallet (0x followed by 64 hex characters):') || '').trim().toLowerCase();
    if (!hash) return null;
    if (!Thc.isTxHash(hash)) throw new Error('That is not a transaction hash');
    const args = { refType: refType, refId: rec.id, txHash: hash, replace: true };
    const E = window.LoopEngine;
    if (LW.api.mode !== 'server' && E.claimedHashes(rec).indexOf(hash) < 0 && E.claimedHashes(rec).length >= E.MAX_TX_PER_RECORD) {
      // Past the limit, only a transaction confirmed on-chain can be added (the server looks it up itself).
      args.proof = (await chainMap(refType, { network: rec.network, txHash: hash }, {}))[hash];
    }
    return LW.api.call('submitThcTx', args);
  }
  /**
   * What the chain knows about every transaction recorded against a payout or payment, newest first:
   * hash -> receipt, { pending: true } while the network still holds it unmined (with opts.pending), or
   * null if nobody has it. Asks the public RPCs and the connected wallet's own node, and fails rather
   * than guess when a transaction can't be checked. opts.known supplies receipts already in hand.
   */
  async function chainMap(refType, rec, opts) {
    opts = opts || {};
    const conn = slots[refType === 'payout' ? 'treasury' : 'personal'];
    const wallet = conn && !conn.demo && conn.network === rec.network ? conn.provider : null;
    const lookup = async function (method, h) {
      const sources = [function () { return rec.network === 'sim' ? demoChainRpc(method, [h]) : bscRpc(method, [h]); }];
      if (wallet) sources.push(function () { return wallet.request({ method: method, params: [h] }); });
      let answered = false;
      for (const ask of sources) {
        try { const v = await ask(); answered = true; if (v) return v; } catch (e) { /* try the next source */ }
      }
      if (!answered) throw new Error('Could not reach ' + Thc.NETWORKS[rec.network].label + ' to check transaction ' + Thc.shortAddress(h) + '. Try again in a minute.');
      return null;
    };
    const hashes = window.LoopEngine.claimedHashes(rec); // at most a handful, looked up in parallel
    const seen = await Promise.all(hashes.map(async function (h) {
      if (opts.known && opts.known[h]) return opts.known[h];
      const rc = await lookup('eth_getTransactionReceipt', h);
      if (rc || !opts.pending) return rc;
      return (await lookup('eth_getTransactionByHash', h)) ? { pending: true, transactionHash: h } : null;
    }));
    const out = {};
    hashes.forEach(function (h, i) { out[h] = seen[i]; });
    return out;
  }
  /** The treasury marks a payout's transaction as dropped, so the money goes back to the worker. */
  async function dropPayout(p) {
    const args = { refType: 'payout', refId: p.id };
    if (LW.api.mode !== 'server') args.chain = await chainMap('payout', p, { pending: true }); // the server checks the chain itself
    return LW.api.call('dropThcTx', args);
  }
  const LOCK_TTL_MS = 10 * 60 * 1000; // matches the engine: after this a vanished window's lock can be cleared
  function lockStale(r) { return r.status === 'sending' && Date.now() - (r.sendingAt || r.createdAt) > LOCK_TTL_MS; }

  LW.thc = {
    walletOptions: walletOptions, requestWallets: requestWallets, connect: connect, disconnect: disconnect, restore: restore,
    balancesOf: balancesOf, payPayout: payPayout, sponsor: sponsor, checkAgain: checkAgain, demoChainRpc: demoChainRpc,
    preapprove: function (conn, n) { if (conn && conn.demo) conn.provider.preapproved = n; },
    watchAsset: function (conn) {
      return conn.provider.request({ method: 'wallet_watchAsset', params: { type: 'ERC20', options: { address: Thc.TOKEN.address, symbol: Thc.TOKEN.symbol, decimals: Thc.TOKEN.decimals, image: THC_IMAGE } } }).catch(function (e) { throw walletError(e); });
    },
    resetDemo: function () {
      localChain = null;
      save(CHAIN_KEY, null);
      ['personal', 'treasury'].forEach(function (s) { if (slots[s] && slots[s].demo) slots[s] = null; });
    },
  };

  // ---------------------------------------------------------------- UI helpers
  const coarse = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
  let demoTreasuryConn = null;
  /** Simulated-chain payouts are always paid from the built-in demo treasury. */
  function demoTreasury() {
    if (!demoTreasuryConn) {
      demoTreasuryConn = { slot: 'treasury', id: 'demo', name: 'Demo treasury wallet', demo: true, account: demoAccount('treasury'), chainId: Thc.NETWORKS.sim.chainId, network: 'sim' };
      demoTreasuryConn.provider = demoProvider(demoTreasuryConn.account, 'Platform treasury (demo)');
    }
    return demoTreasuryConn;
  }
  /** One demo-wallet approval for a batch of simulated payouts. */
  function confirmDemoBatch(list) {
    const total = list.reduce(function (a, p) { return a + BigInt(p.grossUnits); }, 0n);
    return new Promise(function (resolve) {
      let decided = false;
      const m = LW.modal({
        title: '🧪 Demo wallet · confirm ' + list.length + ' transfers',
        body: '<div class="paylines">' + list.map(function (p) {
          return '<div><span>' + esc(p.workerName) + ' <span class="addr soft">' + esc(Thc.shortAddress(p.to)) + '</span></span><span>' + esc(Thc.formatUnits(p.grossUnits)) + ' THC</span></div>';
        }).join('') + '<div class="total"><span>Total from the demo treasury</span><span>' + esc(Thc.formatUnits(total)) + ' THC</span></div></div>' +
          '<p class="small muted" style="margin-top:10px">Simulated chain, so no real THC moves. Each transfer is still checked against its own receipt.</p>' +
          '<div class="row" style="margin-top:12px;justify-content:flex-end"><button class="btn" data-demo="reject">Reject</button><button class="btn primary" data-demo="confirm">Confirm all</button></div>',
        onClose: function () { if (!decided) { decided = true; resolve(false); } },
      });
      m.el.addEventListener('click', function (e) {
        const b = e.target.closest('[data-demo]');
        if (!b || decided) return;
        decided = true;
        resolve(b.getAttribute('data-demo') === 'confirm');
        m.close();
      });
    });
  }
  function addrHtml(network, a) {
    if (!a) return '<span class="soft">not set</span>';
    const url = Thc.explorerAddress(network, a);
    const short = esc(Thc.shortAddress(a));
    return url ? '<a class="addr" href="' + esc(url) + '" target="_blank" rel="noopener" title="' + esc(a) + '">' + short + '</a>' : '<span class="addr" title="' + esc(a) + ' (simulated chain)">' + short + '</span>';
  }
  function txHtml(network, hash) {
    if (!hash) return '<span class="soft">–</span>';
    const url = Thc.explorerTx(network, hash);
    const short = esc(hash.slice(0, 10) + '…');
    return url ? '<a class="addr" href="' + esc(url) + '" target="_blank" rel="noopener">' + short + ' ↗</a>' : '<span class="addr" title="Simulated chain transaction ' + esc(hash) + '">' + short + '</span>';
  }
  function netPill(network) {
    if (network === 'sim') return '<span class="pill">🧪 Simulated chain</span>';
    if (network === 'bsc') return '<span class="pill ok">BNB Smart Chain</span>';
    return '<span class="pill bad">Wrong network</span>';
  }
  const STATUS_TEXT = { queued: 'waiting for treasury', open: 'awaiting payment', sending: 'sending', submitted: 'confirming', confirmed: 'paid', paid: 'received', failed: 'failed', cancelled: 'cancelled', expired: 'expired' };
  const STATUS_CLASS = { queued: 'warn', open: 'warn', sending: 'link', submitted: 'link', confirmed: 'ok', paid: 'ok', failed: 'bad', cancelled: '', expired: '' };
  function statusPill(s) { return '<span class="pill ' + (STATUS_CLASS[s] || '') + '">' + esc(STATUS_TEXT[s] || s) + '</span>'; }
  function deepLinks() {
    const here = location.host + location.pathname + location.hash;
    return '<a class="btn sm" href="https://metamask.app.link/dapp/' + esc(here) + '">Open in MetaMask</a> <a class="btn sm" href="https://link.trustwallet.com/open_url?coin_id=20000714&amp;url=' + esc(encodeURIComponent(location.href)) + '">Open in Trust Wallet</a>';
  }

  function walletCardHtml(slot, conn, bal, rateE18) {
    if (!conn) {
      const options = walletOptions();
      let s = '<div class="wallet-opts">' + options.map(function (o) {
        const icon = o.icon ? '<img alt="" src="' + esc(o.icon) + '">' : '<span class="wicon">' + (o.demo ? '🧪' : '👛') + '</span>';
        return '<button class="wallet-opt" data-connect="' + esc(o.id) + '" data-slot="' + slot + '">' + icon + '<span><b>' + esc(o.name) + '</b><span class="tiny soft" style="display:block">' + esc(o.note || '') + '</span></span></button>';
      }).join('') + '</div>';
      if (options.length === 1) {
        s += '<p class="small muted" style="margin-top:10px">No browser wallet found. ' + (coarse
          ? 'On a phone, open LoopWork inside your wallet app to use real THC:</p><div class="row" style="margin-top:6px">' + deepLinks() + '</div>'
          : 'To use real THC on BNB Smart Chain, install <a href="https://metamask.io/download/" target="_blank" rel="noopener">MetaMask</a> or <a href="https://trustwallet.com/download" target="_blank" rel="noopener">Trust Wallet</a>.</p>');
      }
      return s + '<p class="tiny soft" style="margin-top:10px">🔒 LoopWork never asks for your seed phrase or private key. Every transfer is approved in your wallet.</p>';
    }
    const icon = conn.icon ? '<img alt="" src="' + esc(conn.icon) + '" class="wallet-icon">' : '<span>' + (conn.demo ? '🧪' : '👛') + '</span>';
    let s = '<div class="row between"><div class="row">' + icon + '<b>' + esc(conn.name) + '</b>' + netPill(conn.network) + '</div><button class="btn sm ghost" data-disconnect="' + slot + '">Disconnect</button></div>' +
      '<div class="addr" style="margin:8px 0;word-break:break-all">' + esc(conn.account) + '</div>';
    if (!conn.network) {
      return s + '<div class="callout">This wallet is on another network. THC lives on BNB Smart Chain.</div><div class="row" style="margin-top:8px"><button class="btn primary sm" data-switch="' + slot + '">Switch to BNB Smart Chain</button></div>';
    }
    s += '<div class="paylines"><div><span class="muted">THC</span><b>' + (bal ? esc(Thc.formatUnits(bal.thc)) + ' THC' + (rateE18 ? ' <span class="soft">≈ ' + LW.money(Thc.unitsToCents(bal.thc, rateE18)) + '</span>' : '') : '…') + '</b></div>' +
      '<div><span class="muted">' + Thc.NETWORKS[conn.network].native + ' for network fees</span><span>' + (bal ? formatNative(bal.native) : '…') + '</span></div></div>';
    s += '<div class="row" style="margin-top:10px">' + (conn.demo
      ? '<button class="btn sm" data-faucet="' + slot + '">🚰 Get demo THC</button>'
      : '<button class="btn sm" data-watch="' + slot + '">➕ Add THC to wallet</button><a class="btn sm ghost" target="_blank" rel="noopener" href="' + esc(Thc.explorerAddress('bsc', conn.account)) + '">BscScan ↗</a>') + '</div>';
    return s;
  }
  function bindWalletControls(root) {
    root.addEventListener('click', async function (e) {
      const b = e.target.closest('[data-connect],[data-disconnect],[data-switch],[data-faucet],[data-watch]');
      if (!b) return;
      if (b.hasAttribute('data-connect')) {
        const c = await LW.busy(b, function () { return connect(b.getAttribute('data-slot'), b.getAttribute('data-connect')); });
        if (c) { LW.toast('Connected ' + esc(c.name) + ' · <span class="addr">' + esc(Thc.shortAddress(c.account)) + '</span>', 'ok'); LW.render(); }
      } else if (b.hasAttribute('data-disconnect')) {
        disconnect(b.getAttribute('data-disconnect'));
        LW.render();
      } else if (b.hasAttribute('data-switch')) {
        const conn = slots[b.getAttribute('data-switch')];
        if (await LW.busy(b, async function () { await ensureBsc(conn.provider); return true; })) LW.render();
      } else if (b.hasAttribute('data-faucet')) {
        const conn = slots[b.getAttribute('data-faucet')];
        const r = await LW.busy(b, function () { return demoChainRpc('loopchain_faucet', [conn.account]); });
        if (r) { LW.toast(r.already ? 'This demo wallet has already had its free THC.' : '🚰 Added ' + esc(Thc.formatUnits(r.thc)) + ' demo THC and ' + formatNative(r.native) + ' tBNB for fees', r.already ? '' : 'ok'); LW.render(); }
      } else if (b.hasAttribute('data-watch')) {
        const conn = slots[b.getAttribute('data-watch')];
        if (await LW.busy(b, function () { return LW.thc.watchAsset(conn); })) LW.toast('THC added to your wallet\'s token list', 'ok');
      }
    });
  }
  function payoutRows(list, opts) {
    const btn = function (attr, id, label, title, solid) { return '<button class="btn sm' + (solid ? '' : ' ghost') + '" ' + attr + '="' + esc(id) + '"' + (title ? ' title="' + esc(title) + '"' : '') + '>' + label + '</button>'; };
    return list.map(function (p) {
      let action = '';
      let fix = null; // treasury-only recovery actions, on their own line under the payout: [label, buttons]
      if (p.status === 'queued') {
        action = (opts.treasury || p.network === 'sim'
          ? '<button class="btn sm primary" data-thc-pay="' + esc(p.id) + '">' + (opts.treasury ? 'Pay' : 'Pay now as treasury (demo)') + '</button>'
          : '<span class="tiny soft">The treasury pays it from Ops &amp; pay</span>') + ' ' + btn('data-thc-cancel', p.id, 'Cancel');
      } else if (p.status === 'sending') {
        const stale = lockStale(p);
        action = '<span class="tiny soft">' + (stale ? 'Stuck: a wallet window started sending this ' + LW.ago(p.sendingAt || p.createdAt) + ' and never finished' : 'Being signed in a wallet (' + LW.ago(p.sendingAt || p.createdAt) + ')') + '</span>';
        if (opts.treasury && stale) fix = ['Did that wallet send it?', btn('data-thc-attach', p.id, 'Yes: attach its transaction', 'Paste the hash if the wallet did send it', true) + btn('data-thc-release', p.id, 'No: release it', 'Only if nothing was sent')];
      } else if (p.status === 'submitted') {
        action = btn('data-thc-check', p.id, 'Check again', null, true);
        if (opts.treasury) {
          const old = Date.now() - (p.submittedAt || p.createdAt) > 120000;
          const full = window.LoopEngine.claimedHashes(p).length >= window.LoopEngine.MAX_TX_PER_RECORD; // another send couldn't be recorded
          fix = [old ? 'Not confirming?' : 'Sped up in your wallet?', btn('data-thc-attach', p.id, 'Attach transaction', 'For a transaction your wallet sped up or replaced') +
            (old && !full ? btn('data-thc-resend', p.id, 'Send again', 'Only if the first transaction was dropped') : '') +
            (old ? btn('data-thc-drop', p.id, 'Mark as dropped', 'If your wallet dropped or cancelled the transaction: the money goes back to the worker') : '')];
        }
      } else if (p.status === 'failed') {
        action = (p.dropped && p.txHash ? btn('data-thc-check', p.id, 'Check again', 'In case the dropped transaction went through after all', true) : '');
        if (opts.treasury) fix = ['Sent a replacement?', btn('data-thc-attach', p.id, 'Attach transaction', 'If a replacement transfer was sent')];
      }
      const cols = opts.showWorker ? 7 : 6;
      return '<tr' + (fix ? ' class="has-fix"' : '') + '><td class="nowrap small">' + LW.ago(p.createdAt) + '</td>' + (opts.showWorker ? '<td>' + esc(p.workerName) + '</td>' : '') +
        '<td><b>' + esc(p.thcReceived || p.thc) + ' THC</b><div class="tiny soft">' + LW.money(p.cents) + ' · ' + esc(Thc.NETWORKS[p.network].short) + '</div></td>' +
        '<td>' + addrHtml(p.network, p.to) + '</td><td>' + statusPill(p.status) + (p.note ? '<div class="tiny soft">' + esc(p.note) + '</div>' : '') + '</td>' +
        '<td>' + txHtml(p.network, p.txHash) +         '</td><td class="right act">' + (action ? '<div class="row" style="justify-content:flex-end;gap:6px">' + action + '</div>' : '') + '</td></tr>' +
        (fix ? '<tr class="fix"><td colspan="' + cols + '"><div class="row" style="justify-content:flex-end;gap:6px"><span class="tiny soft">' + esc(fix[0]) + '</span>' + fix[1] + '</div></td></tr>' : '');
    }).join('');
  }
  function payoutTable(list, opts) {
    return '<div class="table-wrap"><table><thead><tr><th>When</th>' + (opts.showWorker ? '<th>Worker</th>' : '') + '<th>Amount</th><th>To</th><th>Status</th><th>Transaction</th><th></th></tr></thead><tbody>' + payoutRows(list, opts) + '</tbody></table></div>';
  }
  /** Shared handlers for payout rows: pay, send again, attach, release, cancel, check again. */
  function bindPayoutActions(root, payouts, statusEl) {
    const SEL = ['data-thc-pay', 'data-thc-cancel', 'data-thc-check', 'data-thc-resend', 'data-thc-attach', 'data-thc-release', 'data-thc-drop'];
    root.addEventListener('click', async function (e) {
      const b = e.target.closest(SEL.map(function (a) { return '[' + a + ']'; }).join(','));
      if (!b) return;
      const attr = SEL.find(function (a) { return b.hasAttribute(a); });
      const p = payouts.find(function (x) { return x.id === b.getAttribute(attr); });
      if (!p) return;
      const setStatus = function (t) { if (statusEl && statusEl.isConnected) statusEl.textContent = t; };
      if (attr === 'data-thc-pay' || attr === 'data-thc-resend') {
        const resend = attr === 'data-thc-resend';
        if (resend && !window.confirm('Send this payout again? Only do this if the first transaction failed or was dropped in your wallet. If both go through, ' + p.workerName + ' is paid twice.')) return;
        const r = await LW.busy(b, function () { return payPayout(p, setStatus, { resend: resend }); });
        setStatus('');
        if (r && r.record) {
          LW.toast(r.record.status === 'confirmed' ? '💎 Paid ' + esc(r.record.thcReceived) + ' THC to ' + esc(r.record.workerName) + ', verified on-chain' + (r.record.note ? '. ' + esc(r.record.note) : '') : 'The transfer failed on-chain; the money is back in ' + esc(r.record.workerName) + '\'s balance', r.record.status === 'confirmed' ? 'ok' : 'bad', 6000);
        }
        LW.render();
      } else if (attr === 'data-thc-cancel') {
        if (await LW.busy(b, function () { return LW.api.call('cancelThc', { refType: 'payout', refId: p.id }); })) { LW.toast('Payout cancelled; the money is back in the available balance'); LW.render(); }
      } else if (attr === 'data-thc-attach') {
        if (await LW.busy(b, function () { return attachTx('payout', p); })) { LW.toast('Transaction attached. Press "Check again" once it confirms.', 'ok'); LW.render(); }
      } else if (attr === 'data-thc-release') {
        if (!window.confirm('Release this payout? Only do this if your wallet did NOT send it. If it did, use "Attach transaction" instead, or the worker could be paid twice.')) return;
        if (await LW.busy(b, function () { return LW.api.call('releaseThcTx', { refType: 'payout', refId: p.id, force: true }); })) { LW.toast('Released: the payout is waiting for the treasury again'); LW.render(); }
      } else if (attr === 'data-thc-drop') {
        if (!window.confirm('Mark this payout as dropped? Only do this if your wallet shows the transaction was dropped or cancelled. ' + p.workerName + ' gets ' + LW.money(p.cents) + ' back in their balance. If the transaction still goes through, it is recorded and their balance goes negative until new earnings cover it.')) return;
        if (await LW.busy(b, function () { return dropPayout(p); })) { LW.toast('Marked as dropped: ' + LW.money(p.cents) + ' is back in ' + esc(p.workerName) + '\'s balance'); LW.render(); }
      } else {
        const r = await LW.busy(b, function () { return checkAgain('payout', p); });
        if (r) { LW.toast('Transaction verified: ' + esc(r.record.status), 'ok'); LW.render(); }
      }
    });
  }
  async function autoRefresh(rate, chainInfoAt) {
    const jobs = [];
    const age = function (t) { const a = Date.now() - (t || 0); return a < 0 ? Infinity : a; }; // future timestamps count as stale
    if (age(rate.at) > 15 * 60 * 1000) jobs.push(LW.thcRefreshPrice());
    if (!chainInfoAt || age(chainInfoAt) > 6 * 3600 * 1000) jobs.push(LW.thcRefreshChainInfo());
    if (!jobs.length) return false;
    const res = await Promise.allSettled(jobs);
    return res.some(function (r) { return r.status === 'fulfilled'; });
  }

  // ---------------------------------------------------------------- THC wallet page
  let refreshedOnce = false;
  let flowRunning = false;
  LW.pages.wallet = async function (main) {
    requestWallets();
    await LW.sleep(30); // give injected wallets a moment to announce themselves
    const results = await Promise.all([LW.api.call('thc', { workerId: LW.me() }), restore('personal')]);
    const d = results[0], conn = results[1], w = d.worker, rate = d.rate;
    let bal = null;
    try { bal = conn ? await balancesOf(conn) : null; } catch (e) { bal = null; }
    const methodThc = w.payoutMethod === 'thc' && !!w.thcNetwork;
    const avail = w.balances.available;
    // Everything still in progress (at most a handful per worker), then the most recent finished ones.
    const mine = d.payouts.filter(function (p) { return p.worker === w.id; });
    const myActive = mine.filter(function (p) { return ['queued', 'sending', 'submitted'].indexOf(p.status) >= 0; });
    const myPayouts = myActive.concat(mine.filter(function (p) { return myActive.indexOf(p) < 0; }).slice(0, Math.max(0, 6 - myActive.length)));
    const linked = ['bsc', 'sim'].filter(function (n) { return w.wallets[n]; });
    const canLink = conn && conn.network && w.wallets[conn.network] !== conn.account;
    const treasury = conn && conn.network ? d.treasury[conn.network] : null;
    // Payments that were started but not confirmed, including expired ones that did get a transaction.
    const inFlight = d.invoices.filter(function (i) { return i.status === 'open' || i.status === 'sending' || i.status === 'submitted' || (i.status === 'expired' && i.txHash); });
    const activity = d.payouts.map(function (p) { return { at: p.createdAt, type: 'payout', label: 'Payout to ' + p.workerName, r: p }; })
      .concat(d.invoices.filter(function (i) { return ['cancelled', 'open', 'expired'].indexOf(i.status) < 0; }).map(function (i) { return { at: i.createdAt, type: 'invoice', label: 'Sponsorship from ' + (i.sponsor || Thc.shortAddress(i.payer)) + ' · ' + i.skillName, r: i }; }))
      .sort(function (a, b) { return b.at - a.at; }).slice(0, 15);

    main.innerHTML =
      '<section class="card hero thc-hero"><div>' +
        '<div class="eyebrow">💎 Transhuman Coin</div><h1>Pay and get paid in THC</h1>' +
        '<p class="lead">THC is a BEP-20 token on BNB Smart Chain that funds longevity and decentralised science research. On LoopWork you can take your earnings in THC, or pay THC into the platform treasury to fund the training data robots need. Every transfer is approved in your own wallet and checked on-chain before any money moves.</p>' +
        '<div class="small muted">Contract <a class="addr" href="' + esc(Thc.explorerToken()) + '" target="_blank" rel="noopener">' + esc(Thc.shortAddress(Thc.TOKEN.address)) + ' ↗</a> · ' + Thc.TOKEN.decimals + ' decimals · transfer fee ' + d.feePct + '% · max ' + esc(d.maxTx) + ' THC per transfer · <a href="' + esc(Thc.TOKEN.website) + '" target="_blank" rel="noopener">transhumancoin.finance</a></div>' +
      '</div><div class="hero-side">' +
        '<div class="small muted">1 THC</div><div class="hero-metric"><span class="big">$' + esc(rate.usdPerThc.toPrecision(4)) + '</span></div>' +
        '<div class="small muted">$1 = ' + esc(rate.thcPerUsd) + ' THC</div>' +
        '<div class="tiny soft">' + esc(rate.source) + ' · ' + LW.ago(rate.at) + '</div>' +
        '<div><button class="btn sm" data-price="1">↻ Refresh price</button></div>' +
      '</div></section>' +
      '<section class="grid two">' +
        '<div class="card"><div class="card-head"><h2>Your wallet</h2><span class="small muted">acting as ' + esc(w.name) + '</span></div>' + walletCardHtml('personal', conn, bal, rate.rateE18) + '</div>' +
        '<div class="card"><div class="card-head"><h2>Get paid in THC</h2><span class="small muted">' + esc(w.name) + '</span></div>' +
          '<div class="small muted">Available to cash out</div><div style="font-size:28px;font-weight:750">' + LW.money(avail) + '</div>' +
          (avail > 0 ? '<div class="small muted">≈ ' + esc(Thc.formatUnits(Thc.centsToUnits(avail, rate.rateE18))) + ' THC at today\'s price</div>' : '') +
          (w.balances.processing ? '<div class="small muted">' + LW.money(w.balances.processing) + ' on its way in THC</div>' : '') +
          '<div style="margin-top:12px"><div class="small muted" style="margin-bottom:6px">Payout method</div><div class="chips">' +
            '<button class="chip ' + (!methodThc ? 'on' : '') + '" data-method="bank">🏦 ' + esc(w.payout) + ' (simulated)</button>' +
            '<button class="chip ' + (methodThc ? 'on' : '') + '" data-method="thc">💎 THC to my wallet</button></div></div>' +
          (linked.length ? '<div class="paylines" style="margin-top:10px">' + linked.map(function (n) {
            return '<div><span class="muted">' + esc(Thc.NETWORKS[n].label) + (w.thcNetwork === n && methodThc ? ' · payouts go here' : '') + '</span><span>' + addrHtml(n, w.wallets[n]) + ' <button class="btn sm ghost" data-unlink="' + n + '">Unlink</button></span></div>';
          }).join('') + '</div>' : '<p class="small muted" style="margin-top:10px">No wallet linked yet. Connect one, then link it here.</p>') +
          (canLink ? '<button class="btn sm" data-link="1" style="margin-top:8px">🔗 Link ' + esc(Thc.shortAddress(conn.account)) + ' (' + esc(Thc.NETWORKS[conn.network].short) + ') for payouts</button>' : '') +
          '<div class="row" style="margin-top:12px"><button class="btn primary" data-cashout="1" ' + (avail > 0 ? '' : 'disabled') + '>' + (methodThc ? 'Cash out ' + LW.money(Math.max(0, avail)) + ' as THC' : 'Cash out ' + LW.money(Math.max(0, avail))) + '</button>' +
            (avail > 0 ? '' : avail < 0 ? '<span class="small muted">A THC payout went through after it had failed, so ' + LW.money(-avail) + ' comes out of new earnings first.</span>' : '<span class="small muted">Earn by filling bounties in the <a href="#/worker">Worker app</a></span>') + '</div>' +
          '<p class="small muted" data-status="receive" style="margin-top:6px"></p>' +
          (myPayouts.length ? payoutTable(myPayouts, {}) : '') +
        '</div>' +
      '</section>' +
      '<section class="card"><div class="card-head"><div><h2>Fund training data with THC</h2><div class="small muted">Pay THC into the platform treasury. It becomes a sponsored bounty that teleoperators earn from while the fleet learns the skill.</div></div></div>' +
        '<div class="grid two"><div>' +
          '<label class="small muted" for="spSkill">Skill</label><select id="spSkill" style="width:100%;margin:4px 0 12px">' + d.skills.map(function (s) {
            return '<option value="' + esc(s.id) + '">' + esc(s.name) + ' · fleet ' + LW.pct(s.fleetSuccess) + ' · ' + s.demos + ' demos</option>';
          }).join('') + '</select>' +
          '<div class="small muted">Amount (US$ value)</div><div class="chips" style="margin:4px 0 8px">' + [500, 1000, 2500, 5000].map(function (c) {
            return '<button class="chip ' + (c === 1000 ? 'on' : '') + '" data-amt="' + c + '">' + LW.money(c, 0) + '</button>';
          }).join('') + '</div>' +
          '<input type="number" id="spCustom" min="1" max="1000" step="1" placeholder="Custom $1–1,000" style="width:170px" aria-label="Custom amount in US dollars">' +
        '</div><div>' +
          '<div class="paylines" id="spSummary"></div>' +
          '<div class="row" style="margin-top:12px"><button class="btn primary" id="spPay">Pay with THC</button></div>' +
          '<p class="small muted" data-status="sponsor" style="margin-top:6px"></p>' +
        '</div></div>' +
        (inFlight.length ? '<h3 style="margin-top:14px">Payments in progress</h3><div class="table-wrap"><table><thead><tr><th>Started</th><th>For</th><th>Amount</th><th>Status</th><th>Transaction</th><th></th></tr></thead><tbody>' + inFlight.map(function (i) {
          let act = '';
          if (i.status === 'open') {
            act = '<button class="btn sm ghost" data-inv-cancel="' + esc(i.id) + '" title="Nothing has been sent for this request">Cancel</button>';
          } else if (i.status === 'submitted' || i.status === 'expired') {
            act = (i.txHash ? '<button class="btn sm" data-inv-check="' + esc(i.id) + '">Check again</button> ' : '') + '<button class="btn sm ghost" data-inv-attach="' + esc(i.id) + '" title="For a transaction your wallet sped up or replaced">Attach transaction</button> <button class="btn sm ghost" data-inv-cancel="' + esc(i.id) + '">Cancel</button>';
          } else if (i.status === 'sending') {
            act = lockStale(i) ? '<button class="btn sm ghost" data-inv-attach="' + esc(i.id) + '" title="Paste the hash if the wallet did send it">Attach transaction</button> <button class="btn sm ghost" data-inv-release="' + esc(i.id) + '" title="Only if nothing was sent">Release</button>' : '<span class="tiny soft">Being signed in a wallet</span>';
          }
          return '<tr><td class="nowrap small">' + LW.ago(i.createdAt) + '</td><td>' + esc(i.skillName) + '<div class="tiny soft">from ' + addrHtml(i.network, i.payer) + '</div></td><td><b>' + esc(i.thcGross) + ' THC</b><div class="tiny soft">' + LW.money(i.cents) + '</div></td><td>' + statusPill(i.status) + (i.note ? '<div class="tiny soft">' + esc(i.note) + '</div>' : '') + '</td><td>' + txHtml(i.network, i.txHash) + '</td><td class="right nowrap">' + act + '</td></tr>';
        }).join('') + '</tbody></table></div>' : '') +
        (d.sponsored.length ? '<h3 style="margin-top:14px">Sponsored bounties</h3><div class="table-wrap"><table><thead><tr><th>Bounty</th><th>Funding</th><th>Progress</th><th>Status</th><th>Transaction</th></tr></thead><tbody>' + d.sponsored.map(function (b) {
          return '<tr><td>' + esc(b.title) + '<div class="tiny soft">' + LW.money(b.rateCents) + ' per demo</div></td><td>' + esc(b.sponsored.thc) + ' THC<div class="tiny soft">' + LW.money(b.sponsored.cents) + ' from ' + addrHtml(b.sponsored.network, b.sponsored.payer) + '</div></td><td>' + b.filled + ' / ' + b.target + '</td><td>' + LW.statusPill(b.status) + '</td><td>' + txHtml(b.sponsored.network, b.sponsored.txHash) + '</td></tr>';
        }).join('') + '</tbody></table></div>' : '') +
      '</section>' +
      '<section class="card"><div class="card-head"><h2>THC activity</h2><span class="small muted">payouts and payments on this platform</span></div>' +
        (activity.length ? '<div class="table-wrap"><table><thead><tr><th>When</th><th>What</th><th>Amount</th><th>Network</th><th>Status</th><th>Transaction</th></tr></thead><tbody>' + activity.map(function (a) {
          const r = a.r;
          return '<tr><td class="nowrap small">' + LW.ago(a.at) + '</td><td>' + esc(a.label) + '</td><td><b>' + esc(r.thcReceived || r.thcGross) + ' THC</b><div class="tiny soft">' + LW.money(r.creditCents != null ? r.creditCents : r.cents) + '</div></td><td>' + esc(Thc.NETWORKS[r.network].short) + '</td><td>' + statusPill(r.status) + '</td><td>' + txHtml(r.network, r.txHash) + '</td></tr>';
        }).join('') + '</tbody></table></div>' : '<div class="empty">No THC has moved yet. Cash out in THC or fund a bounty to see it here.</div>') +
      '</section>';

    bindWalletControls(main);
    bindPayoutActions(main, myPayouts, LW.$('[data-status="receive"]', main));

    // sponsorship form
    let cents = 1000;
    const skillSel = LW.$('#spSkill', main), custom = LW.$('#spCustom', main), summary = LW.$('#spSummary', main), payBtn = LW.$('#spPay', main);
    function updateSummary() {
      const sk = d.skills.find(function (s) { return s.id === skillSel.value; }) || d.skills[0];
      const units = Thc.grossUp(Thc.centsToUnits(cents, rate.rateE18, true), d.feePct);
      const lines = ['<div><span class="muted">You pay</span><b>≈ ' + esc(Thc.formatUnits(units)) + ' THC</b></div>'];
      let ok = true;
      if (!conn) { lines.push('<div><span class="muted">From</span><span>connect a wallet first</span></div>'); ok = false; }
      else if (!conn.network) { lines.push('<div><span class="muted">From</span><span>switch your wallet to BNB Smart Chain</span></div>'); ok = false; }
      else {
        lines.push('<div><span class="muted">To the treasury</span><span>' + (treasury ? addrHtml(conn.network, treasury) + ' · ' + esc(Thc.NETWORKS[conn.network].short) : '<span style="color:var(--cp-warning)">no ' + esc(Thc.NETWORKS[conn.network].label) + ' treasury yet (Ops &amp; pay → THC treasury)</span>') + '</span></div>');
        if (!treasury) ok = false;
        if (treasury && treasury === conn.account) lines.push('<div class="tiny" style="color:var(--cp-warning)">This wallet is also the platform treasury, so the THC comes straight back to you.</div>');
      }
      if (sk) lines.push('<div><span class="muted">Funds</span><span>about ' + Math.max(1, Math.floor(cents / Math.min(sk.rateCents, cents))) + ' "' + esc(sk.name) + '" demos at ' + LW.money(Math.min(sk.rateCents, cents)) + '</span></div>');
      summary.innerHTML = lines.join('');
      payBtn.disabled = !ok || !(cents >= 100 && cents <= 100000);
      payBtn.textContent = 'Pay ' + Thc.formatUnits(units) + ' THC';
    }
    main.addEventListener('click', function (e) {
      const a = e.target.closest('[data-amt]');
      if (!a) return;
      cents = Number(a.getAttribute('data-amt'));
      custom.value = '';
      LW.$$('[data-amt]', main).forEach(function (x) { x.classList.toggle('on', x === a); });
      updateSummary();
    });
    custom.addEventListener('input', function () {
      const v = Math.round(Number(custom.value) * 100);
      if (v) { cents = v; LW.$$('[data-amt]', main).forEach(function (x) { x.classList.remove('on'); }); }
      updateSummary();
    });
    skillSel.addEventListener('change', updateSummary);
    updateSummary();
    payBtn.addEventListener('click', async function () {
      const statusEl = LW.$('[data-status="sponsor"]', main);
      flowRunning = true;
      const r = await LW.busy(payBtn, function () { return sponsor(skillSel.value, cents, function (t) { if (statusEl.isConnected) statusEl.textContent = t; }); });
      flowRunning = false;
      if (statusEl.isConnected) statusEl.textContent = '';
      if (r && r.bounty) { LW.toast('💎 Payment verified on-chain. New sponsored bounty: ' + r.bounty.target + ' "' + esc(r.bounty.skillName) + '" demos at ' + LW.money(r.bounty.rateCents), 'ok', 7000); LW.render(); }
      else if (r && r.record) { LW.toast('Payment recorded: ' + esc(r.record.status)); LW.render(); }
    });

    main.addEventListener('click', async function (e) {
      const b = e.target.closest('[data-method],[data-link],[data-unlink],[data-cashout],[data-price],[data-inv-check],[data-inv-cancel],[data-inv-attach],[data-inv-release]');
      if (!b) return;
      const invAttr = ['data-inv-check', 'data-inv-cancel', 'data-inv-attach', 'data-inv-release'].find(function (a) { return b.hasAttribute(a); });
      const inv = invAttr ? d.invoices.find(function (i) { return i.id === b.getAttribute(invAttr); }) : null;
      if (invAttr === 'data-inv-cancel') {
        if (inv.status !== 'open' && !window.confirm('Cancel this payment? Only do this if the transaction failed or was dropped. If it still goes through, the treasury keeps the THC without funding a bounty.')) return;
        if (await LW.busy(b, function () { return LW.api.call('cancelThc', { refType: 'invoice', refId: inv.id }); })) { LW.toast('Payment cancelled'); LW.render(); }
      } else if (invAttr === 'data-inv-check') {
        const r = await LW.busy(b, function () { return checkAgain('invoice', inv); });
        if (r) { LW.toast(r.bounty ? '💎 Payment verified on-chain. New sponsored bounty: ' + r.bounty.target + ' "' + esc(r.bounty.skillName) + '" demos' : 'Payment ' + esc(r.record.status), 'ok', 6000); LW.render(); }
      } else if (invAttr === 'data-inv-attach') {
        if (await LW.busy(b, function () { return attachTx('invoice', inv); })) { LW.toast('Transaction attached. Press "Check again" once it confirms.', 'ok'); LW.render(); }
      } else if (invAttr === 'data-inv-release') {
        if (!window.confirm('Release this payment? Only do this if your wallet did NOT send it. If it did, use "Attach transaction" instead.')) return;
        const released = await LW.busy(b, async function () {
          await LW.api.call('releaseThcTx', { refType: 'invoice', refId: inv.id, force: true });
          return LW.api.call('cancelThc', { refType: 'invoice', refId: inv.id });
        });
        if (released) { LW.toast('Released and cancelled: nothing was paid. Start a new payment whenever you like.'); LW.render(); }
      } else if (b.hasAttribute('data-method')) {
        const method = b.getAttribute('data-method');
        if (method === 'thc' && !linked.length) { LW.toast('Connect and link a wallet first', 'bad'); return; }
        if (await LW.busy(b, function () { return LW.api.call('setPayoutMethod', { workerId: w.id, method: method }); })) LW.render();
      } else if (b.hasAttribute('data-link')) {
        const r = await LW.busy(b, function () { return LW.api.call('linkWallet', { workerId: w.id, network: conn.network, address: conn.account }); });
        if (r) { LW.toast('🔗 Linked. ' + esc(possessive(w.name)) + ' payouts now go to this wallet in THC', 'ok'); LW.render(); }
      } else if (b.hasAttribute('data-unlink')) {
        if (await LW.busy(b, function () { return LW.api.call('unlinkWallet', { workerId: w.id, network: b.getAttribute('data-unlink') }); })) LW.render();
      } else if (b.hasAttribute('data-cashout')) {
        const r = await LW.busy(b, function () { return LW.api.call('payout', { workerId: w.id }); });
        if (r) {
          LW.toast(r.thcPayout ? '💎 Queued ' + esc(r.thcPayout.thc) + ' THC to <span class="addr">' + esc(Thc.shortAddress(r.thcPayout.to)) + '</span>. ' + (r.thcPayout.network === 'sim' ? 'Pay it below as the demo treasury.' : 'The treasury sends it from Ops & pay.') : '💸 Paid ' + LW.money(r.receipt.amountCents) + ' to ' + esc(r.receipt.method), 'ok', 6000);
          LW.render();
        }
      } else if (b.hasAttribute('data-price')) {
        if (await LW.busy(b, function () { return LW.thcRefreshPrice(); })) { LW.toast('THC price updated', 'ok'); LW.render(); }
      }
    });

    if (!refreshedOnce) {
      refreshedOnce = true;
      autoRefresh(rate, d.chainInfoAt).then(function (changed) {
        if (changed && !flowRunning && LW.route().name === 'wallet' && main.isConnected) LW.render();
      });
    }
    return null;
  };

  // ---------------------------------------------------------------- Ops & pay: THC treasury card
  LW.renderThcTreasury = async function (el) {
    requestWallets();
    await LW.sleep(30);
    const results = await Promise.all([LW.api.call('thc'), restore('treasury')]);
    const d = results[0], conn = results[1];
    let bal = null, simBal = null;
    try { bal = conn ? await balancesOf(conn) : null; } catch (e) { bal = null; }
    try { simBal = Thc.decodeUint(await demoChainRpc('eth_call', [{ to: Thc.TOKEN.address, data: Thc.encodeBalanceOf(d.treasury.sim) }, 'latest'])); } catch (e) { simBal = null; }
    if (!el.isConnected) return;
    const queue = d.payouts.filter(function (p) { return p.status === 'queued' || p.status === 'sending' || p.status === 'submitted'; });
    const simQueued = queue.filter(function (p) { return p.status === 'queued' && p.network === 'sim'; });
    const recent = d.payouts.filter(function (p) { return p.status === 'confirmed' || p.status === 'failed' || p.status === 'cancelled'; }).slice(0, 5);
    const rate = d.rate;
    el.innerHTML = '<div class="card-head"><h2>💎 THC treasury</h2><span class="small muted">1 THC = $' + esc(rate.usdPerThc.toPrecision(4)) + ' · ' + esc(rate.source) + ' · ' + LW.ago(rate.at) + '</span></div>' +
      '<div class="grid two"><div>' +
        '<h3>Treasury addresses</h3><div class="paylines" style="margin-top:6px">' +
          '<div><span class="muted">Simulated chain</span><span>' + addrHtml('sim', d.treasury.sim) + (simBal != null ? ' · ' + esc(Thc.formatUnits(simBal, 0)) + ' THC' : '') + '</span></div>' +
          '<div><span class="muted">BNB Smart Chain</span><span>' + addrHtml('bsc', d.treasury.bsc) + '</span></div></div>' +
          (conn && conn.network === 'bsc' && conn.account !== d.treasury.bsc ? '<button class="btn sm" data-settreasury="1" style="margin-top:8px">Use ' + esc(Thc.shortAddress(conn.account)) + ' as the BNB Smart Chain treasury</button>' : '') +
        '<h3 style="margin-top:14px">Treasury wallet</h3><p class="tiny soft" style="margin:4px 0 8px">Needed to pay workers in real THC. Simulated-chain payouts are paid from the demo treasury.</p>' + walletCardHtml('treasury', conn, bal, rate.rateE18) +
      '</div><div>' +
        '<div class="row between"><h3>Payout queue</h3>' + (simQueued.length > 1 ? '<button class="btn sm" data-payall-sim="1">Pay all ' + simQueued.length + ' on the simulated chain</button>' : '') + '</div>' +
        (queue.length ? payoutTable(queue, { treasury: true, showWorker: true }) : '<div class="empty" style="margin-top:6px">No THC payouts waiting. Workers who choose THC appear here when they cash out or in a payout batch.</div>') +
        '<p class="small muted" data-status="treasury" style="margin-top:6px"></p>' +
        (recent.length ? '<h3 style="margin-top:12px">Recently settled</h3>' + payoutTable(recent, { treasury: true, showWorker: true }) : '') +
        '<div class="paylines" style="margin-top:12px">' +
          '<div><span class="muted">Paid out in THC</span><span>' + esc(Thc.formatUnits(d.totals.paid.bsc)) + ' real · ' + esc(Thc.formatUnits(d.totals.paid.sim)) + ' simulated</span></div>' +
          '<div><span class="muted">Received from sponsors</span><span>' + esc(Thc.formatUnits(d.totals.received.bsc)) + ' real · ' + esc(Thc.formatUnits(d.totals.received.sim)) + ' simulated</span></div></div>' +
        '<div class="row" style="margin-top:10px"><button class="btn sm" data-price="1">↻ Refresh THC price</button><button class="btn sm" data-chaininfo="1">Read fee &amp; limit from BNB Smart Chain</button></div>' +
        '<div class="tiny soft" style="margin-top:6px">Transfer fee ' + d.feePct + '% · max ' + esc(d.maxTx) + ' THC per transfer' + (d.chainInfoAt ? ' · read from the contract ' + LW.ago(d.chainInfoAt) : ' · not read from the contract yet') + '</div>' +
      '</div></div>';
    bindWalletControls(el);
    const statusEl = LW.$('[data-status="treasury"]', el);
    bindPayoutActions(el, queue.concat(recent), statusEl);
    el.addEventListener('click', async function (e) {
      const b = e.target.closest('[data-settreasury],[data-payall-sim],[data-price],[data-chaininfo]');
      if (!b) return;
      if (b.hasAttribute('data-settreasury')) {
        if (await LW.busy(b, function () { return LW.api.call('setTreasury', { network: 'bsc', address: conn.account }); })) { LW.toast('BNB Smart Chain treasury set. Sponsors\' THC goes to this wallet.', 'ok'); LW.render(); }
      } else if (b.hasAttribute('data-payall-sim')) {
        const tconn = demoTreasury();
        if (!(await confirmDemoBatch(simQueued))) return;
        tconn.provider.preapproved = simQueued.length;
        let done = 0;
        await LW.busy(b, async function () {
          for (const p of simQueued) {
            const r = await payPayout(p, function (t) { if (statusEl.isConnected) statusEl.textContent = (done + 1) + '/' + simQueued.length + ' · ' + t; });
            if (r && r.record && r.record.status === 'confirmed') done++;
          }
        });
        tconn.provider.preapproved = 0;
        LW.toast('💎 Paid ' + done + ' THC payouts on the simulated chain, each verified from its receipt', done ? 'ok' : 'bad', 6000);
        LW.render();
      } else if (b.hasAttribute('data-price')) {
        if (await LW.busy(b, function () { return LW.thcRefreshPrice(); })) { LW.toast('THC price updated', 'ok'); LW.render(); }
      } else if (b.hasAttribute('data-chaininfo')) {
        const r = await LW.busy(b, function () { return LW.thcRefreshChainInfo(); });
        if (r) { LW.toast('Read from the THC contract: ' + r.feePct + '% transfer fee, max ' + esc(r.maxTx) + ' THC per transfer', 'ok'); LW.render(); }
      }
    });
  };
})(window.LW);
