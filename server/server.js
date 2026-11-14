// Nib backend: text/voice -> NEAR AI agent (tool calling) -> pending on-chain action -> signed on the owner's phone -> verified on-chain.
// Money rail = NEAR Intents (1Click quote): spend ANY token the owner holds on ANY supported EVM chain, deliver ANY token/chain.
// Zero deps, Node 18+. Run: set -a; . ./.env; set +a; node server/server.js   (without NEAR_AI_API_KEY it uses a mock parser)
const http = require("http"), fs = require("fs"), path = require("path"), os = require("os"), crypto = require("crypto");
const _fetch = globalThis.fetch; globalThis.fetch = (u, o = {}) => _fetch(u, { signal: AbortSignal.timeout(25000), ...o });
const PORT = process.env.PORT || 8787;
const NEAR_AI = { url: "https://cloud-api.near.ai/v1/chat/completions", key: process.env.NEAR_AI_API_KEY, model: process.env.NEAR_AI_MODEL || "anthropic/claude-haiku-5-5" };
const DATA = process.env.DATA_DIR || __dirname;                   // owner.json, contacts.json, pocket-key.json, pocket-state.json, policy.json live here
// Chat providers. NEAR AI is the product's primary choice; Claude (Anthropic API), Groq and OpenAI are automatic fallbacks when their keys are set.
// LLM_ORDER=claude,near puts a different one first (used while NEAR AI Cloud has an outage). A provider that fails is skipped for 90 s.
const LLMS_ALL = [
  NEAR_AI.key && { name: "near", url: NEAR_AI.url, key: NEAR_AI.key, model: NEAR_AI.model, timeout: 15000 },
  process.env.ANTHROPIC_API_KEY && { name: "claude", kind: "anthropic", url: "https://api.anthropic.com/v1/messages", key: process.env.ANTHROPIC_API_KEY, model: process.env.ANTHROPIC_MODEL || "claude-haiku-5-5", timeout: 25000 },
  process.env.GROQ_API_KEY && { name: "groq", url: "https://api.groq.com/openai/v1/chat/completions", key: process.env.GROQ_API_KEY, model: process.env.GROQ_MODEL || "llama-3.3-70b-versatile", timeout: 20000 },
  process.env.OPENAI_API_KEY && { name: "openai", url: "https://api.openai.com/v1/chat/completions", key: process.env.OPENAI_API_KEY, model: process.env.OPENAI_MODEL || "gpt-4.1-mini", timeout: 20000 },
].filter(Boolean);
const LLM_ORDER = (process.env.LLM_ORDER || "").split(",").map(s => s.trim()).filter(Boolean);
const LLMS = [...LLM_ORDER.map(n => LLMS_ALL.find(p => p.name === n)).filter(Boolean), ...LLMS_ALL.filter(p => !LLM_ORDER.includes(p.name))];
// OpenAI-style conversation (what the agent keeps) <-> Anthropic Messages API
function toAnthropic(messages) {
  const system = messages.filter(m => m.role === "system").map(m => m.content).join("\n"), out = [];
  for (const m of messages) {
    if (m.role === "user") out.push({ role: "user", content: m.content });
    else if (m.role === "assistant") {
      const blocks = []; if (m.content) blocks.push({ type: "text", text: m.content });
      for (const tc of m.tool_calls || []) blocks.push({ type: "tool_use", id: tc.id, name: tc.function.name, input: JSON.parse(tc.function.arguments || "{}") });
      if (blocks.length) out.push({ role: "assistant", content: blocks });
    } else if (m.role === "tool") {
      const block = { type: "tool_result", tool_use_id: m.tool_call_id, content: String(m.content) }, last = out[out.length - 1];
      if (last && last.role === "user" && Array.isArray(last.content)) last.content.push(block); else out.push({ role: "user", content: [block] });
    }
  }
  return { system, messages: out };
}
function fromAnthropic(r) {
  if (!Array.isArray(r.content)) return null;
  const text = r.content.filter(b => b.type === "text").map(b => b.text).join(" ").trim();
  const calls = r.content.filter(b => b.type === "tool_use").map(b => ({ id: b.id, type: "function", function: { name: b.name, arguments: JSON.stringify(b.input || {}) } }));
  return { choices: [{ message: { role: "assistant", content: text || null, ...(calls.length ? { tool_calls: calls } : {}) } }] };
}
async function chat(messages) {
  let last = null;
  const live = LLMS.filter(p => !(p.downUntil > Date.now())), list = live.length ? live : LLMS;
  for (const p of list) {
    try {
      let out = null;
      if (p.kind === "anthropic") {
        const a = toAnthropic(messages);
        const r = await (await fetch(p.url, { method: "POST", headers: { "content-type": "application/json", "x-api-key": p.key, "anthropic-version": "2023-06-01" }, body: JSON.stringify({ model: p.model, max_tokens: 700, system: a.system, messages: a.messages, tools: TOOLS.map(t => ({ name: t.function.name, description: t.function.description, input_schema: t.function.parameters })) }), signal: AbortSignal.timeout(p.timeout) })).json();
        out = fromAnthropic(r); if (!out) last = r;
      } else {
        const r = await (await fetch(p.url, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${p.key}` }, body: JSON.stringify({ model: p.model, max_tokens: 700, messages, tools: TOOLS }), signal: AbortSignal.timeout(p.timeout) })).json();
        if (r.choices?.[0]?.message) out = r; else last = r;
      }
      if (out) { p.downUntil = 0; return out; }
      p.downUntil = Date.now() + 90e3; console.error(`[llm ${p.name}] ${JSON.stringify(last?.error || last).slice(0, 140)}`);
    } catch (e) { p.downUntil = Date.now() + 90e3; last = { error: { message: e.message } }; console.error(`[llm ${p.name}] ${e.message}`); }
  }
  return last || {};
}
const OWNER_FILE = process.env.OWNER_FILE || path.join(DATA, "owner.json");
let OWNER_DISPLAY = (() => { try { return JSON.parse(fs.readFileSync(OWNER_FILE)).owner || process.env.OWNER_ADDRESS || ""; } catch { return process.env.OWNER_ADDRESS || ""; } })();
let OWNER = OWNER_DISPLAY.toLowerCase();                          // only this wallet may sign; paired from the phone (/setup) or OWNER_ADDRESS
let pairing = null;                                               // { code, exp } while a pairing window is open
const ONECLICK = "https://1click.chaindefuser.com/v0";
const jwt = process.env.ONECLICK_JWT ? { authorization: "Bearer " + process.env.ONECLICK_JWT } : {};
const DRY = process.env.DRY === "1";                 // DRY=1: approve without a real tx (simulator testing)
const TEST_ASSUME_BALANCE = process.env.TEST_ASSUME_BALANCE === "1"; // testing only: build quotes/plans even with an empty wallet
const MAX_USD = +process.env.MAX_AMOUNT || 1000, TTL = 10 * 60e3;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const CHAINS = { // EVM chains the phone wallet can sign on
  eth:    { id: 1,     name: "Ethereum", rpc: "https://ethereum-rpc.publicnode.com",          explorer: "https://etherscan.io",          native: "ETH" },
  base:   { id: 8453,  name: "Base",     rpc: "https://base-rpc.publicnode.com",              explorer: "https://basescan.org",          native: "ETH" },
  arb:    { id: 42161, name: "Arbitrum", rpc: "https://arbitrum-one-rpc.publicnode.com",      explorer: "https://arbiscan.io",           native: "ETH" },
  op:     { id: 10,    name: "Optimism", rpc: "https://optimism-rpc.publicnode.com",          explorer: "https://optimistic.etherscan.io", native: "ETH" },
  pol:    { id: 137,   name: "Polygon",  rpc: "https://polygon-bor-rpc.publicnode.com",       explorer: "https://polygonscan.com",       native: "POL" },
  bsc:    { id: 56,    name: "BNB Chain", rpc: "https://bsc-rpc.publicnode.com",              explorer: "https://bscscan.com",           native: "BNB" },
  avax:   { id: 43114, name: "Avalanche", rpc: "https://avalanche-c-chain-rpc.publicnode.com", explorer: "https://snowtrace.io",         native: "AVAX" },
  gnosis: { id: 100,   name: "Gnosis",   rpc: "https://gnosis-rpc.publicnode.com",            explorer: "https://gnosisscan.io",         native: "xDAI" },
  plasma: { id: 9745,  name: "Plasma",   rpc: process.env.PLASMA_RPC || "https://rpc.plasma.to", explorer: process.env.EXPLORER || "https://plasmascan.to", native: "XPL" },
};
const ALIAS = { ethereum: "eth", arbitrum: "arb", optimism: "op", polygon: "pol", bnb: "bsc", binance: "bsc", avalanche: "avax" };
const norm = c => { c = String(c || "").toLowerCase(); return ALIAS[c] || c; };
const USDT0 = "0xb8ce59fc3717ada4c02eadf9682a9e934f625ebb";       // USDT0 on Plasma
const AAVE_POOL = "0x925a2a7214ed92428b5b1b090f80b25700095e12";   // Aave v3 Pool on Plasma (bgd-labs/aave-address-book)
const pending = new Map();
// ---- PIN lock. Enforced HERE (never only in the UI): protected actions need a short-lived unlock token obtained with the PIN. ----
const PIN_FILE = path.join(DATA, "pin.json"), PIN_BASE = +process.env.PIN_LOCK_BASE_SEC || 60;
let pinRec = (() => { try { const r = JSON.parse(fs.readFileSync(PIN_FILE)); return r.hash ? r : null; } catch { return null; } })();
const unlocks = new Map(); let pinFails = 0, pinFailsTotal = 0, pinLockUntil = 0;                   // unlock tokens (2 min); failures since the last success
const pinOk = pin => crypto.timingSafeEqual(crypto.scryptSync(pin, Buffer.from(pinRec.salt, "hex"), 32), Buffer.from(pinRec.hash, "hex"));
const weakPin = p => /^(\d)\1+$/.test(p) || "01234567890".includes(p) || "09876543210".includes(p) || ["1212", "2580", "1122", "1004"].includes(p);
const unlocked = req => { if (!pinRec) return true; const t = req.headers["x-nib-unlock"]; return !!t && (unlocks.get(t) || 0) > Date.now(); };
const needPin = res => send(res, 401, { error: "PIN required", pin: true });
function checkPin(pin) { // brute-force protection: 5 wrong tries lock (60 s, doubling); 10 wrong tries also pause the pocket's auto-pay
  const wait = () => Math.max(0, Math.ceil((pinLockUntil - Date.now()) / 1000));
  if (Date.now() < pinLockUntil) return { ok: false, status: 429, body: { error: "Too many tries. Wait a moment.", lockoutSec: wait() } };
  if (/^\d{4,6}$/.test(pin || "") && pinOk(pin)) { pinFails = 0; pinFailsTotal = 0; return { ok: true }; }
  pinFails++; pinFailsTotal++; let error = "Wrong PIN";
  if (pinFails >= 5) { pinLockUntil = Date.now() + Math.min(900, PIN_BASE * 2 ** Math.max(0, Math.floor(pinFailsTotal / 5) - 1)) * 1000; pinFails = 0; error = "Too many tries. Locked for a while."; }
  if (pinFailsTotal >= 10 && !pocket.isFrozen()) { pocket.setFrozen(true); global.__sum = null; error += " For safety, auto-pay was paused."; }
  return { ok: false, status: 403, body: { error, attemptsLeft: Math.max(0, 5 - pinFails), lockoutSec: wait() } };
}
// ---- savings goal ("piggy bank"): progress = Nib's pocket balance toward a target. Money arriving in the pocket makes the pet celebrate. ----
const GOAL_FILE = path.join(DATA, "goal.json");
let goal = (() => { try { const g = JSON.parse(fs.readFileSync(GOAL_FILE)); return g.name ? g : null; } catch { return null; } })();
const saveGoal = () => fs.writeFileSync(GOAL_FILE, JSON.stringify(goal || {}) + "\n");
const goalView = total => goal ? { name: goal.name, target: goal.target, saved: +Math.min(total, goal.target).toFixed(2), pct: Math.min(100, Math.floor(total / goal.target * 100)), done: !!goal.done } : null;
let lastPocket = null, eid = 0; const events = [];                  // events: what the pet should react to (money_in, goal_done)
async function pocketTotal() { return (await pocket.balances()).reduce((s, b) => s + b.usd, 0); }
async function setGoal(nameIn, targetIn) {
  const name = String(nameIn || "").replace(/[^\x20-\x7E]/g, "").trim().slice(0, 30), target = Math.round(+targetIn * 100) / 100;   // ASCII only: the device font has no other letters
  if (!name) return { error: "Give the goal a short English name" };
  if (!(target >= 1 && target <= 100000)) return { error: "The target must be between 1 and 100000 dollars" };
  let total = lastPocket; if (total === null) { try { total = await pocketTotal(); } catch { total = 0; } }
  if (target <= total) return { error: `The pocket already holds $${total.toFixed(2)}. Pick a bigger target.` };
  goal = { name, target, createdAt: Date.now(), done: false }; saveGoal(); global.__sum = null;
  return { ok: true, goal: goalView(total) };
}
async function watchMoney() { // every few seconds compare the pocket balance with the last one: an increase = money arrived
  try {
    const total = await pocketTotal();                              // throws if the RPC fails, so a failed read can never look like a new deposit
    if (lastPocket !== null && total > lastPocket + 0.05) { events.push({ id: ++eid, ts: Date.now(), type: "money_in", usd: total - lastPocket, total }); if (events.length > 50) events.shift(); global.__sum = null; }
    if (goal && !goal.done && total >= goal.target) { goal.done = true; saveGoal(); events.push({ id: ++eid, ts: Date.now(), type: "goal_done", name: goal.name, target: goal.target, total }); }
    const capUsd = pocket.policy().maxBalanceUsd; if (total > capUsd && (lastPocket === null || lastPocket <= capUsd)) events.push({ id: ++eid, ts: Date.now(), type: "over_cap", total, cap: capUsd });   // the pocket holds more than its limit: the pet warns
    lastPocket = total;
  } catch {}
}
const WIFI_FILE = path.join(DATA, "wifi.json");                    // simulated device NVS: the saved Wi-Fi network (pre-provisioned with Home-5G until you press Forget)
let wifi = (() => { try { return JSON.parse(fs.readFileSync(WIFI_FILE)); } catch { return { ssid: "Home-5G" }; } })();
const WIFI_NETS = [{ ssid: "Home-5G", bars: 4, secure: true }, { ssid: "Home-2G", bars: 3, secure: true }, { ssid: "Neighbor-WiFi", bars: 2, secure: true }, { ssid: "Cafe Guest", bars: 3, secure: false }, { ssid: "Office", bars: 1, secure: true }];
const DEMO_WIFI_PASSWORD = process.env.DEMO_WIFI_PASSWORD || "nibwifi123", wifiSessions = {};
const CONTACTS_FILE = path.join(DATA, "contacts.json");
// ---------- feeding: Nib gets hungry every day; any money put into the pocket is food ----------
const FEED_FILE = path.join(__dirname, "feed.json");
let FEED = (() => { try { return JSON.parse(fs.readFileSync(FEED_FILE, "utf8")); } catch { return { lastBal: null, lastFedAt: 0, seq: 0 }; } })();
function feedView(usd) {
  if (typeof usd === "number" && isFinite(usd)) {
    if (FEED.lastBal === null) { FEED.lastBal = usd; fs.writeFileSync(FEED_FILE, JSON.stringify(FEED)); }
    else if (usd > FEED.lastBal + 0.005) { FEED.lastBal = usd; FEED.lastFedAt = Date.now(); FEED.seq++; fs.writeFileSync(FEED_FILE, JSON.stringify(FEED)); }
    else if (usd < FEED.lastBal - 0.005) { FEED.lastBal = usd; fs.writeFileSync(FEED_FILE, JSON.stringify(FEED)); }
  }
  return { hungry: !FEED.lastFedAt || new Date(FEED.lastFedAt).toDateString() !== new Date().toDateString(), seq: FEED.seq };
}
const CONTACTS = JSON.parse(fs.existsSync(CONTACTS_FILE) ? fs.readFileSync(CONTACTS_FILE) : "{}");
const short = a => a.slice(0, 6) + ".." + a.slice(-4);
const fmt = n => { n = +n; return n >= 100 ? n.toFixed(0) : n >= 1 ? n.toFixed(2) : n.toPrecision(2); }; // 5.004539 -> "5.00"
const contactAddr = v => typeof v === "string" ? v : v.address, contactAdded = v => typeof v === "string" ? 0 : v.addedAt || 0; // legacy string entries count as old
const pocket = require("./pocket")({ dir: DATA, oneclick: ONECLICK, jwt, tokens, sleep });

// ---------- token list + balances (any token the wallet holds) ----------
let tk = { at: 0, list: [] };
async function tokens() { if (Date.now() - tk.at > 300e3) tk = { at: Date.now(), list: await (await fetch(ONECLICK + "/tokens")).json() }; return tk.list; }
let bal = { at: 0, list: [] };
async function balances() {
  if (!OWNER) return [];
  if (Date.now() - bal.at < 30e3) return bal.list;
  const all = await tokens(), pad32 = OWNER.slice(2).padStart(64, "0"), out = [];
  await Promise.all(Object.entries(CHAINS).map(async ([chain, c]) => {
    const list = all.filter(t => t.blockchain === chain && !/DEPRECATED/.test(t.symbol));
    const calls = list.map((t, i) => t.contractAddress ? { jsonrpc: "2.0", id: i, method: "eth_call", params: [{ to: t.contractAddress, data: "0x70a08231" + pad32 }, "latest"] } : { jsonrpc: "2.0", id: i, method: "eth_getBalance", params: [OWNER, "latest"] });
    try {
      const res = await (await fetch(c.rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(calls), signal: AbortSignal.timeout(15000) })).json();
      for (const r of Array.isArray(res) ? res : []) { const t = list[r.id]; if (!r.result || r.result === "0x") continue; const amount = Number(BigInt(r.result)) / 10 ** t.decimals; if (amount > 0) out.push({ chain, symbol: t.symbol, amount, usd: amount * (t.price || 0), raw: BigInt(r.result).toString(), price: t.price || 0, decimals: t.decimals, assetId: t.assetId, contract: t.contractAddress || null }); }
    } catch {}
  }));
  bal = { at: Date.now(), list: out.sort((a, b) => b.usd - a.usd) };
  return bal.list;
}
const isStable = b => b.price > 0.97 && b.price < 1.03;
async function pickOrigin({ from_token, from_chain, usd, prefer }) {
  let c = (await balances()).filter(b => (!from_token || b.symbol.toLowerCase() === String(from_token).toLowerCase()) && (!from_chain || b.chain === norm(from_chain)) && b.usd >= usd);
  if (prefer) { const p = c.find(b => b.chain === prefer.chain && b.symbol === prefer.symbol); if (p) return p; }
  c = c.sort((a, b) => (isStable(b) - isStable(a)) || b.usd - a.usd);
  if (c[0] || !TEST_ASSUME_BALANCE) return c[0] || null;
  const t = (await tokens()).find(x => x.symbol.toLowerCase() === String(from_token || "USDC").toLowerCase() && x.blockchain === norm(from_chain || "base") && CHAINS[x.blockchain]); // test-only stand-in
  return t && { chain: t.blockchain, symbol: t.symbol, amount: 1e6, usd: 1e6, price: t.price || 1, decimals: t.decimals, assetId: t.assetId, contract: t.contractAddress || null };
}

// ---------- tx plans (what the phone signs; the server re-verifies exactly this on-chain) ----------
const pad = h => String(h).replace(/^0x/, "").toLowerCase().padStart(64, "0");
const toUnits = (x, dec) => dec > 6 ? BigInt(Math.floor(x * 1e6)) * 10n ** BigInt(dec - 6) : BigInt(Math.floor(x * 10 ** dec));
const planTransfer = (o, to, units) => o.contract
  ? { label: `Send ${o.symbol} on ${CHAINS[o.chain].name}`, chain: o.chain, to: o.contract.toLowerCase(), data: "0xa9059cbb" + pad(to) + pad(units.toString(16)) }          // transfer(address,uint256)
  : { label: `Send ${o.symbol} on ${CHAINS[o.chain].name}`, chain: o.chain, to: to.toLowerCase(), data: "0x", value: "0x" + units.toString(16) };                          // native transfer
const planEarn = units => [
  { label: "Approve USDT0", chain: "plasma", to: USDT0, data: "0x095ea7b3" + pad(AAVE_POOL) + pad(units.toString(16)) },                                                      // approve(address,uint256)
  { label: "Deposit to Aave", chain: "plasma", to: AAVE_POOL, data: "0x617ba037" + pad(USDT0) + pad(units.toString(16)) + pad(OWNER) + pad("0") },                          // supply(asset,amount,onBehalfOf,0)
];

// ---------- NEAR Intents quote ----------
async function intentQuote(origin, units, to, dc, ds, recipientType = "DESTINATION_CHAIN") { // real (non-dry) quote -> unique deposit address on the ORIGIN chain
  const dest = (await tokens()).find(x => x.blockchain === dc && x.symbol.toUpperCase() === ds.toUpperCase() && !/DEPRECATED/.test(x.symbol));
  if (!dest) return { error: `NEAR Intents has no ${ds} on ${dc}.` };
  const r = await (await fetch(ONECLICK + "/quote", { method: "POST", headers: { "content-type": "application/json", ...jwt }, body: JSON.stringify({
    dry: false, swapType: "EXACT_INPUT", slippageTolerance: 100, originAsset: origin.assetId, depositType: "ORIGIN_CHAIN", destinationAsset: dest.assetId,
    amount: units.toString(), refundTo: OWNER, refundType: "ORIGIN_CHAIN", recipient: to, recipientType,
    deadline: new Date(Date.now() + 15 * 60e3).toISOString() }) })).json();
  const dep = r.quote?.depositAddress || "";
  if (!/^0x[0-9a-fA-F]{40}$/.test(dep)) return { error: "Intents quote failed: " + (r.message || "no route") };
  // independent cross-check: ask 1Click what it actually recorded for this deposit address and compare with what WE asked for
  const rq = (await (await fetch(`${ONECLICK}/status?depositAddress=${dep}`, { headers: jwt })).json()).quoteResponse?.quoteRequest || {};
  if (String(rq.recipient).toLowerCase() !== String(to).toLowerCase() || rq.destinationAsset !== dest.assetId || rq.originAsset !== origin.assetId || String(rq.amount) !== units.toString())
    return { error: "Safety check failed: the quote does not match the request. Nothing was prepared." };
  return { dest, q: r.quote };
}
async function trackSwap(p, txHash) { // tell 1Click about the deposit, follow the swap, then chain the Aave deposit if requested
  try { await fetch(ONECLICK + "/deposit/submit", { method: "POST", headers: { "content-type": "application/json", ...jwt }, body: JSON.stringify({ txHash, depositAddress: p.depositAddress }) }); } catch {}
  for (let i = 0; i < 120; i++) {
    try { const s = await (await fetch(`${ONECLICK}/status?depositAddress=${p.depositAddress}`, { headers: jwt })).json(); p.swapStatus = s.status;
      if (s.status === "SUCCESS") return;
      if (["REFUNDED", "FAILED"].includes(s.status)) return; } catch {}
    await sleep(5000);
  }
}
// EIP-681 payment request: a wallet's own QR scanner turns it into a ready-to-confirm transfer (no dapp browser, no https needed)
const eip681 = step => {
  const c = CHAINS[step.chain];
  if (step.data === "0x") return `ethereum:${step.to}@${c.id}?value=${BigInt(step.value || "0x0")}`;
  if (step.data.startsWith("0xa9059cbb") && step.data.length === 138) return `ethereum:${step.to}@${c.id}/transfer?address=0x${step.data.slice(34, 74)}&uint256=${BigInt("0x" + step.data.slice(74))}`;
  return null;
};
function newPending(kind, summary, plan, extra = {}) {
  const id = Math.random().toString(36).slice(2, 8), p = { id, kind, summary, plan, status: "waiting", createdAt: Date.now(), ...extra };
  if (plan.length === 1) { const uri = eip681(plan[0]); if (uri) p.pay = { uri }; }
  pending.set(id, p); if (p.pay) watchDeposit(p);
  return id;
}
async function watchDeposit(p) { // the wallet paid by scanning the QR: notice it via the Intents deposit status (swaps) or the ERC-20 Transfer log (plain sends)
  const step = p.plan[0], t0 = Date.now(), fromBlock = await rpc(step.chain, "eth_blockNumber", []).catch(() => null);
  if (!p.depositAddress && !(step.data.startsWith("0xa9059cbb") && fromBlock)) return; // native plain transfers: use the wallet-browser page instead
  while (p.status === "waiting" && Date.now() - t0 < TTL) {
    await sleep(4000); if (p.status !== "waiting") return;
    try {
      let hash = null;
      if (p.depositAddress) { const st = await (await fetch(`${ONECLICK}/status?depositAddress=${p.depositAddress}`, { headers: jwt })).json(); hash = JSON.stringify(st.swapDetails?.originChainTxHashes || []).match(/0x[0-9a-fA-F]{64}/)?.[0] || null; }
      else { const logs = await rpc(step.chain, "eth_getLogs", [{ address: step.to, fromBlock, toBlock: "latest", topics: ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef", "0x" + pad(OWNER), "0x" + step.data.slice(10, 74)] }]); hash = logs.find(l => BigInt(l.data) === BigInt("0x" + step.data.slice(74)))?.transactionHash || null; }
      if (hash && p.status === "waiting") { p.status = "done"; p.txHashes = [hash]; bal.at = 0; if (p.via === "intents") trackSwap(p, hash); return; }
    } catch {}
  }
}

// ---------- yields ----------
let llama = { at: 0, pools: [] };
async function pools() { if (Date.now() - llama.at > 60e3) { const r = await (await fetch("https://yields.llama.fi/pools")).json(); llama = { at: Date.now(), pools: r.data.filter(x => x.chain === "Plasma" && x.stablecoin) }; } return llama.pools; }
const apyNow = () => llama.pools.find(x => x.project === "aave-v3" && x.symbol === "USDT0")?.apy;
async function bestApy({ min_tvl_usd = 5e6 } = {}) {
  const top = (await pools()).filter(x => x.tvlUsd >= min_tvl_usd && x.apy > 0).sort((a, b) => b.apy - a.apy).slice(0, 5)
    .map(x => ({ project: x.project, symbol: x.symbol, apy_pct: +x.apy.toFixed(2), tvl_musd: +(x.tvlUsd / 1e6).toFixed(1), depositable_by_nib: x.project === "aave-v3" && x.symbol === "USDT0" }));
  return JSON.stringify({ network: "Plasma", min_tvl_usd, pools: top, note: "Nib can only deposit into aave-v3 USDT0 (on Plasma); funds from any other token/chain are converted via NEAR Intents first. APY is variable." });
}
// ---------- live data ----------
async function webAnswer(q) { // general facts, news, sports: Tavily (LLM-oriented web search). Set TAVILY_API_KEY.
  if (!process.env.TAVILY_API_KEY) return `(no web search configured, so I cannot look up: ${q})`;
  const fresh = /latest|news|today|yesterday|this week|score|won |result|match|game|happened|update|announce/i.test(q); // time-sensitive: news mode, last 7 days
  const r = await (await fetch("https://api.tavily.com/search", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + process.env.TAVILY_API_KEY }, body: JSON.stringify({ query: q, include_answer: true, max_results: 3, search_depth: "basic", ...(fresh ? { topic: "news", days: 7 } : {}) }) })).json();
  const newest = (r.results || []).map(x => Date.parse(x.published_date)).filter(Number.isFinite).sort((a, b) => b - a)[0];
  return ((r.answer || (r.results || []).map(x => x.content).join(" ") || "No results.").slice(0, 600)) + (newest ? ` [newest source: ${new Date(newest).toISOString().slice(0, 10)}]` : "");
}
const WMO = c => c === 0 ? "clear" : c <= 3 ? "partly cloudy" : c <= 48 ? "fog" : c <= 57 ? "drizzle" : c <= 67 ? "rain" : c <= 77 ? "snow" : c <= 82 ? "showers" : "thunderstorm";
async function weather(city) { // Open-Meteo: free, no key
  const g = (await (await fetch(`https://geocoding-api.open-meteo.com/v1/search?count=1&name=${encodeURIComponent(city)}`)).json()).results?.[0];
  if (!g) return `Could not find a place called ${city}.`;
  const c = (await (await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${g.latitude}&longitude=${g.longitude}&current=temperature_2m,weather_code,wind_speed_10m&timezone=auto`)).json()).current;
  return `${g.name}, ${g.country}: ${c.temperature_2m} C, ${WMO(c.weather_code)}, wind ${c.wind_speed_10m} km/h (as of ${c.time}).`;
}
let wxCache = { at: 0, data: null };
async function weatherNow() { // for the pet's corner icon: the home city (HOME_CITY, default Belgrade), cached 15 minutes
  if (wxCache.data && Date.now() - wxCache.at < 15 * 60e3) return wxCache.data;
  const city = process.env.HOME_CITY || "Belgrade", g = (await (await fetch(`https://geocoding-api.open-meteo.com/v1/search?count=1&name=${encodeURIComponent(city)}`)).json()).results?.[0]; if (!g) return {};
  const c = (await (await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${g.latitude}&longitude=${g.longitude}&current=temperature_2m,weather_code&timezone=auto`)).json()).current;
  wxCache = { at: Date.now(), data: { city: g.name, temp: c.temperature_2m, code: c.weather_code } }; return wxCache.data;
}
async function price(sym) { // token prices already come with the 1Click token list (no extra key)
  const l = (await tokens()).filter(t => t.symbol.toUpperCase() === String(sym).toUpperCase() && t.price && !/DEPRECATED/.test(t.symbol));
  return l.length ? `${l[0].symbol} is about $${l[0].price < 1 ? l[0].price.toPrecision(3) : l[0].price.toFixed(2)} (updated ${l[0].priceUpdatedAt}).` : `No price for ${sym}.`;
}

// ---------- Earn: NEAR Intents 1Click. Deposit = quote into the product's receipt token (shares); withdraw = quote back to the underlying ----------
const EARN = {
  gauntlet: { name: "Gauntlet USDC Prime (Morpho, Base)", chain: "base", share: "gtUSDCp", underlying: "USDC", min: 12 }, // min = measured: quotes fail below ~$11 ("No liquidity")
  taler:    { name: "Taler USDC (Ethereum)",              chain: "eth",  share: "TLO",     underlying: "USDC", min: 12 },
};
const earnId = p => { const s = String(p || "gauntlet").toLowerCase(); return EARN[s] ? s : Object.keys(EARN).find(k => s.includes(k) || s.includes(EARN[k].share.toLowerCase())) || null; };

// ---------- pocket money: Nib pays small amounts to saved contacts itself, after a cancel window ----------
const timers = new Map();
// A pocket payment has two tiers. "auto": up to the small limit, starts the cancel window at once. "pin": mid-size, waits (90 s) for the owner's PIN on the device first.
const preps = new Map();
function scheduleJob(id) { // start the cancel window, then sign and send
  const job = pending.get(id), prep = preps.get(id), delay = pocket.policy().delaySeconds;
  job.status = "delayed"; job.executeAt = Date.now() + delay * 1000; job.delaySeconds = delay;
  timers.set(id, setTimeout(async () => {
    if (job.status !== "delayed") return;
    if (pocket.isFrozen()) { job.status = "cancelled"; return; }            // paused during the cancel window: do not send
    job.status = "signing"; prep.pin = job.tier === "pin";
    try { const st = await pocket.execute(prep, job); job.status = st === "SUCCESS" ? "done" : (st === "REFUNDED" || st === "FAILED") ? "failed" : "sent"; if (job.status === "failed") job.error = "Payment " + String(st).toLowerCase(); }
    catch (e) { job.status = "failed"; job.error = e.message; }
  }, delay * 1000));
}
function startPocketJob(toName, to, prep, tier = "auto") {
  const delay = pocket.policy().delaySeconds;
  const id = newPending("pocket_send", `pay $${fmt(prep.usd)} to ${toName === "me" ? "yourself" : toName}`, [], { to, delaySeconds: delay, tier, status: tier === "pin" ? "needs_pin" : "delayed", expiresAt: Date.now() + 90e3 });
  preps.set(id, prep);
  if (tier === "pin") timers.set(id, setTimeout(() => { const j = pending.get(id); if (j && j.status === "needs_pin") j.status = "expired"; }, 90e3));
  else scheduleJob(id);
  return id;
}
function approveJob(id) { const j = pending.get(id); if (!j || j.status !== "needs_pin") return false; clearTimeout(timers.get(id)); scheduleJob(id); return true; }
function cancelJob(id) { const j = pending.get(id); if (!j || !["delayed", "needs_pin"].includes(j.status)) return false; clearTimeout(timers.get(id)); j.status = "cancelled"; return true; }

// ---------- tools ----------
const SRC = { from_token: { type: "string", description: "token to spend, e.g. USDC, ETH. Omit to auto-pick" }, from_chain: { type: "string", description: "chain to spend from, e.g. base. Omit to auto-pick" } };
const TOOLS = [
  { type: "function", function: { name: "web_answer", description: "Web search for current facts: news, sports scores, general questions. Not for weather or token prices (use the dedicated tools).", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } } },
  { type: "function", function: { name: "get_weather", description: "Current weather for a city.", parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } } },
  { type: "function", function: { name: "get_price", description: "Current USD price of a crypto token by symbol (e.g. NEAR, ETH, BTC).", parameters: { type: "object", properties: { symbol: { type: "string" } }, required: ["symbol"] } } },
  { type: "function", function: { name: "get_balances", description: "The owner's wallet token balances across all supported EVM chains (USD values).", parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "pocket_balance", description: "Nib's own pocket money balance and its spending limits.", parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "set_goal", description: "Set the owner's savings goal (a piggy bank). Progress is Nib's pocket balance toward target_usd. Use a short English name.", parameters: { type: "object", properties: { name: { type: "string" }, target_usd: { type: "number" } }, required: ["name", "target_usd"] } } },
  { type: "function", function: { name: "get_goal", description: "Progress of the owner's savings goal.", parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "clear_goal", description: "Remove the savings goal.", parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "pocket_deposit_address", description: "How to top up Nib's pocket money: returns Nib's permanent deposit address and the supported tokens/networks. Anyone can send to it from any wallet or exchange, no wallet connection needed.", parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "get_earn_options", description: "List the available Earn (savings) products. Use for any question about earning, savings, yield or APY.", parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "my_savings", description: "The owner's current Earn positions and what they are worth.", parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "earn_deposit", description: "Put amount_usd into an Earn product through NEAR Intents. The wallet pays with any token on any chain. ALWAYS needs phone confirmation. NEVER use this for Kamino: Kamino goes through earn_kamino.", parameters: { type: "object", properties: { amount_usd: { type: "number" }, product: { type: "string", description: "gauntlet (default) or taler" }, ...SRC }, required: ["amount_usd"] } } },
  { type: "function", function: { name: "earn_withdraw", description: "Withdraw the whole position of an Earn product back to the owner's wallet as USDC. ALWAYS needs phone confirmation.", parameters: { type: "object", properties: { product: { type: "string" } } } } },
  { type: "function", function: { name: "fund_pocket", description: "Move amount_usd from the owner's wallet into Nib's pocket money account (through NEAR Intents). ALWAYS needs phone confirmation.", parameters: { type: "object", properties: { amount_usd: { type: "number" }, ...SRC }, required: ["amount_usd"] } } },
  { type: "function", function: { name: "send_money", description: "Send money to a SAVED CONTACT name, 'me', or a 0x address. amount_usd is the USD value. Small payments to saved contacts are paid by Nib from its pocket money automatically after a short cancel window; anything else (new contact, big amount, raw address, pay_from=wallet) is paid from the owner's wallet with phone confirmation. The recipient gets dest_token on dest_chain (default: same as what is spent); a different token/chain is routed through NEAR Intents.", parameters: { type: "object", properties: { to: { type: "string" }, amount_usd: { type: "number" }, pay_from: { type: "string", description: "pocket or wallet. Omit to let Nib decide by its safety policy" }, ...SRC, dest_chain: { type: "string" }, dest_token: { type: "string" } }, required: ["to", "amount_usd"] } } },
  { type: "function", function: { name: "earn_kamino", description: "When the user says anything with Kamino: 'to Kamino', 'deposit to Kamino', 'put into Kamino', 'Kamino earn', 'buy Kamino' (speech-to-text often writes it as 'Camino', 'Kamina' or 'Камино': that is the same thing, never the Spanish word): swap USDC from the pocket into the Kamino vault token (kV-gtSOLb) and keep it in the pocket. amount_usd is the USD value. Needs about $12 or more. Do NOT use send_money for Kamino. Do not ask for confirmation, just do it and say what was done.", parameters: { type: "object", properties: { amount_usd: { type: "number" } }, required: ["amount_usd"] } } },
  { type: "function", function: { name: "buy_token", description: "Buy a token with the pocket money: swap USDC from the pocket into another token (for example NEAR, ETH, SOL) and KEEP it in the pocket. Use for 'buy / swap / exchange N dollars to NEAR'. token is the symbol, chain is optional. Not for Kamino (use earn_kamino) and not for paying a person (use send_money). Do not ask for confirmation, just do it and say what was done.", parameters: { type: "object", properties: { amount_usd: { type: "number" }, token: { type: "string" }, chain: { type: "string" } }, required: ["amount_usd", "token"] } } },
  { type: "function", function: { name: "sell_token", description: "Sell a token that sits in the pocket back into USDC, inside the pocket (e.g. 'swap Kamino back to USDC', 'sell my NEAR'). token is the symbol (Kamino means the Kamino vault token). Omit amount_usd to sell the WHOLE position. Do not ask for confirmation, just do it and say what was done.", parameters: { type: "object", properties: { token: { type: "string" }, amount_usd: { type: "number" }, to_token: { type: "string" }, to_chain: { type: "string" } }, required: ["token"] } } },
];

async function runTool(name, a) {
  if (name === "web_answer") return webAnswer(a.query);
  if (name === "get_weather") return weather(a.city);
  if (name === "get_price") return price(a.symbol);
  if (name === "get_earn_options") return JSON.stringify({ products: Object.entries(EARN).map(([id, p]) => ({ id, name: p.name, chain: p.chain, you_receive: p.share, apy_pct: null })), note: "Deposits go through NEAR Intents into the product's receipt token. No live APY source is connected yet, so never state an APY. Yield is variable and principal is not guaranteed." });
  if (name === "set_goal") { const r = await setGoal(a.name, a.target_usd); return r.error || `Goal set: ${r.goal.name}, $${r.goal.target}. Saved so far: $${r.goal.saved}.`; }
  if (name === "get_goal") { const v = goalView(lastPocket ?? await pocketTotal().catch(() => 0)); return v ? `${v.name}: $${v.saved} of $${v.target} (${v.pct}%)${v.done ? ", reached!" : ""}` : "No savings goal yet."; }
  if (name === "clear_goal") { goal = null; saveGoal(); global.__sum = null; return "Goal removed."; }
  if (name === "pocket_deposit_address") { const d = await pocket.depositInfo(); return JSON.stringify({ address: d.address, networks: d.perChain, accepted: d.tokens, warning: d.warning }); }
  if (name === "pocket_balance") { const i = await pocket.info(), p = i.policy; return `Pocket money: $${i.balanceUsd.toFixed(2)} (${i.balances.map(b => `${b.amount} ${b.token} on ${b.chain}`).join(", ") || "empty"}). Auto-pays up to $${p.perTxUsd} per payment and $${p.dailyUsd} per day; $${i.spentToday.toFixed(2)} spent today.`; }
  if (!OWNER && name === "get_balances") return runTool("pocket_balance", {}).then(x => "Nib has only its own pocket (no other wallet is used). " + x);   // pocket-only mode: "my balance" means the pocket
  if (!OWNER && name !== "send_money" && name !== "earn_kamino" && name !== "buy_token" && name !== "sell_token") return "No wallet is connected yet. Tell the user to press Change wallet on Nib and connect a wallet from their phone.";
  if (name === "get_balances") { const L = await balances(); return L.length ? JSON.stringify(L.slice(0, 12).map(b => ({ chain: b.chain, token: b.symbol, amount: +b.amount.toFixed(4), usd: +b.usd.toFixed(2) }))) : "The wallet is empty on all supported EVM chains."; }
  if (name === "my_savings") {
    const L = await balances(), out = [];
    for (const p of Object.values(EARN)) {
      const b = L.find(x => x.chain === p.chain && x.symbol === p.share); if (!b) continue;
      const dest = (await tokens()).find(x => x.blockchain === p.chain && x.symbol === p.underlying);
      const q = (await (await fetch(ONECLICK + "/quote", { method: "POST", headers: { "content-type": "application/json", ...jwt }, body: JSON.stringify({ dry: true, swapType: "EXACT_INPUT", slippageTolerance: 100, originAsset: b.assetId, depositType: "ORIGIN_CHAIN", destinationAsset: dest.assetId, amount: b.raw, refundTo: OWNER_DISPLAY, refundType: "ORIGIN_CHAIN", recipient: OWNER_DISPLAY, recipientType: "DESTINATION_CHAIN", deadline: new Date(Date.now() + 600e3).toISOString() }) })).json()).quote;
      out.push({ product: p.name, shares: +b.amount.toFixed(6), worth_usdc: q ? +Number(q.amountOutFormatted).toFixed(2) : null });
    }
    return out.length ? JSON.stringify(out) : "No savings yet.";
  }
  if (name === "earn_withdraw") {
    const L = await balances(), want = a.product ? earnId(a.product) : null;
    const p = want ? EARN[want] : Object.values(EARN).find(x => L.some(b => b.chain === x.chain && b.symbol === x.share));
    const b = p && L.find(x => x.chain === p.chain && x.symbol === p.share);
    if (!b) return "There is no savings position to withdraw.";
    const iq = await intentQuote(b, BigInt(b.raw), OWNER_DISPLAY, p.chain, p.underlying); if (iq.error) return iq.error;
    return { needs_confirm: true, id: newPending("earn_withdraw", `take your savings out of ${p.name.split(" (")[0]}, about $${fmt(iq.q.amountOutFormatted)} back`, [planTransfer(b, iq.q.depositAddress, BigInt(b.raw))], { via: "intents", expectedOut: iq.q.amountOutFormatted, eta: iq.q.timeEstimate, depositAddress: iq.q.depositAddress }) };
  }
  if (name === "sell_token") {
    const sym = /^(kamino|camino|kamina|camina|камино)\b/i.test(String(a.token || "")) ? "kV-gtSOLb" : String(a.token || "").trim();
    const want = +a.amount_usd > 0 ? +a.amount_usd : 0, b = (await pocket.balances()).find(x => x.symbol.toUpperCase() === sym.toUpperCase() && x.usd > 0.01);
    if (!b) return `There is no ${sym} in the pocket.`;
    const all = !want || want >= b.usd * 0.995, usd = all ? b.usd : want;
    const chk = pocket.check({ usd, toName: "USDC", contactAddedAt: 0, pinSet: !!pinRec });
    if (!chk.ok) return `Pocket cannot do this: ${chk.reasons.join("; ")}.`;
    let prep; try { prep = await pocket.prepare({ to: pocket.account, usd, destChain: a.to_chain ? String(a.to_chain).toLowerCase() : "arb", destToken: a.to_token || "USDC", internal: true, originToken: b.symbol, originChain: b.chain, sellAll: all }); } catch (e) { prep = { error: e.message }; }
    console.log("[pocket] sell", sym, prep.ok ? "ok" : prep.error);
    if (prep.ok) return { needs_confirm: true, id: startPocketJob(`USDC (sold ${sym})`, pocket.account, prep, chk.tier) };
    return String(prep.error);
  }
  const usd = +a.amount_usd;
  if (!(usd > 0) || usd > MAX_USD) return `Invalid amount. Max per action is ${MAX_USD} USD.`;
  const noCover = `No single token in the wallet covers ${usd} USD. Call get_balances and tell the user what they have.`;
  if (name === "buy_token") {
    const sym = String(a.token || "").trim(); let ch = a.chain ? String(a.chain).trim().toLowerCase() : undefined, ds = sym;
    if (/^w?near$/i.test(sym) && !a.chain) { ch = "near"; ds = "wNEAR"; }
    if (!ch) { const all = (await tokens()).filter(t => t.symbol.toUpperCase() === sym.toUpperCase() && !/DEPRECATED/.test(t.symbol)); if (all.length === 1) ch = all[0].blockchain; else if (all.length) return `${sym} exists on several networks (${all.map(t => t.blockchain).join(", ")}). Ask which one.`; else return `NEAR Intents has no ${sym}.`; }
    const chk = pocket.check({ usd, toName: sym, contactAddedAt: 0, pinSet: !!pinRec });
    if (!chk.ok) return `Pocket cannot do this: ${chk.reasons.join("; ")}.`;
    let prep; try { prep = await pocket.prepare({ to: pocket.account, usd, destChain: ch, destToken: ds, internal: true }); } catch (e) { prep = { error: e.message }; }
    console.log("[pocket] buy", sym, ch, prep.ok ? "ok" : prep.error);
    if (prep.ok) return { needs_confirm: true, id: startPocketJob(sym.toUpperCase(), pocket.account, prep, chk.tier) };
    return String(prep.error);
  }
  if (name === "earn_kamino") {
    const chk = pocket.check({ usd, toName: "Kamino", contactAddedAt: 0, pinSet: !!pinRec });
    if (!chk.ok) return `Pocket cannot do this: ${chk.reasons.join("; ")}.`;
    let prep; try { prep = await pocket.prepare({ to: pocket.account, usd, destToken: "Kamino", internal: true }); } catch (e) { prep = { error: e.message }; }
    console.log("[pocket] kamino prepare", prep.ok ? "ok" : prep.error);
    if (prep.ok) return { needs_confirm: true, id: startPocketJob("Kamino", pocket.account, prep, chk.tier) };
    return /liquidity|no quote|400/i.test(String(prep.error)) ? "The Kamino swap needs about $12 or more, smaller amounts have no liquidity." : String(prep.error);
  }
  if (name === "send_money") {
    const key = Object.keys(CONTACTS).find(k => k.toLowerCase() === String(a.to).toLowerCase()) || fuzzyContact(a.to);
    const isMe = String(a.to).toLowerCase() === "me", toName = key || (isMe ? "me" : null);
    const to = key ? contactAddr(CONTACTS[key]) : isMe ? OWNER_DISPLAY : a.to; // the address always comes from the contact list, never from model text
    if (isMe && !OWNER) return "No wallet is connected, so 'me' is not set. The user can add their own address as a contact.";
    if (!/^0x[0-9a-fA-F]{40}$/.test(to)) return `Unknown recipient "${a.to}". Tell the user it is not in contacts and ask them to add the contact or give a 0x address.`;
    if (a.pay_from !== "wallet" && toName) { // pocket money: autonomous, but only inside the deterministic policy
      const chk = pocket.check({ usd, toName, contactAddedAt: key ? contactAdded(CONTACTS[key]) : 0, pinSet: !!pinRec });
      console.log("[pocket] check", JSON.stringify(chk));
      if (chk.ok) {
        const prep = await pocket.prepare({ to, usd, destChain: a.dest_chain ? norm(a.dest_chain) : undefined, destToken: a.dest_token });
        console.log("[pocket] prepare", prep.ok ? "ok" : prep.error);
        if (prep.ok) return { needs_confirm: true, id: startPocketJob(toName, to, prep, chk.tier) };
        if (a.pay_from === "pocket") return prep.error;
      } else if (a.pay_from === "pocket") return `Pocket cannot pay: ${chk.reasons.join("; ")}. Offer to pay from the wallet with phone confirmation.`;
    }
    if (!OWNER) return "Nib's pocket money did not pay this (see its limits, balance or contact rules), and no wallet is connected for phone confirmation.";
    const o = await pickOrigin({ from_token: a.from_token, from_chain: a.from_chain, usd });
    if (!o) return noCover;
    const dc = norm(a.dest_chain || o.chain), ds = String(a.dest_token || o.symbol), units = toUnits(usd / o.price, o.decimals), amt = +(usd / o.price).toFixed(o.decimals > 6 ? 6 : o.decimals);
    if (!CHAINS[dc]) return `Only EVM destination chains are supported (${Object.keys(CHAINS).join(", ")}).`;
    if (dc === o.chain && ds.toUpperCase() === o.symbol.toUpperCase()) // same asset, same chain: plain transfer, no swap needed
      return { needs_confirm: true, id: newPending("send_money", `send $${fmt(usd)} to ${toName === "me" ? "yourself" : (toName || short(to))}`, [planTransfer(o, to, units)], { to }) };
    const iq = await intentQuote(o, units, to, dc, ds); if (iq.error) return iq.error;
    return { needs_confirm: true, id: newPending("send_money", `send $${fmt(usd)} to ${toName === "me" ? "yourself" : (toName || short(to))}. They get about ${fmt(iq.q.amountOutFormatted)} ${iq.dest.symbol} on ${CHAINS[dc].name}`, [planTransfer(o, iq.q.depositAddress, units)],
      { to, via: "intents", expectedOut: iq.q.amountOutFormatted, eta: iq.q.timeEstimate, depositAddress: iq.q.depositAddress }) };
  }
  if (name === "earn_deposit") {
    const id = earnId(a.product), p = EARN[id]; if (!p) return `Unknown Earn product. Options: ${Object.keys(EARN).join(", ")}.`;
    if (usd < p.min) return `${p.name} needs at least about $${p.min} per deposit. Ask the user for a bigger amount.`;
    const o = await pickOrigin({ from_token: a.from_token, from_chain: a.from_chain, usd, prefer: a.from_token || a.from_chain ? null : { chain: p.chain, symbol: p.underlying } });
    if (!o) return noCover;
    const units = toUnits(usd / o.price, o.decimals), amt = +(usd / o.price).toFixed(o.decimals > 6 ? 6 : o.decimals);
    const iq = await intentQuote(o, units, OWNER_DISPLAY, p.chain, p.share); if (iq.error) return iq.error;
    return { needs_confirm: true, id: newPending("earn_deposit", `save $${fmt(usd)} in ${p.name.split(" (")[0]}`, [planTransfer(o, iq.q.depositAddress, units)], { via: "intents", expectedOut: iq.q.amountOutFormatted, eta: iq.q.timeEstimate, depositAddress: iq.q.depositAddress }) };
  }
  if (name === "fund_pocket") {
    const capUsd = pocket.policy().maxBalanceUsd, curUsd = lastPocket ?? await pocketTotal().catch(() => 0);
    if (curUsd + usd > capUsd) return `My pocket may hold at most $${capUsd}. It has $${curUsd.toFixed(2)}, so there is room for $${Math.max(0, capUsd - curUsd).toFixed(2)}.`;
    const o = await pickOrigin({ from_token: a.from_token, from_chain: a.from_chain, usd });
    if (!o) return noCover;
    const dc = isStable(o) ? o.chain : "base", ds = isStable(o) ? o.symbol : "USDC", units = toUnits(usd / o.price, o.decimals), amt = +(usd / o.price).toFixed(o.decimals > 6 ? 6 : o.decimals);
    const iq = await intentQuote(o, units, pocket.account, dc, ds, "INTENTS"); if (iq.error) return iq.error;
    return { needs_confirm: true, id: newPending("fund_pocket", `put $${fmt(usd)} into my pocket`, [planTransfer(o, iq.q.depositAddress, units)], { via: "intents", expectedOut: iq.q.amountOutFormatted, eta: iq.q.timeEstimate, depositAddress: iq.q.depositAddress }) };
  }
  return "Unknown tool.";
}
const askText = p => p.kind === "pocket_send" ? (p.status === "needs_pin" ? `From my pocket: ${p.summary}. Enter your PIN on my screen.` : (p.delaySeconds === 0 ? p.summary.replace(/^pay /, "Sent ") + "." : `From my pocket: ${p.summary}. Sending in ${p.delaySeconds}s. Tap Cancel to stop.`)) : `From your wallet: ${p.summary}. ${p.pay ? "Scan the QR to approve." : "Approve on your phone."}`;

// ---------- agent (short session memory so "put 100 there" works) ----------
const systemPrompt = () => `Today is ${new Date().toISOString().slice(0, 10)}. You are Nib, a pocket assistant with a tiny screen.
LANGUAGE: always reply in ENGLISH, even when the user writes Russian or any other language.
STYLE (strict): reply in ONE short sentence, at most 20 words and under 140 characters. Answer first. Use simple everyday words, no jargon: say "save" not "deposit", "your wallet" not "address", dollars instead of token names, and do not mention chains or tokens unless asked. No greeting, no filler, no restating the question, no lists, no markdown. English only and plain ASCII (no emoji), even if the user writes another language. Mention the data time only if it matters (e.g. "as of 22:00"). If you do not know, or a tool returned nothing, say so in a few words. If the request is unclear, ask ONE short question.
FACTS: never invent anything. Use get_weather, get_price and web_answer for live facts. If a web result is older than about a week for a "latest" question, say it may be outdated.
TWO BALANCES (always say which one you mean): "your wallet" = the owner's own money, every payment needs the owner's approval. "my pocket" = Nib's own small balance, which Nib may spend alone within limits and which may hold at most $100. The owner's wallet is OPTIONAL: when none is connected, you only have your own pocket, so never mention the wallet and never suggest connecting one unless the owner asks about it. Talk only about the pocket. When the user does not say which, small payments to saved contacts use the pocket when it has money, everything else uses the wallet; the owner can force one with "from my wallet" or "from your pocket".
MONEY: known contacts: ${[...Object.keys(CONTACTS), "me"].join(", ")} ("me" is the owner's own wallet). Amounts are in USD. The wallet can hold tokens on many chains; tools pick the source token and convert with NEAR Intents. Balances: get_balances (wallet) or pocket_balance (Nib's own pocket money). Savings: get_earn_options, never state an APY (none is available). To top up the pocket: pocket_deposit_address. Payments to saved contacts: up to $10 are paid from the pocket alone after a short cancel window; $10 to $50 need the owner's PIN typed on the device (a PIN must be set); more than $50, new contacts and raw addresses need the owner's phone. For any money movement call the tool; never say it is done before it is confirmed or the cancel window has passed. SAVINGS GOAL: the owner can set one savings goal with set_goal (short English name and a dollar target); progress is Nib's pocket balance toward the target; use get_goal to report it.`;
let history = [], historyAt = 0;
const trim = () => { history = history.slice(-20); while (history.length && history[0].role !== "user") history.shift(); };
// final answers: strip markdown, cap at 160 chars on a sentence boundary
const clean = t => { t = String(t || "").replace(/[*_`#]/g, "").replace(/\s+/g, " ").trim(); if (t.length <= 160) return t; const cut = t.slice(0, 160), end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("? "), cut.lastIndexOf("! ")); return end > 40 ? cut.slice(0, end + 1) : cut.slice(0, cut.lastIndexOf(" ")) + "..."; };
// how the pet feels about its own answer (a cheap rule, so no extra model call)
const moodOf = t => /\?\s*$/.test(t) ? "confused" : /\b(sorry|can't|cannot|couldn't|unable|don't know|not available)\b/i.test(t) ? "sad" : /\b(haha|funny|laugh)\b|why did|knock knock/i.test(t) ? "laugh" : /\b(thank|thanks|love|congrat|welcome)\b/i.test(t) ? "love" : "happy";
const levd = (x, y) => { const d = Array.from({ length: x.length + 1 }, (_, i) => [i, ...Array(y.length).fill(0)]); for (let j = 1; j <= y.length; j++) d[0][j] = j; for (let i = 1; i <= x.length; i++) for (let j = 1; j <= y.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1)); return d[x.length][y.length]; };
function fuzzyContact(name) {   // the recogniser heard "Vyrex" for "Wirex": pick the single saved contact that is clearly the closest (only saved contacts, distance <= 2)
  const n = String(name || "").toLowerCase().replace(/[^a-z0-9]/g, ""); if (n.length < 4) return null;
  const sc = Object.keys(CONTACTS).map(k => [k, levd(n, k.toLowerCase())]).sort((x, y) => x[1] - y[1]);
  return sc.length && sc[0][1] <= 2 && (sc.length === 1 || sc[1][1] > sc[0][1]) ? sc[0][0] : null; }
async function agent(text) {
  if (!LLMS.length) return mockAgent(text);
  if (Date.now() - historyAt > TTL) history = [];
  historyAt = Date.now();
  history = history.filter(m => m.role === "user" || (m.role === "assistant" && !m.tool_calls && m.content));   // old tool results are dropped: every new question gets fresh data
  history.push({ role: "user", content: text });
  let retried = 0, extraSys = null;
  for (let i = 0; i < 5; i++) {
    const r = await chat([{ role: "system", content: systemPrompt() + " Live data (balances, prices, news, contacts, limits) changes all the time: for EVERY new question call the tool again and NEVER reuse numbers or facts from your earlier answers. The speech-to-text often mishears names: Vyrex/Wyrex/Wirex = Wirex, Neuro/Nir/Near = NEAR, Camino = Kamino. If the user speaks Russian, understand it but ALWAYS reply in English." }, ...history, ...(extraSys ? [{ role: "system", content: extraSys }] : [])]);//.json();
    const m = r.choices?.[0]?.message; if (!m) return { say: "My thinking service is down right now. Try again soon.", state: "sad" };
    if (!m.tool_calls?.length) {
      let out = clean(m.content);
      if (!out || /[^\x20-\x7E]/.test(out)) { // empty, or not plain-ASCII English: ask once more, then fall back
        if (retried < 1) { retried++; extraSys = !out ? "Reply with one short sentence." : "Your last reply was not in English. Reply in English only, plain ASCII, one short sentence."; i--; continue; }
        out = out.replace(/[^\x20-\x7E]/g, "").trim() || "Sorry, say that again?";
      }
      history.push({ role: "assistant", content: out }); trim(); return { say: out, state: moodOf(out) };
    }
    history.push(m);
    let ask = null;
    for (const tc of m.tool_calls) {
      let res; try { res = await runTool(tc.function.name, JSON.parse(tc.function.arguments || "{}")); } catch (e) { res = "Tool error: " + e.message; } console.log("[tool]", tc.function.name, tc.function.arguments, typeof res === "string" ? res.slice(0, 160) : JSON.stringify(res).slice(0, 120));
      if (res && res.needs_confirm) { ask = pending.get(res.id); history.push({ role: "tool", tool_call_id: tc.id, content: ask.kind === "pocket_send" ? (ask.status === "needs_pin" ? "Waiting for the owner to enter the PIN on the device." : "Payment scheduled; it will be sent after a short cancel window.") : "Waiting for the owner to confirm on their phone." }); }
      else history.push({ role: "tool", tool_call_id: tc.id, content: String(res) });
    }
    if (ask) { const say = askText(ask); history.push({ role: "assistant", content: say }); trim(); return { say, state: ask.kind === "pocket_send" && ask.delaySeconds === 0 && ask.status !== "needs_pin" ? "happy" : "ask", pendingId: ask.id, phone: ask.status === "waiting", needsPin: ask.status === "needs_pin", uri: ask.pay?.uri }; }
  }
  return { say: "Got lost, try again", state: "sad" };
}
async function mockAgent(t) {
  const n = +(t.match(/(\d+(?:\.\d+)?)/) || [])[1];
  const act = async (tool, a) => { const r = await runTool(tool, a); return r.needs_confirm ? { say: askText(pending.get(r.id)), state: "ask", pendingId: r.id } : { say: String(r), state: "sad" }; };
  if (/earn|deposit|apy/i.test(t) && n) return act("earn_deposit", { amount_usd: n });
  if (/send|transfer/i.test(t) && n) return act("send_money", { to: (t.match(/to\s+(\w+)/i) || [, "me"])[1], amount_usd: n });
  return { say: "(mock) Set NEAR_AI_API_KEY for real answers.", state: "happy" };
}

// ---------- on-chain verification of what the phone signed ----------
async function rpc(chain, method, params) { const r = await (await fetch(CHAINS[chain].rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json(); if (r.error) throw new Error(r.error.message); return r.result; }
async function waitFor(fn, tries = 40) { for (let i = 0; i < tries; i++) { const v = await fn(); if (v) return v; await sleep(2000); } return null; }
async function verify(p, hashes) {
  try {
    for (let i = 0; i < p.plan.length; i++) {
      const step = p.plan[i], h = hashes[i];
      const tx = await waitFor(() => rpc(step.chain, "eth_getTransactionByHash", [h])); if (!tx) throw new Error(`${step.label}: tx not found on ${step.chain}`);
      if (tx.from.toLowerCase() !== OWNER) throw new Error("tx not from owner wallet");
      if ((tx.to || "").toLowerCase() !== step.to) throw new Error("tx sent to unexpected address");
      if (tx.input.toLowerCase() !== step.data) throw new Error("tx data does not match the request");
      if (BigInt(tx.value || "0x0") !== BigInt(step.value || "0x0")) throw new Error("tx value does not match the request");
      const rc = await waitFor(() => rpc(step.chain, "eth_getTransactionReceipt", [h])); if (!rc || rc.status !== "0x1") throw new Error(`${step.label}: tx failed or timed out`);
    }
    p.status = "done"; p.txHashes = hashes; bal.at = 0;
    if (p.via === "intents") trackSwap(p, hashes[hashes.length - 1]);
  } catch (e) { p.status = "failed"; p.error = String(e.message); }
}

// ---------- STT ----------
function wav(pcm) { const h = Buffer.alloc(44); h.write("RIFF"); h.writeUInt32LE(36 + pcm.length, 4); h.write("WAVEfmt ", 8); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(16000, 24); h.writeUInt32LE(32000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write("data", 36); h.writeUInt32LE(pcm.length, 40); return Buffer.concat([h, pcm]); }
async function stt(pcm) {
  const providers = [
    process.env.GROQ_API_KEY && { url: "https://api.groq.com/openai/v1/audio/transcriptions", key: process.env.GROQ_API_KEY, model: process.env.STT_MODEL || "whisper-large-v3-turbo" },
    process.env.OPENAI_API_KEY && { url: "https://api.openai.com/v1/audio/transcriptions", key: process.env.OPENAI_API_KEY, model: "whisper-1" },
    process.env.STT_URL && { url: process.env.STT_URL, key: process.env.STT_KEY, model: process.env.STT_MODEL || "whisper-1" },
    NEAR_AI.key && { url: "https://cloud-api.near.ai/v1/audio/transcriptions", key: NEAR_AI.key, model: "openai/whisper-large-v3" },
  ].filter(Boolean);
  if (!providers.length) return process.env.STT_MOCK || null;
  let lastErr = "speech service error";
  for (const p of providers) {
    try {
      const once = async (lang, verbose) => { const f = new FormData(); f.append("file", new Blob([wav(pcm)], { type: "audio/wav" }), "a.wav"); f.append("model", p.model); if (lang) f.append("language", lang); if (verbose) f.append("response_format", "verbose_json");
        f.append("prompt", "Hey Buddy, send five dollars to Plasma. Send ten dollars to Wirex. Put twelve dollars to Kamino earn. Swap ten dollars to NEAR. How much money do I have?");
        return await (await fetch(p.url, { method: "POST", headers: { authorization: "Bearer " + p.key }, body: f, signal: AbortSignal.timeout(20000) })).json(); };
      let r;
      if (/ru/i.test(process.env.STT_LANG || "") && global.__sttDetect !== false) {      // English + Russian: let Whisper detect the language, but only accept those two (auto-detect alone mishears short English phrases)
        r = await once(null, true);
        if (r.language) { global.__sttDetect = true; if (!/^(en|english|ru|russian)$/i.test(String(r.language))) r = await once("en"); }
        else { global.__sttDetect = false; r = await once("en"); }      // this provider cannot report the language: stay on English
      } else r = await once(process.env.STT_LANG === "auto" ? null : (process.env.STT_LANG || "en"));
      if (typeof r.text === "string") return r.text.trim() || null;
      lastErr = r.error?.message || lastErr;
    } catch (e) { lastErr = e.message; }
  }
  throw new Error(lastErr);
}

// ---------- http ----------
const raw = req => new Promise(r => { const c = []; req.on("data", d => c.push(d)); req.on("end", () => r(Buffer.concat(c))); });
const send = (res, code, obj, type = "application/json") => { res.writeHead(code, { "content-type": type, "access-control-allow-origin": "*" }); res.end(type === "application/json" ? JSON.stringify(obj, (k, v) => typeof v === "bigint" ? v.toString() : v) : obj); };
const body = req => new Promise(r => { let b = ""; req.on("data", c => b += c); req.on("end", () => { try { r(b ? JSON.parse(b) : {}); } catch { r({}); } }); });
const file = (res, f, type) => send(res, 200, fs.readFileSync(path.join(__dirname, "..", f)), type);
const lan = () => Object.values(os.networkInterfaces()).flat().find(i => i && i.family === "IPv4" && !i.internal)?.address || "localhost";
const live = p => { if (p.status === "waiting" && Date.now() - p.createdAt > TTL) p.status = "expired"; return p; };
const INBOX = `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>Nib inbox</title><body style="font:18px system-ui;background:#1d1830;color:#fff;text-align:center;padding:40px">Waiting for Nib to ask something…<script>setInterval(async()=>{const r=await(await fetch('/latest')).json();if(r.id)location.href='/confirm/'+r.id},2000)</script>`;

http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, "http://x");
    if (req.method === "OPTIONS") return send(res, 204, {});
    // Requests that arrive through a public tunnel carry x-forwarded-for. Over the tunnel ONLY the phone pages are reachable;
    // the brain (/ask, /voice), balances, pocket, cancel, simulator etc. stay local-network only.
    const devKeyOk = !!process.env.NIB_DEVICE_KEY && req.headers["x-nib-key"] === process.env.NIB_DEVICE_KEY && /^\/(summary|pocket-address|qr|contacts\.json|goal|voice)$/.test(u.pathname);   // the device may use ONLY these routes through the tunnel, and only with its key
    const hostName = String(req.headers.host || "").replace(/:\d+$/, ""), isLan = /^(localhost|127\.0\.0\.1|\[::1\]|\d{1,3}(\.\d{1,3}){3}|[\w-]+\.local)$/i.test(hostName), external = !!req.headers["x-forwarded-for"] || !isLan;   // a tunnel gives a public hostname (and may not send x-forwarded-for)
    if (external && !devKeyOk && !/^\/(setup|contacts|contacts\.json|inbox|latest|config|owner|pair|pending\/\w+|confirm\/\w+)$/.test(u.pathname)) return send(res, 403, { error: "not available over the tunnel" });
    if (u.pathname === "/" || u.pathname === "/sim") return file(res, "sim/index.html", "text/html");
    if (u.pathname === "/gallery") return file(res, "sim/gallery.html", "text/html");
    if (u.pathname === "/sprites.js") return file(res, "character/sprites.js", "text/javascript");
    if (u.pathname === "/contacts") return file(res, "phone/contacts.html", "text/html");
    if (u.pathname === "/contacts.json" && req.method === "GET") return send(res, 200, Object.entries(CONTACTS).map(([name, a]) => ({ name, address: short(contactAddr(a)) })));
    if (u.pathname === "/contacts.json" && req.method === "POST") { // needs the pairing code currently shown on Nib
      const { code, name, address } = await body(req);
      if (!pairing || Date.now() > pairing.exp || String(code) !== pairing.code) return send(res, 403, { error: "Wrong or expired code. Press Add contact on Nib again." });
      if (!/^[\w .-]{1,24}$/.test(name || "") || String(name).toLowerCase() === "me") return send(res, 400, { error: "Bad name" });
      if (!/^0x[0-9a-fA-F]{40}$/.test(address || "")) return send(res, 400, { error: "Bad 0x address" });
      CONTACTS[name] = { address, addedAt: Date.now() }; fs.writeFileSync(CONTACTS_FILE, JSON.stringify(CONTACTS, null, 2) + "\n");
      return send(res, 200, { ok: true });
    }
    if (u.pathname === "/pair-start" && req.method === "POST") { if (!unlocked(req)) return needPin(res); // only from the local network, never through a public tunnel
      if (req.headers["x-forwarded-for"]) return send(res, 403, { error: "Pairing is only allowed from the local network." });
      pairing = { code: String(Math.floor(100000 + Math.random() * 900000)), exp: Date.now() + 5 * 60e3 }; return send(res, 200, { code: pairing.code, url: `${process.env.PUBLIC_URL || `http://${lan()}:${PORT}`}/setup` }); }
    if (u.pathname === "/setup") return file(res, "phone/setup.html", "text/html");
    if (u.pathname === "/pair" && req.method === "POST") { // phone sends the code shown on Nib + the wallet address it connected
      const { code, address } = await body(req);
      if (!pairing || Date.now() > pairing.exp || String(code) !== pairing.code) return send(res, 403, { error: "Wrong or expired code. Press Change wallet on Nib again." });
      if (!/^0x[0-9a-fA-F]{40}$/.test(address || "")) return send(res, 400, { error: "Bad address" });
      OWNER_DISPLAY = address; OWNER = address.toLowerCase(); pairing = null; bal.at = 0; pending.clear();
      fs.writeFileSync(OWNER_FILE, JSON.stringify({ owner: address }) + "\n");
      return send(res, 200, { ok: true, owner: address });
    }
    if (u.pathname === "/qr") { // QR matrix for the screen (vendored MIT 'qrcode' core)
      const t = u.searchParams.get("text") || ""; if (!t || t.length > 400) return send(res, 400, { error: "bad text" });
      const q = require("./vendor/qrcode/core/qrcode").create(t, { errorCorrectionLevel: "M" }), n = q.modules.size, rows = [];
      for (let r = 0; r < n; r++) { let line = ""; for (let c = 0; c < n; c++) line += q.modules.data[r * n + c] ? "1" : "0"; rows.push(line); }
      return send(res, 200, { size: n, rows });
    }
    if (u.pathname === "/reset" && req.method === "POST") { history = []; return send(res, 200, { ok: true }); } // new conversation (also used by the tests)
    if (u.pathname === "/pocket-address") return send(res, 200, await pocket.depositInfo());
    if (u.pathname === "/goal" && req.method === "GET") return send(res, 200, goalView(lastPocket ?? 0));
    if (u.pathname === "/goal" && req.method === "POST") { const { name, target } = await body(req); const r = await setGoal(name, target); return send(res, r.error ? 400 : 200, r); }
    if (u.pathname === "/goal/clear" && req.method === "POST") { goal = null; saveGoal(); global.__sum = null; return send(res, 200, { ok: true }); }
    if (u.pathname === "/events") { const since = +u.searchParams.get("since") || 0; return send(res, 200, { last: eid, events: events.filter(e => e.id > since) }); }
    if (u.pathname === "/test/credit" && req.method === "POST") { // TEST ONLY: pretend money arrived in the pocket
      if (process.env.POCKET_TEST_BALANCE !== "1") return send(res, 404, { error: "not found" });
      globalThis.__pocketTestOffset = (globalThis.__pocketTestOffset || 0) + (+(await body(req)).usd || 0); global.__sum = null; return send(res, 200, { ok: true });
    }
    if (u.pathname.startsWith("/pocket/approve/") && req.method === "POST") { // mid-size pocket payment: the owner types the PIN on the device (never accepted from an unlock token)
      const id = u.pathname.split("/")[3], j = pending.get(id); if (!j || j.kind !== "pocket_send") return send(res, 404, { error: "nope" });
      if (j.status !== "needs_pin") return send(res, 409, { error: "This payment is not waiting for a PIN", status: j.status });
      if (pocket.isFrozen()) { cancelJob(id); return send(res, 409, { error: "Auto-pay is paused" }); }
      if (!pinRec) return send(res, 409, { error: "No PIN is set" });
      const c = checkPin((await body(req)).pin); if (!c.ok) return send(res, c.status, c.body);
      approveJob(id); return send(res, 200, { ok: true });
    }
    if (u.pathname === "/pin/state") return send(res, 200, { set: !!pinRec, unlocked: unlocked(req) });
    if (u.pathname === "/pin/verify" && req.method === "POST") {
      if (!pinRec) return send(res, 200, { ok: true, token: null });
      const c = checkPin((await body(req)).pin); if (!c.ok) return send(res, c.status, c.body);
      const token = crypto.randomBytes(16).toString("hex"); unlocks.set(token, Date.now() + 120e3); return send(res, 200, { ok: true, token, expiresIn: 120 });
    }
    if (u.pathname === "/pin/set" && req.method === "POST") {
      if (pinRec && !unlocked(req)) return needPin(res);
      const { pin } = await body(req); if (!/^\d{4,6}$/.test(pin || "")) return send(res, 400, { error: "Use 4 to 6 digits" }); if (weakPin(pin)) return send(res, 400, { error: "Choose a less obvious PIN" });
      const salt = crypto.randomBytes(16); pinRec = { salt: salt.toString("hex"), hash: crypto.scryptSync(pin, salt, 32).toString("hex") };
      fs.writeFileSync(PIN_FILE, JSON.stringify(pinRec), { mode: 0o600 }); unlocks.clear(); return send(res, 200, { ok: true });
    }
    if (u.pathname === "/pin/remove" && req.method === "POST") {
      if (!pinRec) return send(res, 200, { ok: true });
      const c = checkPin((await body(req)).pin); if (!c.ok) return send(res, c.status, c.body);
      pinRec = null; fs.writeFileSync(PIN_FILE, "{}\n"); unlocks.clear(); return send(res, 200, { ok: true });
    }
    // ---- Wi-Fi setup: SIMULATION of the device's own captive portal (fake scan list, demo password) ----
    if (u.pathname === "/wifi/state") return send(res, 200, { ssid: wifi.ssid || null });
    if (u.pathname === "/wifi/scan") return send(res, 200, WIFI_NETS.map(n => ({ ...n, connected: n.ssid === wifi.ssid })));
    if (u.pathname === "/wifi/forget" && req.method === "POST") { wifi = { ssid: null }; fs.writeFileSync(WIFI_FILE, JSON.stringify(wifi)); return send(res, 200, { ok: true }); }
    if (u.pathname === "/wifi/session" && req.method === "POST") { // the pet shows a QR that opens the phone page for one network
      const { ssid } = await body(req); if (!WIFI_NETS.some(n => n.ssid === ssid)) return send(res, 404, { error: "Network not found" });
      const code = String(Math.floor(100000 + Math.random() * 900000)); wifiSessions[code] = { ssid, exp: Date.now() + 5 * 60e3, status: "waiting" };
      return send(res, 200, { code, url: `${process.env.PUBLIC_URL || `http://${lan()}:${PORT}`}/wifi?code=${code}&ssid=${encodeURIComponent(ssid)}` });
    }
    if (u.pathname === "/wifi") return file(res, "phone/wifi.html", "text/html");
    if (u.pathname === "/wifi/result") { const s = wifiSessions[u.searchParams.get("code")]; return send(res, 200, s && Date.now() < s.exp ? { status: s.status, error: s.error } : { status: "expired" }); }
    if (u.pathname === "/wifi/join" && req.method === "POST") {
      const { ssid, password, code } = await body(req), net = WIFI_NETS.find(n => n.ssid === ssid), s = code ? wifiSessions[code] : null;
      if (!net) return send(res, 404, { error: "Network not found" });
      if (code && (!s || Date.now() > s.exp || s.ssid !== ssid)) return send(res, 403, { error: "This setup link expired" });
      if (net.secure && password !== DEMO_WIFI_PASSWORD) { if (s) { s.status = "failed"; s.error = "wrong password"; } return send(res, 403, { error: "Wrong password" }); }
      wifi = { ssid }; fs.writeFileSync(WIFI_FILE, JSON.stringify(wifi)); if (s) s.status = "ok";
      return send(res, 200, { ok: true, ssid });
    }
    if (u.pathname === "/freeze" && req.method === "POST") { const { on } = await body(req); if (!on && !unlocked(req)) return needPin(res); pocket.setFrozen(!!on); global.__sum = null; return send(res, 200, { frozen: pocket.isFrozen() }); }
    if (u.pathname === "/activity") { const names = Object.fromEntries(Object.entries(CONTACTS).map(([n, v]) => [contactAddr(v).toLowerCase(), n])); return send(res, 200, pocket.activity().map(l => ({ ts: l.ts, usd: l.usd, to: names[String(l.to).toLowerCase()] || short(String(l.to)) }))); }
    if (u.pathname === "/signout" && req.method === "POST") { if (!unlocked(req)) return needPin(res); // forget wallet + contacts on this device. The pocket (its key and money) stays untouched.
      OWNER_DISPLAY = ""; OWNER = ""; fs.writeFileSync(OWNER_FILE, "{}\n");
      for (const k of Object.keys(CONTACTS)) delete CONTACTS[k]; fs.writeFileSync(CONTACTS_FILE, "{}\n");
      pending.clear(); history = []; bal.at = 0; global.__sum = null; pairing = null;
      return send(res, 200, { ok: true });
    }
    if (u.pathname.startsWith("/sim-assets/") && /^[\w.-]+\.(js|css)$/.test(u.pathname.slice(12))) { const n = u.pathname.slice(12); return file(res, "sim/" + n, n.endsWith(".css") ? "text/css" : "text/javascript"); }
    if (u.pathname === "/weather") return send(res, 200, await weatherNow().catch(() => ({})));
    if (u.pathname === "/summary") { // balances for the screen (cached 15 s: the NEAR RPC can take ~3 s)
      if (!global.__sum || Date.now() - global.__sum.at > 15e3) { const [pk, wb] = await Promise.all([pocket.info(), OWNER ? balances() : []]); global.__sum = { at: Date.now(), data: { wallet: { connected: !!OWNER, address: OWNER_DISPLAY || null, usd: wb.reduce((s, b) => s + b.usd, 0) }, pocket: { usd: pk.balanceUsd, tokens: (pk.balances || []).filter(b => b.usd >= 0.01).slice(0, 4), perTx: pk.policy.perTxUsd, daily: pk.policy.dailyUsd, autoDaily: pk.policy.autoDailyUsd, cap: pk.policy.maxBalanceUsd, pinPerTx: pk.policy.pinPerTxUsd, spent: pk.spentToday, frozen: pk.frozen, account: pocket.account } } }; }
      return send(res, 200, { ...global.__sum.data, goal: goalView(global.__sum.data.pocket.usd), feed: feedView(global.__sum.data.pocket.usd) });
    }
    if (u.pathname === "/pocket") return send(res, 200, await pocket.info());
    if (u.pathname.startsWith("/cancel/") && req.method === "POST") return send(res, 200, { cancelled: cancelJob(u.pathname.split("/")[2]) });
    if (u.pathname === "/owner") return send(res, 200, { owner: OWNER_DISPLAY || null });
    if (u.pathname === "/config") return send(res, 200, { owner: OWNER_DISPLAY, dry: DRY, chains: Object.fromEntries(Object.entries(CHAINS).map(([k, c]) => [k, { idHex: "0x" + c.id.toString(16), name: c.name, rpc: c.rpc, explorer: c.explorer, native: c.native }])), phoneUrl: `${process.env.PUBLIC_URL || `http://${lan()}:${PORT}`}/inbox` });
    if (u.pathname === "/balances") return send(res, 200, (await balances()).map(b => ({ chain: b.chain, token: b.symbol, amount: b.amount, usd: b.usd })));
    if (u.pathname === "/inbox") return send(res, 200, INBOX, "text/html");
    if (u.pathname === "/latest") { const p = [...pending.values()].map(live).reverse().find(x => x.status === "waiting"); return send(res, 200, { id: p ? p.id : null }); }
    if (u.pathname === "/voice" && req.method === "POST") { const wake = u.searchParams.get("wake") === "1", t0 = Date.now(); let text; try { text = await stt(await raw(req)); } catch (e) { return send(res, 200, { say: "My ears are not working right now. The speech service is down.", state: "sad", error: String(e.message) }); }
      console.log("[voice]", wake ? "wake" : "ask", JSON.stringify(text), Date.now() - t0, "ms");
      if (!text) return send(res, 200, wake ? { ignored: true } : { say: "Didn't catch that", state: "sad" });
      if (wake) { // always-listening mode: only speech that STARTS with "Hey Buddy" is answered; everything else is dropped (never sent to the assistant, never stored)
        let m = text.match(/^\W*(?:hey|hay|hi|hello|хей|хэй)[\s,.!-]*(?:buddy|bud|body|buddie|budy|buddi|бади|бадди)(?![A-Za-z])[\s,.!?-]*([\s\S]*)$/i);
        const lev = (a, b) => { const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]); for (let j = 1; j <= b.length; j++) d[0][j] = j; for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); return d[a.length][b.length]; };
        let fz = null; if (!m) { const w = text.trim().split(/\s+/); const cand = ((w[0] || "") + (w[1] || "")).toLowerCase().replace(/[^a-z]/g, ""); if (w.length >= 2 && /^b/i.test(w[1].replace(/[^a-z]/gi, "")) && lev(cand, "heybuddy") <= 3) fz = [null, w.slice(2).join(" ")]; }   // forgiving: "Hey, budger", "Hay body"...
        if (!m && !fz) return send(res, 200, { ignored: true });
        if (fz) { m = fz; }
        text = m[1].trim(); if (text.length < 2) return send(res, 200, { woke: true, say: "Yes?", state: "listening" });   // just the wake phrase: the device records the question next
      }
      return send(res, 200, { heard: text, ...(await agent(text)) }); }
    if (u.pathname === "/ask" && req.method === "POST") return send(res, 200, await agent((await body(req)).text || ""));
    if (u.pathname.startsWith("/pending/")) { const p = pending.get(u.pathname.split("/")[2]); return p ? send(res, 200, live(p)) : send(res, 404, { error: "nope" }); }
    if (u.pathname.startsWith("/confirm/")) { // phone page
      const p = pending.get(u.pathname.split("/")[2]); if (!p) return send(res, 404, "expired", "text/plain");
      if (req.method === "POST") {
        const { approve, txHashes } = await body(req); live(p);
        if (p.status !== "waiting") return send(res, 409, p);
        if (!approve) { p.status = "rejected"; return send(res, 200, p); }
        if (DRY) { p.status = "done"; p.note = "dry-run, nothing sent"; return send(res, 200, p); }
        if (!Array.isArray(txHashes) || txHashes.length !== p.plan.length || !txHashes.every(h => /^0x[0-9a-fA-F]{64}$/.test(h))) return send(res, 400, { error: "need tx hashes for every step" });
        p.status = "confirming"; verify(p, txHashes); return send(res, 200, p);
      }
      return file(res, "phone/confirm.html", "text/html");
    }
    send(res, 404, { error: "not found" });
  } catch (e) { send(res, 500, { error: String(e) }); }
}).listen(PORT, () => console.log(`Nib server http://localhost:${PORT}/sim | phone http://${lan()}:${PORT}/inbox | ${LLMS.length ? LLMS.map(l => l.name).join("+") : "MOCK"} ${DRY ? "DRY-RUN" : "LIVE-SIGN"}${TEST_ASSUME_BALANCE ? " TEST-BALANCE" : ""}`));

setInterval(watchMoney, (+process.env.MONEY_WATCH_SEC || 15) * 1000); watchMoney();   // notice money arriving in the pocket (the pet celebrates)
