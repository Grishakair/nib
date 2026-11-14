// Pocket money: Nib's OWN NEAR Intents account (ed25519 key, implicit account id = hex public key).
// Nib spends autonomously from this small balance, but only inside a deterministic policy, and it re-verifies every payment
// independently before signing. This is exactly the logic that moves onto the ESP32 (see docs/DEVICE.md): the LLM can only
// *propose* a payment; recipient/amount/limits are decided by this code, never by model text.
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const ALPHA = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const b58 = buf => { let n = BigInt("0x" + (buf.toString("hex") || "0")), s = ""; while (n > 0n) { s = ALPHA[Number(n % 58n)] + s; n /= 58n; } for (const b of buf) { if (b === 0) s = "1" + s; else break; } return s; };
const DEFAULT_POLICY = {
  perTxUsd: 10,                 // max one payment without a PIN
  dailyUsd: 100,                // max pocket spending per rolling 24h, all tiers together
  autoDailyUsd: 30,             // max spending per 24h WITHOUT a PIN
  pinPerTxUsd: 50,              // mid-size payments (above perTxUsd) are allowed up to this, but need the owner's PIN
  newContactCooldownHours: 24,  // a freshly added contact cannot be paid autonomously for this long
  delaySeconds: 10,             // grace period with a Cancel button before anything is signed
  minOutRatio: 0.93,            // refuse quotes where the recipient would get < 93% of the USD value sent
  maxBalanceUsd: +process.env.POCKET_MAX_USD || 100,   // the pocket should never hold more than this (deposits cannot be refused on-chain, so Nib warns and refuses top-ups above it)
  maxDeadlineDays: 7,           // refuse intents whose signature stays valid longer than this
};
const toUnits = (x, dec) => dec > 6 ? BigInt(Math.floor(x * 1e6)) * 10n ** BigInt(dec - 6) : BigInt(Math.floor(x * 10 ** dec));

module.exports = function createPocket({ dir, oneclick, jwt, tokens, sleep }) {
  const keyFile = path.join(dir, "pocket-key.json"), stateFile = path.join(dir, "pocket-state.json"), policyFile = path.join(dir, "policy.json");
  const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return d; } };
  let key = readJson(keyFile, null);
  if (!key) { // first run: generate Nib's key. On the device this lives in encrypted flash and never leaves it.
    const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
    key = { pem: privateKey.export({ type: "pkcs8", format: "pem" }), pubHex: publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("hex") };
    fs.writeFileSync(keyFile, JSON.stringify(key), { mode: 0o600 });
  }
  const priv = crypto.createPrivateKey(key.pem);
  const account = key.pubHex, publicKeyStr = "ed25519:" + b58(Buffer.from(key.pubHex, "hex"));
  const policy = () => ({ ...DEFAULT_POLICY, ...readJson(policyFile, {}) });
  const state = () => readJson(stateFile, { ledger: [] });
  const spentToday = () => state().ledger.filter(l => Date.now() - l.ts < 864e5).reduce((s, l) => s + l.usd, 0);
  const lc = s => String(s || "").toLowerCase();
  const H = { "content-type": "application/json", ...jwt };
  const post = async (p, body) => (await fetch(oneclick + p, { method: "POST", headers: H, body: JSON.stringify(body) })).json();
  const get = async p => (await fetch(oneclick + p, { headers: H })).json();

  async function nearView(method, args) {
    const r = await (await fetch(process.env.NEAR_RPC || "https://rpc.mainnet.near.org", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params: { request_type: "call_function", finality: "final", account_id: "intents.near", method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString("base64") } }) })).json();
    if (r.error || r.result?.error) throw new Error("NEAR RPC: " + JSON.stringify(r.error || r.result.error).slice(0, 200));
    return JSON.parse(Buffer.from(r.result.result).toString());
  }
  async function balances() { // Verifier balances of Nib's account, public view call, no keys involved
    if (process.env.POCKET_TEST_BALANCE === "1") { // TEST ONLY: pretend the pocket holds 1000 USDC on Base, so quotes/verification/intents can be exercised without funds
      const t = (await tokens()).find(x => x.symbol === "USDC" && x.blockchain === "base");
      const off = globalThis.__pocketTestOffset || 0;   // /test/credit moves this
      return [{ symbol: "USDC", chain: "base", assetId: t.assetId, decimals: t.decimals, price: t.price, raw: String(Math.round((1000 + off) * 1e6)), amount: 1000 + off, usd: (1000 + off) * t.price }];
    }
    const list = (await tokens()).filter(t => t.price && !/DEPRECATED/.test(t.symbol));
    const out = await nearView("mt_batch_balance_of", { account_id: account, token_ids: list.map(t => t.assetId) });
    return list.map((t, i) => ({ t, raw: BigInt(out[i] || "0") })).filter(x => x.raw > 0n)
      .map(({ t, raw }) => { const amount = Number(raw) / 10 ** t.decimals; return { symbol: t.symbol, chain: t.blockchain, assetId: t.assetId, decimals: t.decimals, price: t.price, raw: raw.toString(), amount, usd: amount * t.price }; })
      .sort((a, b) => b.usd - a.usd);
  }

  // ---- policy: pure, deterministic, no LLM involved ----
  const isFrozen = () => !!state().frozen;                                   // "pause auto-pay": instant brake if the device is lost
  const setFrozen = on => { const st = state(); st.frozen = !!on; fs.writeFileSync(stateFile, JSON.stringify(st)); };
  const activity = () => state().ledger.slice(-10).reverse();
  // Tiers: "auto" = up to perTxUsd each and autoDailyUsd a day, no PIN. "pin" = up to pinPerTxUsd each, needs the owner's PIN (and a PIN must be set). dailyUsd caps everything.
  const autoSpentToday = () => state().ledger.filter(l => Date.now() - l.ts < 864e5 && !l.pin).reduce((s, l) => s + l.usd, 0);
  function check({ usd, toName, contactAddedAt, pinSet }) {
    const p = policy(), reasons = []; let tier = "auto";
    if (isFrozen()) reasons.push("auto-pay is paused");
    if (!toName) reasons.push("recipient is not a saved contact");
    else if (contactAddedAt && Date.now() - contactAddedAt < p.newContactCooldownHours * 36e5) reasons.push(`contact was added less than ${p.newContactCooldownHours}h ago`);
    if (usd > p.pinPerTxUsd) reasons.push(`over the $${p.pinPerTxUsd} limit, even with a PIN`);
    if (spentToday() + usd > p.dailyUsd) reasons.push(`over the $${p.dailyUsd} daily limit ($${spentToday().toFixed(2)} spent today)`);
    if (usd > p.perTxUsd || autoSpentToday() + usd > p.autoDailyUsd) { tier = "pin"; if (!pinSet) reasons.push(`over what I may pay alone ($${p.perTxUsd} each, $${p.autoDailyUsd} a day); with a PIN set I could pay up to $${p.pinPerTxUsd}`); }
    return { ok: !reasons.length, tier, reasons };
  }

  // ---- build + independently verify one payment; nothing is signed here ----
  async function prepare({ to, usd, destChain, destToken, internal, originToken, originChain, sellAll }) {   // internal: the bought token stays inside the Pocket (recipient = Nib's own Intents account)
    const p = policy(), bal = await balances();
    const o = originToken ? bal.find(b => b.symbol.toUpperCase() === String(originToken).toUpperCase() && (!originChain || b.chain === originChain) && b.usd > 0.01) : bal.filter(b => b.price > 0.97 && b.price < 1.03 && b.usd >= usd).sort((a, b) => b.usd - a.usd)[0];
    if (originToken && o && sellAll) usd = o.usd;   // selling a whole position: the exact raw balance is sent
    if (!o) return { error: `Pocket balance too low (has $${bal.reduce((s, b) => s + b.usd, 0).toFixed(2)}).` };
    let dc = destChain || o.chain, ds = destToken || o.symbol;
    if (/^(kamino|camino|kamina|camina|kaminos|камино|комино)\b/i.test(String(ds))) { dc = "sol"; ds = "kV-gtSOLb"; }   // "Kamino" = the Kamino vault token kV-gtSOLb on Solana
    const dest = (await tokens()).find(x => x.blockchain === dc && x.symbol.toUpperCase() === String(ds).toUpperCase() && !/DEPRECATED/.test(x.symbol));
    if (!dest) return { error: `NEAR Intents has no ${ds} on ${dc}.` };
    const units = originToken && sellAll ? BigInt(o.raw) : toUnits(usd / o.price, o.decimals);
    const q = (await post("/quote", { dry: false, swapType: "EXACT_INPUT", slippageTolerance: 100, originAsset: o.assetId, depositType: "INTENTS", destinationAsset: dest.assetId, amount: units.toString(), refundTo: account, refundType: "INTENTS", recipient: to, recipientType: internal ? "INTENTS" : "DESTINATION_CHAIN", deadline: new Date(Date.now() + 15 * 60e3).toISOString() })).quote;
    if (!q?.depositAddress) return { error: "Intents returned no quote for this payment." };
    const ratio = Number(q.amountOutUsd) / Number(q.amountInUsd);
    if (!(ratio >= p.minOutRatio)) return { error: `Quote too poor: recipient would get only ${(ratio * 100).toFixed(1)}% of the value.` };
    // 1) ask 1Click what it recorded for this deposit address and compare with what WE intended (the device does this too)
    const rq = (await get(`/status?depositAddress=${q.depositAddress}`)).quoteResponse?.quoteRequest || {};
    const bad = [];
    if (lc(rq.recipient) !== lc(to)) bad.push("recipient");
    if (rq.destinationAsset !== dest.assetId) bad.push("destination asset");
    if (rq.originAsset !== o.assetId) bad.push("origin asset");
    if (rq.depositType !== "INTENTS") bad.push("deposit type");
    if (String(rq.amount) !== units.toString()) bad.push("amount");
    if (lc(rq.refundTo) !== account) bad.push("refund address");
    if (bad.length) return { error: "Safety check failed, quote does not match the request: " + bad.join(", ") };
    // 2) unsigned intent: inspect the exact bytes we are about to sign
    const gi = await post("/generate-intent", { type: "swap_transfer", standard: "raw_ed25519", signerId: account, depositAddress: q.depositAddress });
    const payload = gi.intent?.payload; if (!payload) return { error: "Could not generate the intent." };
    let pl; try { pl = JSON.parse(payload); } catch { return { error: "Intent payload is not valid JSON." }; }
    const t = pl.intents?.[0], toks = Object.entries(t?.tokens || {});
    const wrong = [];
    if (pl.verifying_contract !== "intents.near") wrong.push("contract");
    if (pl.signer_id !== account) wrong.push("signer");
    if (pl.intents?.length !== 1 || t.intent !== "transfer") wrong.push("intent type");
    if (lc(t?.receiver_id) !== lc(q.depositAddress)) wrong.push("receiver");
    if (toks.length !== 1 || toks[0][0] !== o.assetId || String(toks[0][1]) !== units.toString()) wrong.push("token/amount");
    if (!(Date.parse(pl.deadline) < Date.now() + p.maxDeadlineDays * 864e5)) wrong.push("deadline");
    if (wrong.length) return { error: "Refusing to sign, the intent does not match: " + wrong.join(", ") };
    return { ok: true, payload, depositAddress: q.depositAddress, origin: o, dest, units, usd, expectedOut: q.amountOutFormatted, eta: q.timeEstimate };
  }

  // ---- sign + submit; this is the only place the private key is used ----
  async function execute(prep, job) {
    if (process.env.POCKET_TEST_BALANCE === "1") throw new Error("test mode: payment was NOT submitted");
    const signature = "ed25519:" + b58(crypto.sign(null, Buffer.from(prep.payload), priv));      // raw_ed25519 signs the payload's UTF-8 bytes (verified with simulate_intents)
    const r = await post("/submit-intent", { type: "swap_transfer", signedData: { standard: "raw_ed25519", payload: prep.payload, public_key: publicKeyStr, signature } });
    if (!r.intentHash) throw new Error("Submit failed: " + JSON.stringify(r).slice(0, 200));
    const st = state(); st.ledger.push({ ts: Date.now(), usd: prep.usd, to: job.to, hash: r.intentHash, pin: !!prep.pin }); fs.writeFileSync(stateFile, JSON.stringify(st));
    job.intentHash = r.intentHash; job.status = "sent";
    for (let i = 0; i < 90; i++) { // follow the swap to completion
      try { const s = await get(`/status?depositAddress=${prep.depositAddress}`); job.swapStatus = s.status; if (["SUCCESS", "REFUNDED", "FAILED"].includes(s.status)) return s.status; } catch {}
      await sleep(4000);
    }
    return job.swapStatus;
  }

  // ---- top-up by plain deposit: the NEAR Intents bridge gives every account a PERMANENT deposit address per chain ----
  // Anyone (any wallet, even an exchange withdrawal) can send a supported token there and it is credited to Nib's account.
  const BRIDGE = process.env.BRIDGE_RPC || "https://bridge.chaindefuser.com/rpc";
  const bridge = async (method, params) => (await (await fetch(BRIDGE, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: [params] }), signal: AbortSignal.timeout(20000) })).json()).result;
  const CH = { "eth:1": "Ethereum", "eth:8453": "Base", "eth:42161": "Arbitrum" };
  async function depositInfo() {
    const chains = Object.keys(CH), perChain = {};
    for (const c of chains) perChain[c] = (await bridge("deposit_address", { account_id: account, chain: c }))?.address;
    const st = (await bridge("supported_tokens", { chains }))?.tokens || [];
    const tokensOk = st.filter(t => /^(USDC|USDT)$/.test(t.asset_name)).map(t => ({ network: CH[t.defuse_asset_identifier.split(":").slice(0, 2).join(":")], token: t.asset_name, min: +(Number(t.min_deposit_amount) / 10 ** t.decimals).toFixed(2) }));
    const addrs = [...new Set(Object.values(perChain))];
    return { address: addrs.length === 1 ? addrs[0] : null, perChain: Object.fromEntries(Object.entries(perChain).map(([c, a]) => [CH[c], a])), tokens: tokensOk, warning: "Send only the listed tokens on the listed networks to this address. Anything else may be lost." };
  }
  const info = async () => { let bal = []; try { bal = await balances(); } catch {} return { account, policy: policy(), spentToday: spentToday(), frozen: isFrozen(), balanceUsd: bal.reduce((s, b) => s + b.usd, 0), balances: bal.map(b => ({ token: b.symbol, chain: b.chain, amount: +b.amount.toFixed(4), usd: +b.usd.toFixed(2) })) }; };
  return { account, policy, check, prepare, execute, balances, info, toUnits, depositInfo, isFrozen, setFrozen, activity };
};
