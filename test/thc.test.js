'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Sim = require('../public/lib/sim.js');
const Thc = require('../public/lib/thc.js');
const LoopChain = require('../public/lib/chain.js');
const E = require('../public/lib/engine.js');
const { createServer } = require('../server.js');
const real = require('./fixtures/bsc-thc-transfer-receipt.json');

const T0 = Date.UTC(2026, 9, 21, 0, 0, 0);
const TREASURY = Thc.demoAddress('treasury');
const YOU = Thc.demoAddress('worker:w_you');

function fresh() { return { state: E.createState({ now: T0, seed: 4321 }), rt: E.createRuntime() }; }
function call(box, op, args, now) { return E.dispatch(box, op, args || {}, { now: now || T0 }); }
function send(chain, from, to, units) {
  return chain.rpc({ method: 'eth_sendTransaction', params: [{ from: from, to: Thc.TOKEN.address, data: Thc.encodeTransfer(to, units) }] }, T0);
}
/** Give "You" some earned money by completing a takeover the honest way. */
function earn(box) {
  const iv = call(box, 'bounties', { workerId: 'w_you' }).bounties.find((b) => b.kind === 'intervention');
  const iss = call(box, 'issueEpisode', { workerId: 'w_you', bountyId: iv.id }, T0 + 1000);
  const r = Sim.mulberry32(9);
  const res = Sim.rollout(iss.episode.init, Sim.scriptedOperator(iss.episode.init, { precision: 0.95, care: 1, sortAccuracy: 1 }, r));
  call(box, 'submitEpisode', { workerId: 'w_you', episodeId: iss.episode.id, actions: Sim.encodeActions(res.actions) }, T0 + 1000 + res.state.t * 50 + 500);
  return call(box, 'workerDetail', { workerId: 'w_you' }).balances.available;
}

// ---------------------------------------------------------------- helpers
test('THC helpers verify a real BNB Smart Chain transfer receipt', () => {
  const v = Thc.verifyTransfer(real.receipt, { txHash: real.tx.hash, to: '0x72c45eefa7de373afc7998331775dc4a5a852e24' });
  assert.equal(v.ok, true);
  assert.equal(v.received, 1000n * Thc.UNIT);
  assert.equal(v.from, real.tx.from);
  const decoded = Thc.decodeTransferCall(real.tx.input);
  assert.deepEqual(decoded, { to: '0x72c45eefa7de373afc7998331775dc4a5a852e24', units: 1000n * Thc.UNIT });
  assert.equal(Thc.encodeTransfer(decoded.to, decoded.units), real.tx.input, 'our calldata is byte-identical to a real wallet transfer');
  assert.equal(Thc.verifyTransfer(real.receipt, { txHash: real.tx.hash, to: real.tx.from }).ok, false, 'wrong recipient');
  assert.equal(Thc.verifyTransfer(real.receipt, { txHash: '0x' + '1'.repeat(64), to: decoded.to }).ok, false, 'wrong transaction');
  assert.equal(Thc.verifyTransfer(Object.assign({}, real.receipt, { status: '0x0' }), { to: decoded.to }).reverted, true);
  const removed = JSON.parse(JSON.stringify(real.receipt));
  removed.logs[0].removed = true;
  assert.equal(Thc.verifyTransfer(removed, { to: decoded.to }).ok, false, 'logs from re-orged blocks are ignored');
  const otherToken = JSON.parse(JSON.stringify(real.receipt));
  otherToken.logs[0].address = '0x' + 'ab'.repeat(20);
  assert.equal(Thc.verifyTransfer(otherToken, { to: decoded.to }).ok, false, 'a look-alike token does not count');
  assert.equal(Thc.verifyTransfer(null, { to: decoded.to }).pending, true);
});

test('THC price and amount maths is exact', () => {
  const rate = Thc.rateToE18(0.00004089);
  assert.equal(rate, 40890000000000n);
  assert.equal(Thc.rateToE18('4.089e-5'), rate);
  assert.equal(Thc.rateToE18(1e-8), 10n ** 10n);
  assert.equal(Thc.centsToUnits(1000, rate), 244558571777940n, '$10 is 244,558.57 THC');
  assert.equal(Thc.unitsToCents(Thc.centsToUnits(1000, rate, true), rate), 1000);
  assert.equal(Thc.grossUp(96n * Thc.UNIT, 4), 100n * Thc.UNIT);
  assert.equal(Thc.grossUp(5n, 0), 5n);
  assert.equal(Thc.formatUnits(1234567890123456789n), '1,234,567,890.12');
  assert.equal(Thc.parseUnits('1000.5'), 1000500000000n);
  assert.throws(() => Thc.rateToE18(0));
  assert.throws(() => Thc.encodeTransfer('0x1234', 1n));
  assert.throws(() => Thc.encodeTransfer(YOU, 0n));
  assert.equal(Thc.decodeTransferCall(Thc.SEL.balanceOf + '0'.repeat(64)), null);
});

// ---------------------------------------------------------------- simulated chain
test('simulated chain mirrors THC: balances, fees, limits and receipts', () => {
  const c = new LoopChain.Chain();
  assert.equal(c.thcOf(TREASURY), LoopChain.TREASURY_THC);
  const f = c.rpc({ method: 'loopchain_faucet', params: [YOU] });
  assert.equal(BigInt(f.thc), LoopChain.FAUCET_THC);
  assert.equal(c.rpc({ method: 'loopchain_faucet', params: [YOU] }).already, true, 'one faucet drip per address');
  const h = send(c, TREASURY, YOU, 1000n * Thc.UNIT);
  assert.ok(Thc.isTxHash(h));
  const rc = c.rpc({ method: 'eth_getTransactionReceipt', params: [h] });
  assert.equal(Thc.verifyTransfer(rc, { txHash: h, to: YOU }).received, 1000n * Thc.UNIT);
  assert.deepEqual(Object.keys(rc).sort(), Object.keys(real.receipt).sort(), 'receipts have the same shape as real BSC ones');
  c.s.token.taxFee = 2; c.s.token.liquidityFee = 2;
  const h2 = send(c, TREASURY, YOU, Thc.grossUp(1000n * Thc.UNIT, 4));
  assert.ok(Thc.verifyTransfer(c.receipt(h2), { to: YOU }).received >= 1000n * Thc.UNIT, 'gross-up covers a 4% transfer fee');
  assert.throws(() => send(c, YOU, TREASURY, 10n ** 30n), /exceeds balance/);
  assert.throws(() => send(c, TREASURY, YOU, 90000000n * Thc.UNIT), /maxTxAmount/);
  assert.throws(() => send(c, Thc.demoAddress('nobody'), YOU, 1n), /insufficient funds for gas/);
  assert.throws(() => c.rpc({ method: 'eth_sign', params: [] }), (e) => e.code === -32601);
  assert.equal(Thc.decodeUint(c.rpc({ method: 'eth_call', params: [{ to: Thc.TOKEN.address, data: Thc.SEL.decimals }] })), 9n);
});

// ---------------------------------------------------------------- engine
test('new platforms have THC wallets for simulated workers; old saves are upgraded in place', () => {
  const box = fresh();
  const workers = call(box, 'workers').workers;
  const hana = workers.find((w) => w.id === 'w_hana');
  assert.equal(hana.payoutMethod, 'thc');
  assert.ok(Thc.isAddress(hana.wallets.sim));
  assert.deepEqual(workers.find((w) => w.id === 'w_you').wallets, {}, 'your real wallet is never invented');
  assert.equal(call(box, 'thc').treasury.sim, TREASURY);
  delete box.state.thc;
  box.state.workers.forEach((w) => { delete w.wallets; delete w.payoutMethod; });
  const upgraded = call(box, 'thc');
  assert.equal(upgraded.treasury.bsc, null);
  assert.ok(box.state.workers.every((w) => w.wallets && w.payoutMethod));
});

test('linking wallets and choosing THC payouts is validated', () => {
  const box = fresh();
  assert.throws(() => call(box, 'setPayoutMethod', { workerId: 'w_you', method: 'thc' }), (e) => e.status === 409);
  assert.throws(() => call(box, 'linkWallet', { workerId: 'w_you', network: 'eth', address: YOU }), (e) => e.status === 400);
  assert.throws(() => call(box, 'linkWallet', { workerId: 'w_you', network: 'sim', address: '0xnope' }), (e) => e.status === 400);
  const hanaSim = box.state.workers.find((w) => w.id === 'w_hana').wallets.sim;
  assert.throws(() => call(box, 'linkWallet', { workerId: 'w_you', network: 'sim', address: hanaSim }), (e) => e.status === 409);
  const linked = call(box, 'linkWallet', { workerId: 'w_you', network: 'sim', address: YOU.toUpperCase().replace('0X', '0x') }).worker;
  assert.equal(linked.wallets.sim, YOU, 'addresses are normalised');
  assert.equal(linked.payoutMethod, 'thc');
  assert.equal(call(box, 'setPayoutMethod', { workerId: 'w_you', method: 'bank' }).worker.payoutMethod, 'bank');
  assert.equal(call(box, 'unlinkWallet', { workerId: 'w_you', network: 'sim' }).worker.wallets.sim, undefined);
});

test('THC payout: funds are reserved, paid on-chain, verified, then marked paid', () => {
  const box = fresh();
  const chain = new LoopChain.Chain();
  const earned = earn(box);
  assert.ok(earned > 0);
  call(box, 'linkWallet', { workerId: 'w_you', network: 'sim', address: YOU });
  const res = call(box, 'payout', { workerId: 'w_you' }, T0 + 5000);
  const p = res.thcPayout;
  assert.equal(p.status, 'queued');
  assert.equal(BigInt(p.units), Thc.centsToUnits(earned, box.state.thc.rateE18));
  assert.deepEqual([res.balances.available, res.balances.processing, res.balances.paidOut], [0, earned, 0]);

  const hash = send(chain, TREASURY, p.to, BigInt(p.grossUnits));
  call(box, 'submitThcTx', { refType: 'payout', refId: p.id, txHash: hash });
  assert.throws(() => call(box, 'settleThc', { refType: 'payout', refId: p.id, txHash: hash, receipt: null }), (e) => e.status === 409, 'not mined yet');
  const settled = call(box, 'settleThc', { refType: 'payout', refId: p.id, txHash: hash, receipt: chain.receipt(hash) }, T0 + 9000);
  assert.equal(settled.record.status, 'confirmed');
  assert.equal(settled.record.receivedUnits, p.units);
  const bal = call(box, 'workerDetail', { workerId: 'w_you' }).balances;
  assert.deepEqual([bal.available, bal.processing, bal.paidOut], [0, 0, earned]);
  assert.equal(call(box, 'settleThc', { refType: 'payout', refId: p.id, txHash: hash, receipt: chain.receipt(hash) }).already, true, 'settling twice is a no-op');
  assert.equal(call(box, 'thc').totals.paid.sim, p.units);
});

test('THC payouts reject reused, wrong, early or failed transactions', () => {
  const box = fresh();
  const chain = new LoopChain.Chain();
  earn(box);
  call(box, 'linkWallet', { workerId: 'w_you', network: 'sim', address: YOU });
  box.state.ledger.push({ id: 'lx', worker: 'w_aisha', kind: 'bounty', cents: 500, ref: null, memo: 'test credit', status: 'available', at: T0 });
  const queued = call(box, 'payAll', {}, T0 + 100);
  assert.ok(queued.thcQueued >= 2, 'workers who prefer THC are queued for the treasury');
  const [a, b] = box.state.thc.payouts;
  const hash = send(chain, TREASURY, a.to, BigInt(a.grossUnits));
  call(box, 'submitThcTx', { refType: 'payout', refId: a.id, txHash: hash });
  call(box, 'settleThc', { refType: 'payout', refId: a.id, receipt: chain.receipt(hash) });
  assert.throws(() => call(box, 'submitThcTx', { refType: 'payout', refId: b.id, txHash: hash }), (e) => e.status === 409, 'one transaction cannot pay two payouts');
  assert.throws(() => call(box, 'settleThc', { refType: 'payout', refId: b.id, txHash: hash, receipt: chain.receipt(hash) }), (e) => e.status === 409, 'nor settle a payout it was not recorded against');
  // the THC must come from the treasury, reach the worker, and be sent after the payout was requested
  const stranger = Thc.demoAddress('stranger');
  chain.faucet(stranger);
  const fromStranger = send(chain, stranger, b.to, BigInt(b.grossUnits));
  call(box, 'submitThcTx', { refType: 'payout', refId: b.id, txHash: fromStranger });
  assert.throws(() => call(box, 'settleThc', { refType: 'payout', refId: b.id, receipt: chain.receipt(fromStranger) }), (e) => e.status === 422, 'THC from anyone but the treasury does not count');
  const toStranger = send(chain, TREASURY, stranger, BigInt(b.grossUnits));
  call(box, 'submitThcTx', { refType: 'payout', refId: b.id, txHash: toStranger, replace: true });
  assert.throws(() => call(box, 'settleThc', { refType: 'payout', refId: b.id, receipt: chain.receipt(toStranger) }), (e) => e.status === 422, 'money sent to the wrong wallet does not count');
  const early = chain.receipt(send(chain, TREASURY, b.to, BigInt(b.grossUnits)));
  early.logs[0].blockTimestamp = Thc.hexQty(Math.floor(T0 / 1000) - 3600); // an hour before the payout existed
  call(box, 'submitThcTx', { refType: 'payout', refId: b.id, txHash: early.transactionHash, replace: true });
  assert.throws(() => call(box, 'settleThc', { refType: 'payout', refId: b.id, receipt: early }), (e) => e.status === 422 && /before/.test(e.message), 'an older transfer does not count');
  assert.equal(box.state.thc.payouts.find((x) => x.id === b.id).status, 'submitted', 'rejected settlements change nothing');
  const good = send(chain, TREASURY, b.to, BigInt(b.grossUnits));
  call(box, 'submitThcTx', { refType: 'payout', refId: b.id, txHash: good, replace: true });
  assert.equal(call(box, 'settleThc', { refType: 'payout', refId: b.id, receipt: chain.receipt(good) }).record.status, 'confirmed', 'the right transaction still settles it');

  // a dropped transaction can be replaced, and every hash stays reserved for its payout
  const box3 = fresh();
  earn(box3);
  call(box3, 'linkWallet', { workerId: 'w_you', network: 'sim', address: YOU });
  const p3 = call(box3, 'payout', { workerId: 'w_you' }).thcPayout;
  const dropped = '0x' + 'd'.repeat(64);
  call(box3, 'submitThcTx', { refType: 'payout', refId: p3.id, txHash: dropped });
  assert.throws(() => call(box3, 'settleThc', { refType: 'payout', refId: p3.id, receipt: null }), (e) => e.status === 409);
  assert.throws(() => call(box3, 'cancelThc', { refType: 'payout', refId: p3.id }), (e) => e.status === 409, 'a sent payout cannot simply be cancelled');
  const resent = send(chain, TREASURY, p3.to, BigInt(p3.grossUnits));
  assert.throws(() => call(box3, 'submitThcTx', { refType: 'payout', refId: p3.id, txHash: resent }), (e) => e.status === 409, 'replacing needs an explicit flag');
  call(box3, 'submitThcTx', { refType: 'payout', refId: p3.id, txHash: resent, replace: true });
  assert.equal(call(box3, 'settleThc', { refType: 'payout', refId: p3.id, receipt: chain.receipt(resent) }).record.status, 'confirmed');
  assert.equal(box3.state.thc.usedTx[dropped], p3.id, 'the dropped hash can never settle another payout');

  // only a failed THC transfer from the treasury, recorded against the payout, fails it
  const box2 = fresh();
  earn(box2);
  call(box2, 'linkWallet', { workerId: 'w_you', network: 'sim', address: YOU });
  const p = call(box2, 'payout', { workerId: 'w_you' }).thcPayout;
  const fakeHash = '0x' + 'f'.repeat(64);
  const reverted = { transactionHash: fakeHash, status: '0x0', from: TREASURY, to: Thc.TOKEN.address, logs: [] };
  assert.throws(() => call(box2, 'settleThc', { refType: 'payout', refId: p.id, txHash: fakeHash, receipt: reverted }), (e) => e.status === 409, 'not before it is recorded against the payout');
  call(box2, 'submitThcTx', { refType: 'payout', refId: p.id, txHash: fakeHash });
  const otherContract = Object.assign({}, reverted, { to: '0x' + '42'.repeat(20) });
  assert.throws(() => call(box2, 'settleThc', { refType: 'payout', refId: p.id, receipt: otherContract }), (e) => e.status === 422, 'a failed call to another contract does not count');
  assert.equal(call(box2, 'settleThc', { refType: 'payout', refId: p.id, receipt: reverted }).record.status, 'failed');
  assert.equal(call(box2, 'workerDetail', { workerId: 'w_you' }).balances.available, p.cents, 'the money is back');
  // a queued payout can be cancelled before it is sent
  const p2 = call(box2, 'payout', { workerId: 'w_you' }).thcPayout;
  assert.equal(call(box2, 'cancelThc', { refType: 'payout', refId: p2.id }).record.status, 'cancelled');
  assert.equal(call(box2, 'workerDetail', { workerId: 'w_you' }).balances.available, p2.cents);
});

test('the sending lock stops double payments and cancels while a wallet signs', () => {
  const box = fresh();
  const chain = new LoopChain.Chain();
  earn(box);
  call(box, 'linkWallet', { workerId: 'w_you', network: 'sim', address: YOU });
  const p = call(box, 'payout', { workerId: 'w_you' }).thcPayout;
  const started = call(box, 'startThcTx', { refType: 'payout', refId: p.id }, T0 + 1000);
  assert.match(started.lock, /^[0-9a-f]{24,}$/, 'the window that locks it gets a secret token');
  assert.equal(started.record.lock, undefined, 'which never appears in shared views');
  assert.equal(call(box, 'thc').payouts.find((x) => x.id === p.id).lock, undefined);
  assert.throws(() => call(box, 'startThcTx', { refType: 'payout', refId: p.id }), (e) => e.status === 409 && /another window/.test(e.message), 'a second tab cannot pay it too');
  assert.throws(() => call(box, 'cancelThc', { refType: 'payout', refId: p.id }), (e) => e.status === 409, 'the worker cannot cancel while the treasury signs');
  assert.throws(() => call(box, 'releaseThcTx', { refType: 'payout', refId: p.id }, T0 + 2000), (e) => e.status === 409, 'another window cannot release it');
  assert.throws(() => call(box, 'releaseThcTx', { refType: 'payout', refId: p.id, force: true }, T0 + 2000), (e) => e.status === 409, 'not even by force while it is fresh');
  assert.throws(() => call(box, 'submitThcTx', { refType: 'payout', refId: p.id, txHash: '0x' + '9'.repeat(64) }, T0 + 2000), (e) => e.status === 409, 'nor record a transaction for it');
  assert.throws(() => call(box, 'settleThc', { refType: 'payout', refId: p.id, receipt: null }), (e) => e.status === 409 && /being sent/.test(e.message), 'nor check it mid-send');
  call(box, 'releaseThcTx', { refType: 'payout', refId: p.id, lock: started.lock });
  assert.equal(box.state.thc.payouts[0].status, 'queued', 'its own window releases it when the wallet sent nothing');
  // a window that vanished: after the timeout anyone may release, by force
  call(box, 'startThcTx', { refType: 'payout', refId: p.id }, T0 + 3000);
  assert.ok(call(box, 'releaseThcTx', { refType: 'payout', refId: p.id, force: true }, T0 + 3000 + 11 * 60e3));
  const lock = call(box, 'startThcTx', { refType: 'payout', refId: p.id }).lock;
  const h = send(chain, TREASURY, p.to, BigInt(p.grossUnits));
  call(box, 'submitThcTx', { refType: 'payout', refId: p.id, txHash: h, lock: lock });
  assert.throws(() => call(box, 'releaseThcTx', { refType: 'payout', refId: p.id, lock: lock }), (e) => e.status === 409, 'a sent payout cannot be released');
  assert.equal(call(box, 'settleThc', { refType: 'payout', refId: p.id, receipt: chain.receipt(h) }).record.status, 'confirmed');
  assert.throws(() => call(box, 'startThcTx', { refType: 'payout', refId: p.id }), (e) => e.status === 409, 'nor paid again');
});

test('a short transfer only counts for what arrived; a failed payout recovers if a replacement goes through', () => {
  const chain = new LoopChain.Chain();
  const setup = () => { const b = fresh(); earn(b); call(b, 'linkWallet', { workerId: 'w_you', network: 'sim', address: YOU }); return b; };
  const bal = (b) => call(b, 'workerDetail', { workerId: 'w_you' }).balances;
  const box = setup();
  const p = call(box, 'payout', { workerId: 'w_you' }).thcPayout;
  const half = BigInt(p.units) / 2n;
  const h = send(chain, TREASURY, p.to, half);
  call(box, 'submitThcTx', { refType: 'payout', refId: p.id, txHash: h });
  const r = call(box, 'settleThc', { refType: 'payout', refId: p.id, receipt: chain.receipt(h) }).record;
  assert.equal(r.status, 'confirmed');
  assert.ok(BigInt(r.shortfallUnits) > 0n && /short/.test(r.note));
  const paid = Thc.unitsToCents(half, p.rateE18);
  assert.deepEqual([bal(box).paidOut, bal(box).available, bal(box).processing], [paid, p.cents - paid, 0], 'the rest goes back to the available balance');

  const box2 = setup();
  const q = call(box2, 'payout', { workerId: 'w_you' }).thcPayout;
  const failedTx = (hash) => ({ transactionHash: hash, status: '0x0', from: TREASURY, to: Thc.TOKEN.address, logs: [] });
  const first = '0x' + 'a1'.repeat(32);
  call(box2, 'submitThcTx', { refType: 'payout', refId: q.id, txHash: first });
  const spedUp = '0x' + 'a2'.repeat(32);
  call(box2, 'submitThcTx', { refType: 'payout', refId: q.id, txHash: spedUp, replace: true });
  assert.throws(() => call(box2, 'settleThc', { refType: 'payout', refId: q.id, txHash: first, receipt: failedTx(first) }), (e) => e.status === 409 && /latest/.test(e.message), 'an older failed attempt cannot fail it while a newer one is pending');
  call(box2, 'settleThc', { refType: 'payout', refId: q.id, txHash: spedUp, receipt: failedTx(spedUp) });
  assert.equal(bal(box2).available, q.cents, 'the latest attempt failed, so the money came back');
  const replacement = send(chain, TREASURY, q.to, BigInt(q.grossUnits));
  assert.throws(() => call(box2, 'submitThcTx', { refType: 'payout', refId: q.id, txHash: replacement }), (e) => e.status === 409, 'a failed payout needs an explicit replacement');
  call(box2, 'submitThcTx', { refType: 'payout', refId: q.id, txHash: replacement, replace: true });
  assert.equal(call(box2, 'settleThc', { refType: 'payout', refId: q.id, receipt: chain.receipt(replacement) }).record.status, 'confirmed');
  assert.deepEqual([bal(box2).available, bal(box2).paidOut], [0, q.cents], 'the replacement went through, so the payout is reserved again');
});

test('money a failed payout gave back cannot leave twice', () => {
  const chain = new LoopChain.Chain();
  const box = fresh();
  box.state.ledger.push({ id: 'lx', worker: 'w_you', kind: 'bounty', cents: 2000, ref: null, memo: 'test', status: 'available', at: T0 });
  call(box, 'linkWallet', { workerId: 'w_you', network: 'sim', address: YOU });
  const bal = () => call(box, 'workerDetail', { workerId: 'w_you' }).balances;
  const total = bal().available;
  // P1 for half fails on-chain, so its money comes back...
  const p1 = call(box, 'payout', { workerId: 'w_you', amountCents: Math.floor(total / 2) }).thcPayout;
  const bad = '0x' + 'b1'.repeat(32);
  call(box, 'submitThcTx', { refType: 'payout', refId: p1.id, txHash: bad });
  call(box, 'settleThc', { refType: 'payout', refId: p1.id, receipt: { transactionHash: bad, status: '0x0', from: TREASURY, to: Thc.TOKEN.address, logs: [] } });
  assert.equal(bal().available, total);
  // ...the worker cashes all of it out again as P2, while the treasury had already re-sent P1
  const p2 = call(box, 'payout', { workerId: 'w_you' }).thcPayout;
  assert.equal(p2.cents, total);
  const rep = send(chain, TREASURY, p1.to, BigInt(p1.grossUnits));
  const attached = call(box, 'submitThcTx', { refType: 'payout', refId: p1.id, txHash: rep, replace: true }).record;
  assert.equal(attached.status, 'submitted', 'the replacement already left the treasury, so it is recorded');
  assert.match(attached.note, /on hold/);
  assert.equal(bal().available, -p1.cents, 'and takes P1\'s money back, overdrawing the worker while P2 holds it');
  assert.throws(() => call(box, 'startThcTx', { refType: 'payout', refId: p2.id }), (e) => e.status === 409 && /balance is -\$/.test(e.message), 'so P2 cannot be sent');
  const again = call(box, 'startThcTx', { refType: 'payout', refId: p1.id, resend: true, chain: { [rep]: null, [bad]: { transactionHash: bad, status: '0x0', from: TREASURY, to: Thc.TOKEN.address, logs: [] } } });
  call(box, 'releaseThcTx', { refType: 'payout', refId: p1.id, lock: again.lock });
  assert.equal(call(box, 'settleThc', { refType: 'payout', refId: p1.id, receipt: chain.receipt(rep) }).record.status, 'confirmed', '("Send again" on P1 stays possible: its money is already reserved)');
  call(box, 'cancelThc', { refType: 'payout', refId: p2.id });
  assert.deepEqual([bal().available, bal().paidOut, bal().processing], [total - p1.cents, p1.cents, 0], 'cancelling P2 leaves exactly what was not paid');
});

test('a replacement recorded after the money was paid out again shows as an overdraft', () => {
  const chain = new LoopChain.Chain();
  const box = fresh();
  box.state.ledger.push({ id: 'lx', worker: 'w_you', kind: 'bounty', cents: 2000, ref: null, memo: 'test', status: 'available', at: T0 });
  call(box, 'linkWallet', { workerId: 'w_you', network: 'sim', address: YOU });
  const bal = () => call(box, 'workerDetail', { workerId: 'w_you' }).balances;
  const total = bal().available;
  const p1 = call(box, 'payout', { workerId: 'w_you', amountCents: Math.floor(total / 2) }).thcPayout;
  const bad = '0x' + 'b3'.repeat(32);
  call(box, 'submitThcTx', { refType: 'payout', refId: p1.id, txHash: bad });
  call(box, 'settleThc', { refType: 'payout', refId: p1.id, receipt: { transactionHash: bad, status: '0x0', from: TREASURY, to: Thc.TOKEN.address, logs: [] } });
  call(box, 'payout', { workerId: 'w_you', method: 'bank' }); // everything paid out again, instantly
  const rep = send(chain, TREASURY, p1.to, BigInt(p1.grossUnits));
  call(box, 'submitThcTx', { refType: 'payout', refId: p1.id, txHash: rep, replace: true });
  const r = call(box, 'settleThc', { refType: 'payout', refId: p1.id, receipt: chain.receipt(rep) }).record;
  assert.equal(r.status, 'confirmed');
  assert.match(r.note, /until new earnings cover it/);
  assert.deepEqual([bal().available, bal().paidOut], [-p1.cents, total + p1.cents], 'the double payment is on the books');
  assert.throws(() => call(box, 'payout', { workerId: 'w_you' }), (e) => e.status === 409, 'and new earnings cover it before anything more is paid');
  box.state.ledger.push({ id: 'ly', worker: 'w_you', kind: 'bounty', cents: p1.cents + 500, ref: null, memo: 'test', status: 'available', at: T0 });
  const p3 = call(box, 'payout', { workerId: 'w_you' }).thcPayout;
  assert.equal(p3.cents, 500);
  assert.ok(call(box, 'startThcTx', { refType: 'payout', refId: p3.id }).lock);
});

test('a payout that goes through after it failed is recorded, and blocks more THC until covered', () => {
  const chain = new LoopChain.Chain();
  const box = fresh();
  box.state.ledger.push({ id: 'lx', worker: 'w_you', kind: 'bounty', cents: 2000, ref: null, memo: 'test', status: 'available', at: T0 });
  call(box, 'linkWallet', { workerId: 'w_you', network: 'sim', address: YOU });
  const bal = () => call(box, 'workerDetail', { workerId: 'w_you' }).balances;
  const total = bal().available;
  const p1 = call(box, 'payout', { workerId: 'w_you', amountCents: Math.floor(total / 2) }).thcPayout;
  // T1 is sent but looks stuck, so the treasury sends again: T2 reverts and fails the payout
  const t1 = send(chain, TREASURY, p1.to, BigInt(p1.grossUnits));
  call(box, 'submitThcTx', { refType: 'payout', refId: p1.id, txHash: t1 });
  const t2 = '0x' + 'b2'.repeat(32);
  call(box, 'submitThcTx', { refType: 'payout', refId: p1.id, txHash: t2, replace: true });
  call(box, 'settleThc', { refType: 'payout', refId: p1.id, txHash: t2, receipt: { transactionHash: t2, status: '0x0', from: TREASURY, to: Thc.TOKEN.address, logs: [] } });
  const p2 = call(box, 'payout', { workerId: 'w_you' }).thcPayout;
  // T1 went through after all: that THC really left, so it is recorded
  const r = call(box, 'settleThc', { refType: 'payout', refId: p1.id, txHash: t1, receipt: chain.receipt(t1) }).record;
  assert.equal(r.status, 'confirmed');
  assert.match(r.note, /after it had failed/);
  assert.equal(bal().available, -p1.cents, 'the worker is overdrawn by P1');
  assert.throws(() => call(box, 'startThcTx', { refType: 'payout', refId: p2.id }), (e) => e.status === 409 && /balance is -\$/.test(e.message), 'nothing more is sent until it is covered');
  call(box, 'cancelThc', { refType: 'payout', refId: p2.id });
  assert.equal(bal().available, total - p1.cents);
  const p3 = call(box, 'payout', { workerId: 'w_you' }).thcPayout;
  assert.ok(call(box, 'startThcTx', { refType: 'payout', refId: p3.id }).lock, 'the rest can be paid');
});

test('"Send again" cannot pay an overdrawn worker twice; marking a lost transaction as dropped fixes the books', () => {
  const box = fresh();
  box.state.ledger.push({ id: 'lx', worker: 'w_you', kind: 'bounty', cents: 2000, ref: null, memo: 'test', status: 'available', at: T0 });
  call(box, 'linkWallet', { workerId: 'w_you', network: 'sim', address: YOU });
  const bal = () => call(box, 'workerDetail', { workerId: 'w_you' }).balances;
  const total = bal().available;
  const p1 = call(box, 'payout', { workerId: 'w_you', amountCents: Math.floor(total / 2) }).thcPayout;
  const bad = '0x' + 'b5'.repeat(32);
  const reverted = (hash) => ({ transactionHash: hash, status: '0x0', from: TREASURY, to: Thc.TOKEN.address, logs: [] });
  call(box, 'submitThcTx', { refType: 'payout', refId: p1.id, txHash: bad });
  call(box, 'settleThc', { refType: 'payout', refId: p1.id, receipt: reverted(bad) });
  call(box, 'payout', { workerId: 'w_you', method: 'bank' }); // all of it paid out again
  // the treasury attaches a transaction to P1 that never lands
  const ghost = '0x' + 'b6'.repeat(32);
  call(box, 'submitThcTx', { refType: 'payout', refId: p1.id, txHash: ghost, replace: true });
  assert.equal(bal().available, -p1.cents);
  const seen = { [ghost]: null, [bad]: reverted(bad) }; // the chain has never seen the ghost
  assert.throws(() => call(box, 'startThcTx', { refType: 'payout', refId: p1.id, resend: true, chain: seen }), (e) => e.status === 409 && /twice/.test(e.message), 'sending it again could pay the worker twice');
  assert.throws(() => call(box, 'cancelThc', { refType: 'payout', refId: p1.id }), (e) => e.status === 409);
  // it can be marked as dropped, but only once every transaction recorded against it has been checked and none could still land
  assert.throws(() => call(box, 'dropThcTx', { refType: 'payout', refId: p1.id }), (e) => e.status === 400, 'the chain has to be checked first');
  assert.throws(() => call(box, 'dropThcTx', { refType: 'payout', refId: p1.id, chain: { [ghost]: null } }), (e) => e.status === 409 && /wasn't checked/.test(e.message), 'all of them');
  assert.throws(() => call(box, 'dropThcTx', { refType: 'payout', refId: p1.id, chain: { [ghost]: { pending: true }, [bad]: reverted(bad) } }), (e) => e.status === 409 && /waiting to be mined/.test(e.message));
  assert.throws(() => call(box, 'dropThcTx', { refType: 'invoice', refId: p1.id }), (e) => e.status === 400);
  const dropped = call(box, 'dropThcTx', { refType: 'payout', refId: p1.id, chain: seen }).record;
  assert.deepEqual([dropped.status, dropped.dropped], ['failed', true]);
  assert.deepEqual([bal().available, bal().processing, bal().paidOut], [0, 0, total], 'the books match what really happened');
  assert.throws(() => call(box, 'dropThcTx', { refType: 'payout', refId: p1.id }), (e) => e.status === 409, 'only once');
  // if it turns up after all and failed, the record just says so
  const late = call(box, 'settleThc', { refType: 'payout', refId: p1.id, receipt: reverted(ghost) }).record;
  assert.deepEqual([late.status, late.dropped, /reverted/.test(late.note)], ['failed', undefined, true]);
  assert.equal(bal().available, 0);
});

test('a transaction marked as dropped that lands after all is still recorded', () => {
  const chain = new LoopChain.Chain();
  const box = fresh();
  box.state.ledger.push({ id: 'lx', worker: 'w_you', kind: 'bounty', cents: 2000, ref: null, memo: 'test', status: 'available', at: T0 });
  call(box, 'linkWallet', { workerId: 'w_you', network: 'sim', address: YOU });
  const bal = () => call(box, 'workerDetail', { workerId: 'w_you' }).balances;
  const total = bal().available;
  const p = call(box, 'payout', { workerId: 'w_you', amountCents: 1000 }).thcPayout;
  const h = send(chain, TREASURY, p.to, BigInt(p.grossUnits));
  call(box, 'submitThcTx', { refType: 'payout', refId: p.id, txHash: h });
  call(box, 'dropThcTx', { refType: 'payout', refId: p.id, chain: { [h]: null } }); // nothing seen on-chain yet (say the RPC lagged)
  assert.equal(bal().available, total);
  const p2 = call(box, 'payout', { workerId: 'w_you' }).thcPayout;
  const r = call(box, 'settleThc', { refType: 'payout', refId: p.id, receipt: chain.receipt(h) }).record;
  assert.deepEqual([r.status, r.dropped], ['confirmed', undefined]);
  assert.equal(bal().available, -p.cents, 'the THC really left, so it is on the books');
  assert.throws(() => call(box, 'startThcTx', { refType: 'payout', refId: p2.id }), (e) => e.status === 409, 'and holds the worker\'s newer payout');
});

test('"Mark as dropped" and "Check again" look at every transaction sent for a payout', () => {
  const chain = new LoopChain.Chain();
  const box = fresh();
  box.state.ledger.push({ id: 'lx', worker: 'w_you', kind: 'bounty', cents: 2000, ref: null, memo: 'test', status: 'available', at: T0 });
  call(box, 'linkWallet', { workerId: 'w_you', network: 'sim', address: YOU });
  const bal = () => call(box, 'workerDetail', { workerId: 'w_you' }).balances;
  const total = bal().available;
  const p = call(box, 'payout', { workerId: 'w_you', amountCents: 1000 }).thcPayout;
  const h1 = send(chain, TREASURY, p.to, BigInt(p.grossUnits)); // it lands, but nobody has checked yet
  call(box, 'submitThcTx', { refType: 'payout', refId: p.id, txHash: h1 });
  // it looked stuck and the network hadn't seen it, so the treasury sent again, then cancelled that one in its wallet
  const lock = call(box, 'startThcTx', { refType: 'payout', refId: p.id, resend: true, chain: { [h1]: null } }).lock;
  const h2 = '0x' + 'e2'.repeat(32);
  call(box, 'submitThcTx', { refType: 'payout', refId: p.id, txHash: h2, lock: lock, replace: true });
  const seen = { [h2]: null, [h1]: chain.receipt(h1) };
  assert.throws(() => call(box, 'dropThcTx', { refType: 'payout', refId: p.id, chain: { [h2]: null } }), (e) => e.status === 409 && /wasn't checked/.test(e.message), 'every transaction recorded against it is checked');
  assert.throws(() => call(box, 'dropThcTx', { refType: 'payout', refId: p.id, chain: seen }), (e) => e.status === 409 && /already reached/.test(e.message), 'the first one paid it, so it was not dropped');
  const r = call(box, 'settleThc', { refType: 'payout', refId: p.id, chain: seen }).record;
  assert.deepEqual([r.status, r.txHash], ['confirmed', h1], '"Check again" settles it with the transaction that arrived');
  assert.deepEqual([bal().available, bal().paidOut, bal().processing], [total - p.cents, p.cents, 0]);
});

test('"Send again" needs every earlier transaction gone, and a payout sent twice is on the books', () => {
  const chain = new LoopChain.Chain();
  const setup = () => {
    const b = fresh();
    b.state.ledger.push({ id: 'lx', worker: 'w_you', kind: 'bounty', cents: 2000, ref: null, memo: 'test', status: 'available', at: T0 });
    call(b, 'linkWallet', { workerId: 'w_you', network: 'sim', address: YOU });
    return b;
  };
  const bal = (b) => call(b, 'workerDetail', { workerId: 'w_you' }).balances;
  const box = setup();
  const total = bal(box).available;
  const p = call(box, 'payout', { workerId: 'w_you' }).thcPayout;
  const h1 = send(chain, TREASURY, p.to, BigInt(p.grossUnits));
  call(box, 'submitThcTx', { refType: 'payout', refId: p.id, txHash: h1 });
  const resend = (seen) => call(box, 'startThcTx', { refType: 'payout', refId: p.id, resend: true, chain: seen });
  assert.throws(() => resend(undefined), (e) => e.status === 400, 'the chain has to be checked first');
  assert.throws(() => resend({ [h1]: chain.receipt(h1) }), (e) => e.status === 409 && /already reached/.test(e.message), 'not when the first one arrived');
  assert.throws(() => resend({ [h1]: { pending: true } }), (e) => e.status === 409 && /waiting to be mined/.test(e.message), 'nor while it could still arrive');
  // the network hadn't seen h1 yet, so the treasury sent again, and both transfers landed
  const lock = resend({ [h1]: null }).lock;
  const h2 = send(chain, TREASURY, p.to, BigInt(p.grossUnits));
  call(box, 'submitThcTx', { refType: 'payout', refId: p.id, txHash: h2, lock: lock, replace: true });
  const both = { [h2]: chain.receipt(h2), [h1]: chain.receipt(h1) };
  const r = call(box, 'settleThc', { refType: 'payout', refId: p.id, chain: both }).record;
  assert.equal(r.status, 'confirmed');
  assert.match(r.note, /Sent twice/);
  assert.equal(r.extraUnits, r.receivedUnits);
  assert.deepEqual([bal(box).available, bal(box).paidOut], [total - 2 * p.cents, 2 * p.cents], 'both transfers are on the books, the duplicate at the payout\'s value');
  assert.ok(bal(box).available < 0, 'overdrawing the worker, so nothing more is sent until new earnings cover it');
  assert.equal(call(box, 'settleThc', { refType: 'payout', refId: p.id, chain: both }).already, true, 'each transfer is booked once');
  assert.equal(call(box, 'thc').totals.paid.sim, (2n * BigInt(r.receivedUnits)).toString());
  // the same when each transaction is checked on its own (the browser build)
  const box2 = setup();
  const q = call(box2, 'payout', { workerId: 'w_you' }).thcPayout;
  const g1 = send(chain, TREASURY, q.to, BigInt(q.grossUnits));
  const g2 = send(chain, TREASURY, q.to, BigInt(q.grossUnits));
  call(box2, 'submitThcTx', { refType: 'payout', refId: q.id, txHash: g1 });
  call(box2, 'submitThcTx', { refType: 'payout', refId: q.id, txHash: g2, replace: true }); // attached a "speed up" that turned out to be a second transfer
  call(box2, 'settleThc', { refType: 'payout', refId: q.id, txHash: g2, receipt: chain.receipt(g2) });
  const second = call(box2, 'settleThc', { refType: 'payout', refId: q.id, txHash: g1, receipt: chain.receipt(g1) });
  assert.equal(second.already, false, 'the second transfer is recorded, not ignored');
  assert.equal(bal(box2).available, total - 2 * q.cents);
  assert.ok(bal(box2).available < 0);
});

test('the largest transfer settles a payout; a tiny extra one is accounted for without booking a cent', () => {
  const chain = new LoopChain.Chain();
  const box = fresh();
  box.state.ledger.push({ id: 'lx', worker: 'w_you', kind: 'bounty', cents: 2000, ref: null, memo: 'test', status: 'available', at: T0 });
  call(box, 'linkWallet', { workerId: 'w_you', network: 'sim', address: YOU });
  const bal = () => call(box, 'workerDetail', { workerId: 'w_you' }).balances;
  const total = bal().available;
  const p = call(box, 'payout', { workerId: 'w_you', amountCents: 1000 }).thcPayout;
  const h1 = send(chain, TREASURY, p.to, BigInt(p.grossUnits));
  const dust = send(chain, TREASURY, p.to, 100n * Thc.UNIT); // a test transfer, attached by mistake
  const h3 = send(chain, TREASURY, p.to, BigInt(p.grossUnits));
  call(box, 'submitThcTx', { refType: 'payout', refId: p.id, txHash: h1 });
  call(box, 'submitThcTx', { refType: 'payout', refId: p.id, txHash: h3, replace: true });
  call(box, 'submitThcTx', { refType: 'payout', refId: p.id, txHash: dust, replace: true }); // recorded last, so it is the newest
  const all = { [h3]: chain.receipt(h3), [dust]: chain.receipt(dust), [h1]: chain.receipt(h1) };
  const r = call(box, 'settleThc', { refType: 'payout', refId: p.id, chain: all }).record;
  assert.deepEqual([r.status, r.txHash, r.shortfallUnits], ['confirmed', h3, undefined], 'the newest full transfer settles it, not the newer tiny one');
  assert.equal(r.extraUnits, (BigInt(p.units) + 100n * Thc.UNIT).toString());
  assert.deepEqual([bal().available, bal().paidOut], [total - 2 * p.cents, 2 * p.cents], 'the full duplicate is booked at the payout\'s value; the tiny one is worth under a cent');
  assert.equal(call(box, 'settleThc', { refType: 'payout', refId: p.id, chain: all }).already, true);
});

test('at most eight unconfirmed transactions can be recorded against a payout or payment', () => {
  const chain = new LoopChain.Chain();
  const box = fresh();
  box.state.ledger.push({ id: 'lx', worker: 'w_you', kind: 'bounty', cents: 2000, ref: null, memo: 'test', status: 'available', at: T0 });
  call(box, 'linkWallet', { workerId: 'w_you', network: 'sim', address: YOU });
  const p = call(box, 'payout', { workerId: 'w_you', amountCents: 1000 }).thcPayout;
  const hash = (i) => '0x' + (i + 1).toString(16).padStart(64, 'f');
  const attach = (h, proof) => call(box, 'submitThcTx', { refType: 'payout', refId: p.id, txHash: h, replace: true, proof: proof });
  for (let i = 0; i < 8; i++) attach(hash(i));
  assert.throws(() => attach(hash(8)), (e) => e.status === 409 && /already has 8/.test(e.message) && /mark the payout as dropped/.test(e.message));
  assert.equal(attach(hash(3)).record.txHash, hash(3), 'one already recorded can still be pointed at');
  // "Send again" is refused before any wallet opens: its transfer couldn't be recorded
  const none = {};
  E.claimedHashes(box.state.thc.payouts[0]).forEach((h) => { none[h] = null; });
  assert.throws(() => call(box, 'startThcTx', { refType: 'payout', refId: p.id, resend: true, chain: none }), (e) => e.status === 409 && /can't be sent again/.test(e.message));
  assert.equal(box.state.thc.payouts[0].status, 'submitted', 'nothing was locked');
  // a transfer the chain shows arrived is always recorded, so it can be booked
  const real = send(chain, TREASURY, p.to, BigInt(p.grossUnits));
  const other = send(chain, TREASURY, p.to, 1n);
  assert.throws(() => attach(real, chain.receipt(other)), (e) => e.status === 409, 'only with its own receipt');
  assert.equal(attach(real, chain.receipt(real)).record.txHash, real);
  const seen = Object.assign({}, none, { [real]: chain.receipt(real) });
  assert.equal(call(box, 'settleThc', { refType: 'payout', refId: p.id, chain: seen }).record.status, 'confirmed');
});

test('payouts and payments in progress never drop out of view', () => {
  const box = fresh();
  box.state.ledger.push({ id: 'lx', worker: 'w_you', kind: 'bounty', cents: 1000, ref: null, memo: 'test', status: 'available', at: T0 });
  box.state.ledger.push({ id: 'ly', worker: 'w_aisha', kind: 'bounty', cents: 1000, ref: null, memo: 'test', status: 'available', at: T0 });
  call(box, 'linkWallet', { workerId: 'w_you', network: 'sim', address: YOU });
  const p = call(box, 'payout', { workerId: 'w_you', amountCents: 500 }).thcPayout;
  const inv = call(box, 'createThcInvoice', { network: 'sim', payer: YOU, skill: 'sort_laundry', usdCents: 100 }).invoice;
  for (let i = 0; i < 61; i++) {
    call(box, 'cancelThc', { refType: 'payout', refId: call(box, 'payout', { workerId: 'w_aisha', amountCents: 100, method: 'thc' }).thcPayout.id });
    call(box, 'cancelThc', { refType: 'invoice', refId: call(box, 'createThcInvoice', { network: 'sim', payer: TREASURY, skill: 'sort_laundry', usdCents: 100 }).invoice.id });
  }
  const d = call(box, 'thc');
  assert.ok(d.payouts.some((x) => x.id === p.id && x.status === 'queued'), 'the older payout is still listed, so it can be paid or cancelled');
  assert.ok(d.invoices.some((x) => x.id === inv.id && x.status === 'open'), 'and so is the older payment');
  assert.equal(d.payouts.length, 61, 'alongside the newest 60');
});

test('payments in flight are never trimmed, and THC abuse is bounded', () => {
  const box = fresh();
  const chain = new LoopChain.Chain();
  chain.faucet(YOU);
  const ask = (payer, now) => call(box, 'createThcInvoice', { network: 'sim', payer: payer, skill: 'sort_laundry', usdCents: 100 }, now).invoice;
  const keep = ask(YOU);
  const h = send(chain, YOU, keep.to, BigInt(keep.grossUnits));
  call(box, 'submitThcTx', { refType: 'invoice', refId: keep.id, txHash: h });
  for (let i = 0; i < 320; i++) call(box, 'cancelThc', { refType: 'invoice', refId: ask(YOU).id });
  assert.ok(box.state.thc.invoices.length <= 301, 'finished records are trimmed');
  assert.equal(call(box, 'settleThc', { refType: 'invoice', refId: keep.id, receipt: chain.receipt(h) }).record.status, 'paid', 'the payment in flight survived');
  // per payer: at most five unfinished payments
  for (let i = 0; i < 5; i++) ask(YOU);
  assert.throws(() => ask(YOU), (e) => e.status === 429 && /this wallet/i.test(e.message));
  // overall: at most 100 unfinished, including ones stuck mid-send, and they all expire after a day
  for (let i = 0; i < 95; i++) {
    const inv = ask(Thc.demoAddress('payer:' + i));
    if (i % 2) call(box, 'startThcTx', { refType: 'invoice', refId: inv.id }); // abandoned with the wallet prompt open
  }
  assert.throws(() => ask(Thc.demoAddress('one more')), (e) => e.status === 429, 'unpaid payment requests are capped');
  assert.ok(ask(Thc.demoAddress('one more'), T0 + 30 * 86400e3), 'stuck and abandoned ones expire, so the cap clears');
  const late = box.state.thc.invoices.find((i) => i.status === 'expired' && i.payer === Thc.demoAddress('payer:1'));
  assert.ok(late, 'a request stuck mid-send expired too');
  // a payment that expired but was actually sent can still be credited once it is recorded
  chain.faucet(late.payer);
  const lateTx = send(chain, late.payer, late.to, BigInt(late.grossUnits));
  call(box, 'submitThcTx', { refType: 'invoice', refId: late.id, txHash: lateTx, replace: true }, T0 + 30 * 86400e3);
  assert.equal(call(box, 'settleThc', { refType: 'invoice', refId: late.id, receipt: chain.receipt(lateTx) }).record.status, 'paid');
  // payouts: a $1 minimum and at most five in progress per worker
  call(box, 'linkWallet', { workerId: 'w_you', network: 'sim', address: YOU });
  box.state.ledger.push({ id: 'lx', worker: 'w_you', kind: 'bounty', cents: 10000, ref: null, memo: 'test', status: 'available', at: T0 });
  assert.throws(() => call(box, 'payout', { workerId: 'w_you', amountCents: 50 }), (e) => e.status === 409 && /start at/.test(e.message));
  for (let i = 0; i < 5; i++) call(box, 'payout', { workerId: 'w_you', amountCents: 100 });
  assert.throws(() => call(box, 'payout', { workerId: 'w_you', amountCents: 100 }), (e) => e.status === 409 && /in progress/.test(e.message));
  // a huge max-transfer value is refused, and formatting stays linear
  assert.throws(() => call(box, 'setThcChainInfo', { feePct: 0, maxTxUnits: '1' + '0'.repeat(60000) }), (e) => e.status === 400);
  assert.throws(() => call(box, 'setTreasury', { network: 'sim', address: YOU }), (e) => e.status === 400, 'the demo treasury is fixed');
  const t0 = Date.now();
  assert.equal(Thc.formatUnits(BigInt('1' + '0'.repeat(20009))).length, 20000 + Math.floor(19999 / 3) + 1);
  assert.ok(Date.now() - t0 < 1000, 'formatting a 20,000-digit amount is fast');
});

test('THC transfer fee and per-transfer limit are respected', () => {
  const box = fresh();
  earn(box);
  call(box, 'linkWallet', { workerId: 'w_you', network: 'sim', address: YOU });
  call(box, 'setThcChainInfo', { feePct: 4, maxTxUnits: (80000000n * Thc.UNIT).toString() });
  const p = call(box, 'payout', { workerId: 'w_you' }).thcPayout;
  assert.equal(BigInt(p.grossUnits), Thc.grossUp(BigInt(p.units), 4));
  call(box, 'cancelThc', { refType: 'payout', refId: p.id });
  call(box, 'setThcChainInfo', { feePct: 0, maxTxUnits: '1000' });
  assert.throws(() => call(box, 'payout', { workerId: 'w_you' }), (e) => e.status === 409 && /one transfer/.test(e.message));
  assert.throws(() => call(box, 'setThcChainInfo', { feePct: 80, maxTxUnits: '1' }), (e) => e.status === 400);
  assert.throws(() => call(box, 'setThcRate', { usdPerThc: -1 }), (e) => e.status === 400);
  assert.equal(call(box, 'setThcRate', { usdPerThc: 0.0001, source: 'Test' }).rate.usdPerThc, 0.0001);
});

test('paying THC into the treasury funds a sponsored bounty that workers can fill', () => {
  const box = fresh();
  const chain = new LoopChain.Chain();
  chain.faucet(YOU);
  assert.throws(() => call(box, 'createThcInvoice', { network: 'bsc', payer: YOU, skill: 'handle_glassware', usdCents: 1000 }), (e) => e.status === 409, 'no real treasury configured yet');
  assert.throws(() => call(box, 'createThcInvoice', { network: 'sim', payer: YOU, skill: 'handle_glassware', usdCents: 50 }), (e) => e.status === 400);
  const inv = call(box, 'createThcInvoice', { workerId: 'w_you', network: 'sim', payer: YOU, skill: 'handle_glassware', usdCents: 1000 }).invoice;
  assert.equal(inv.to, TREASURY);
  const hash = send(chain, YOU, inv.to, BigInt(inv.grossUnits));
  call(box, 'submitThcTx', { refType: 'invoice', refId: inv.id, txHash: hash });
  const res = call(box, 'settleThc', { refType: 'invoice', refId: inv.id, txHash: hash, receipt: chain.receipt(hash) }, T0 + 60000);
  assert.equal(res.record.status, 'paid');
  assert.equal(res.record.creditCents, 1000);
  const b = res.bounty;
  assert.ok(b.sponsored && b.sponsored.txHash === hash);
  assert.equal(b.target, Math.floor(1000 / b.rateCents));
  assert.equal(call(box, 'thc').totals.received.sim, inv.units);
  // sponsored bounties are never auto-closed or repriced by the fleet loop, and workers do fill them
  for (let i = 0; i < 4; i++) call(box, 'runCycle', {}, T0 + (i + 2) * 3600e3);
  const after = box.state.bounties.find((x) => x.id === b.id);
  assert.ok(after.status === 'open' || after.status === 'filled', 'still open or filled, never closed');
  assert.equal(after.rateCents, b.rateCents);
  assert.ok(after.filled > 0, 'simulated teleoperators filled some sponsored demos');
});

test('server: simulated-chain RPC works and THC settlement ignores client-supplied receipts', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loopwork-thc-'));
  let bscCalls = 0;
  const fetchBscReceipt = async (hash, fetchImpl, opts) => { bscCalls++; return opts && opts.pending ? { pending: true, transactionHash: hash } : null; };
  const app = createServer({ dataDir, reset: true, log: false, fetchBscReceipt });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + app.server.address().port;
  const api = async (method, url, body) => {
    const res = await fetch(base + url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json() };
  };
  const rpc = async (method, params) => (await api('POST', '/api/chain/rpc', { jsonrpc: '2.0', id: 7, method, params })).body;
  try {
    assert.equal((await rpc('eth_chainId', [])).result, Thc.NETWORKS.sim.chainId);
    assert.equal((await rpc('eth_sign', [])).error.code, -32601);
    await rpc('loopchain_faucet', [YOU]);
    const inv = (await api('POST', '/api/thc/invoices', { workerId: 'w_you', network: 'sim', payer: YOU, skill: 'sort_laundry', usdCents: 500 })).body.invoice;
    const hash = (await rpc('eth_sendTransaction', [{ from: YOU, to: Thc.TOKEN.address, data: Thc.encodeTransfer(inv.to, BigInt(inv.grossUnits)) }])).result;
    await api('POST', '/api/thc/tx', { refType: 'invoice', refId: inv.id, txHash: hash });
    const forged = { transactionHash: hash, status: '0x1', logs: [{ address: Thc.TOKEN.address, topics: [Thc.TRANSFER_TOPIC, '0x' + Thc.addressWord(YOU), '0x' + Thc.addressWord(inv.to)], data: '0x' + Thc.word(10n ** 20n), removed: false }] };
    const settled = await api('POST', '/api/thc/settle', { refType: 'invoice', refId: inv.id, txHash: hash, receipt: forged });
    assert.equal(settled.status, 200);
    assert.equal(settled.body.record.receivedUnits, inv.grossUnits, 'credited what the chain says, not the forged receipt');
    assert.equal(settled.body.record.creditCents, 500);
    const ghost = (await api('POST', '/api/thc/invoices', { workerId: 'w_you', network: 'sim', payer: YOU, skill: 'sort_laundry', usdCents: 500 })).body.invoice;
    await api('POST', '/api/thc/tx', { refType: 'invoice', refId: ghost.id, txHash: '0x' + 'a'.repeat(64) });
    const fake = await api('POST', '/api/thc/settle', { refType: 'invoice', refId: ghost.id, txHash: '0x' + 'a'.repeat(64), receipt: forged });
    assert.equal(fake.status, 409, 'a transaction the chain has never seen settles nothing, whatever receipt the client sends');
    await api('PATCH', '/api/thc/treasury', { network: 'bsc', address: '0x' + '12'.repeat(20) });
    const live = (await api('POST', '/api/thc/invoices', { network: 'bsc', payer: YOU, skill: 'sort_laundry', usdCents: 500 })).body.invoice;
    await api('POST', '/api/thc/tx', { refType: 'invoice', refId: live.id, txHash: '0x' + 'b'.repeat(64) });
    const pending = await api('POST', '/api/thc/settle', { refType: 'invoice', refId: live.id, txHash: '0x' + 'b'.repeat(64), receipt: forged });
    assert.equal(pending.status, 409, 'not mined yet according to BNB Smart Chain');
    assert.equal(bscCalls, 1, 'BNB Smart Chain receipts are fetched by the server');
    // "Mark as dropped" and "Send again": the server checks the chain itself too, whatever the client says
    app.box.state.ledger.push({ id: 'lx', worker: 'w_you', kind: 'bounty', cents: 5000, ref: null, memo: 'test', status: 'available', at: Date.now() });
    await api('POST', '/api/workers/w_you/wallets', { network: 'sim', address: YOU });
    const po = (await api('POST', '/api/payouts', { workerId: 'w_you', amountCents: 1000, method: 'thc', network: 'sim' })).body.thcPayout;
    const sent = (await rpc('eth_sendTransaction', [{ from: po.treasury, to: Thc.TOKEN.address, data: Thc.encodeTransfer(po.to, BigInt(po.grossUnits)) }])).result;
    await api('POST', '/api/thc/tx', { refType: 'payout', refId: po.id, txHash: sent });
    const mined = await api('POST', '/api/thc/drop', { refType: 'payout', refId: po.id, chain: { [sent]: null } });
    assert.equal(mined.status, 409, 'it was mined, so it was not dropped (the client\'s view of the chain is ignored)');
    assert.match(mined.body.error, /already reached/);
    const again = await api('POST', '/api/thc/start', { refType: 'payout', refId: po.id, resend: true, chain: { [sent]: null } });
    assert.equal(again.status, 409, 'nor sent again');
    assert.match(again.body.error, /already reached/);
    await api('POST', '/api/workers/w_you/wallets', { network: 'bsc', address: YOU });
    const bp = (await api('POST', '/api/payouts', { workerId: 'w_you', amountCents: 1000, method: 'thc', network: 'bsc' })).body.thcPayout;
    const stuck = '0x' + 'c'.repeat(64);
    await api('POST', '/api/thc/tx', { refType: 'payout', refId: bp.id, txHash: stuck });
    const waiting = await api('POST', '/api/thc/drop', { refType: 'payout', refId: bp.id, chain: { [stuck]: null } });
    assert.equal(waiting.status, 409, 'BNB Smart Chain still has it pending');
    assert.match(waiting.body.error, /waiting to be mined/);
    const twice = await api('POST', '/api/thc/start', { refType: 'payout', refId: bp.id, resend: true, chain: { [stuck]: null } });
    assert.equal(twice.status, 409);
    assert.match(twice.body.error, /waiting to be mined/);
    assert.equal(bscCalls, 3);
    const settledPo = await api('POST', '/api/thc/settle', { refType: 'payout', refId: po.id, chain: {} });
    assert.equal(settledPo.body.record.status, 'confirmed', '"Check again" finds it on the server\'s own chain');
    // past the per-payout limit, only a transaction the server itself finds on-chain is recorded
    const full = (await api('POST', '/api/payouts', { workerId: 'w_you', amountCents: 1000, method: 'thc', network: 'sim' })).body.thcPayout;
    for (let i = 0; i < 8; i++) await api('POST', '/api/thc/tx', { refType: 'payout', refId: full.id, txHash: '0x' + (i + 1).toString(16).padStart(64, 'e'), replace: true });
    const fakeProof = { transactionHash: '0x' + '9'.repeat(64), status: '0x1', from: full.treasury, to: Thc.TOKEN.address, logs: [{ address: Thc.TOKEN.address, topics: [Thc.TRANSFER_TOPIC, '0x' + Thc.addressWord(full.treasury), '0x' + Thc.addressWord(full.to)], data: '0x' + Thc.word(BigInt(full.grossUnits)), removed: false }] };
    const junk = await api('POST', '/api/thc/tx', { refType: 'payout', refId: full.id, txHash: '0x' + '9'.repeat(64), replace: true, proof: fakeProof });
    assert.equal(junk.status, 409, 'a forged proof is ignored');
    const paid = (await rpc('eth_sendTransaction', [{ from: full.treasury, to: Thc.TOKEN.address, data: Thc.encodeTransfer(full.to, BigInt(full.grossUnits)) }])).result;
    assert.equal((await api('POST', '/api/thc/tx', { refType: 'payout', refId: full.id, txHash: paid, replace: true })).status, 200, 'a real transfer is still recorded');
    app.flush();
    assert.ok(fs.existsSync(path.join(dataDir, 'chain.json')), 'the simulated chain is persisted');
  } finally {
    await new Promise((r) => app.server.close(r));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
