// Settings shade for the simulator. Uses the simulator's globals (state, say, pick, ids, CHARACTERS, simWifi, simBt, micMuted, frozen, chg, addc, topup, wake ...).
// Real vs simulated: pocket, auto-pause, contacts, wallet, sign out, buddy are real (server-backed). Wi-Fi, Bluetooth, brightness are simulated here.
(function () {
  const c = document.getElementById('c'), wrap = document.createElement('div');
  wrap.style.cssText = 'position:relative;width:336px;height:496px';
  c.parentNode.insertBefore(wrap, c); wrap.appendChild(c);
  const shade = document.createElement('div'); shade.id = 'shade';
  shade.innerHTML = `<div id=scrim></div><div id=sheet class=pane>
  <div class=row style="margin-bottom:8px"><b style="font-size:15px">Settings</b><button class=btn id=shClose>Close</button></div>
  <div class=grid>
    <div class=tile id=tWifi><b>Wi-Fi</b><i class=chev id=wOpen>&rsaquo;</i><span id=tWifiS></span></div>
    <div class=tile id=tBt><b>Bluetooth</b><span id=tBtS></span></div>
    <div class=tile id=tMic><b>Microphone</b><span id=tMicS></span></div>
    <div class=tile id=tWake><b>Hey Buddy</b><span id=tWakeS></span></div>
    <div class=tile id=tPay style="grid-column:span 2"><b>Pocket auto-pay</b><span id=tPayS></span></div>
  </div>
  <div class=card><div class=row><span>Brightness</span><span id=brV class=dim>100%</span></div><input type=range id=br min=40 max=100 value=100></div>
  <h4>Pocket</h4>
  <div class=card>
    <div class=row><div><div style="font-size:24px;font-weight:700" id=pBal>--</div><div id=pLim class=dim></div></div><button class=btn id=pTop>Add money</button></div>
    <div class=row style="margin-top:8px"><span class=dim>Recent payments</span><button class="btn small" id=pAct>Show</button></div>
    <div id=pList style="display:none;margin-top:6px;font-size:11.5px"></div>
  </div>
  <h4>Savings goal</h4>
  <div class=card>
    <div id=gView class=dim></div>
    <div class=row style="margin-top:8px;gap:6px"><input id=gName placeholder="Goal, e.g. Sneakers" style="flex:1;min-width:0;padding:7px;border-radius:8px;border:1px solid #352c63;background:#120e26;color:#fff"><input id=gAmt type=number placeholder="$" style="width:72px;padding:7px;border-radius:8px;border:1px solid #352c63;background:#120e26;color:#fff"></div>
    <div class=row style="margin-top:8px"><button class=btn id=gSet>Set goal</button><button class="btn small danger" id=gClear>Clear</button></div><div id=gMsg class=dim style="margin-top:6px"></div>
  </div>
  <h4>Buddy</h4><div class=buddies id=buddies></div>
  <h4>Security</h4>
  <div class=card>
    <div class=row><div><div>PIN lock</div><div class=dim id=sPinS>Off</div></div><button class=btn id=sPinBtn>Set PIN</button></div>
    <div class=row id=sPinRow2 style="margin-top:8px;display:none"><button class="btn small" id=sPinChange>Change PIN</button><button class="btn small danger" id=sPinOff>Turn off</button></div>
    <div class=dim style="margin-top:8px">With a PIN on, signing out, changing the wallet or contacts, and resuming auto-pay ask for it. Pausing auto-pay never does. Five wrong tries lock it for a while; ten pause auto-pay.</div>
  </div>
  <h4>Account</h4>
  <div class=card>
    <div class=row><div><div class=dim>Your wallet (optional)</div><div id=aW>not connected</div></div><button class=btn id=aChg>Change</button></div>
    <div class=row style="margin-top:10px"><div><div class=dim>Contacts</div><div id=aC>0</div></div><button class=btn id=aAdd>Add</button></div>
    <div style="margin-top:12px"><button class="btn danger" id=aOut style="width:100%">Sign out</button></div>
  </div>
  <h4>About</h4>
  <div class=card><div class=dim style="line-height:1.6">Nib 0.1 (simulator)<br>Wi-Fi, Bluetooth and brightness are simulated here.<br>Pocket account <span id=abAcc></span> <button class="btn small" id=abCopy>copy</button></div></div>
  </div>
  <div id=wifiLayer class=pane>
    <div class=row style="margin-bottom:8px"><button class=btn id=wBack>&lsaquo; Back</button><b style="font-size:15px">Wi-Fi</b><span style="width:64px"></span></div>
    <div class=card><div class=row><span>Wi-Fi</span><div class=sw id=wSw><i></i></div></div></div>
    <h4>Connected</h4><div class=card id=wCur></div>
    <h4>Other networks</h4><div class=card id=wList></div>
    <div class=card id=wJoin style="display:none"><b>Join <span id=wJName></span></b>
      <input id=wPw type=password placeholder="Password" style="width:100%;box-sizing:border-box;margin-top:8px;padding:8px;border-radius:8px;border:1px solid #352c63;background:#120e26;color:#fff">
      <div class=dim style="margin-top:4px">Simulation: the password is nibwifi123</div>
      <div class=row style="margin-top:8px"><button class=btn id=wPhone>Type on phone (QR)</button><button class=btn id=wTry>Join</button></div><div id=wMsg class=dim style="margin-top:6px"></div></div>
    <div class=dim style="margin-top:10px">Simulated list. On the real device Nib scans nearby networks, and the password is typed on your phone.</div>
  </div>
  <div id=pinLayer class=pane>
    <div class=row style="margin-bottom:6px"><button class=btn id=pinCancel>Cancel</button><b id=pinTitle style="font-size:15px">Enter PIN</b><span style="width:64px"></span></div>
    <div id=pinDots style="display:flex;gap:10px;justify-content:center;margin:20px 0 6px"></div>
    <div id=pinMsg class=dim style="text-align:center;min-height:32px"></div>
    <div id=pinPad style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;max-width:240px;margin:6px auto 0"></div>
  </div>`;
  wrap.appendChild(shade);
  const $ = id => document.getElementById(id), sheet = $('sheet'), scrim = $('scrim');
  let isOpen = false, data = { acts: [], contacts: [], owner: null };

  function paint() {
    $('tWifi').classList.toggle('on', simWifi && !!wifiSsid); $('tWifiS').textContent = simWifi ? (wifiSsid ? wifiSsid + ', strong' : 'Not connected') : 'Off';
    $('tBt').classList.toggle('on', simBt); $('tBtS').textContent = simBt ? 'Phone setup ready' : 'Off';
    $('tMic').classList.toggle('on', !micMuted); $('tMicS').textContent = micMuted ? 'Muted' : 'On';
    $('tWake').classList.toggle('on', wake.checked && !micMuted); $('tWakeS').textContent = micMuted ? 'Mic is muted' : wake.checked ? 'Listening' : 'Off';
    $('tPay').classList.toggle('on', !frozen); $('tPay').classList.toggle('warn', frozen);
    $('tPayS').textContent = frozen ? 'Paused: I will not pay on my own' : 'On: I pay small bills myself';
    const p = sm && sm.pocket;
    $('pBal').textContent = p ? '$' + p.usd.toFixed(2) : '--';
    $('pLim').textContent = p ? 'Alone: up to $' + p.perTx + ' each, $' + p.autoDaily + ' a day. With your PIN: up to $' + p.pinPerTx + '. Holds at most $' + p.cap + '. Spent today $' + p.spent.toFixed(2) : '';
    const g = sm && sm.goal;
    $('gView').innerHTML = g ? '<b style="color:#fff">' + esc(g.name) + '</b> $' + g.saved.toFixed(0) + ' of $' + g.target + ' (' + g.pct + '%)' + (g.done ? ' - reached!' : '') + '<div style="height:6px;border-radius:3px;background:#352c63;margin-top:6px"><div style="height:6px;border-radius:3px;width:' + g.pct + '%;background:' + (g.done ? '#7dff6b' : '#ffd23f') + '"></div></div>' : 'No goal yet. Say "I want to save $120 for sneakers" or set one here.';
    $('gClear').style.display = g ? '' : 'none';
    $('abAcc').textContent = p && p.account ? p.account.slice(0, 6) + '...' + p.account.slice(-4) : '';
    $('aW').textContent = data.owner ? data.owner.slice(0, 8) + '...' + data.owner.slice(-6) : 'not connected';
    $('aC').textContent = data.contacts.length ? data.contacts.map(x => x.name).join(', ') : 'none yet';
    $('pList').innerHTML = data.acts.length ? data.acts.slice(0, 5).map(a => `<div class=act><span>-$${a.usd.toFixed(2)} to ${a.to}</span><span class=dim>${new Date(a.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span></div>`).join('') : '<span class=dim>No payments yet.</span>';
    document.querySelectorAll('#buddies .buddy').forEach((b, i) => b.classList.toggle('sel', i === ci));
  }
  async function refresh() {
    try { const [s, a, k, o] = await Promise.all([fetch('/summary').then(r => r.json()), fetch('/activity').then(r => r.json()), fetch('/contacts.json').then(r => r.json()), fetch('/owner').then(r => r.json())]); sm = s; smFail = false; frozen = !!s.pocket.frozen; data = { acts: a, contacts: k, owner: o.owner }; } catch (e) {}
    paint();
  }
  function open() { isOpen = true; sheet.classList.add('open'); scrim.classList.add('open'); paint(); refresh(); refreshPin(); }
  function close() { isOpen = false; sheet.classList.remove('open'); scrim.classList.remove('open'); }

  // open by tapping or pulling down the top status row; close by tapping the dimmed area / Close / Esc
  let down = null;
  c.addEventListener('pointerdown', e => { const r = c.getBoundingClientRect(); if (e.clientY - r.top - 8 < 36) down = e.clientY; });
  window.addEventListener('pointerup', e => { if (down === null) return; const dy = e.clientY - down; down = null; if (Math.abs(dy) < 6 || dy > 20) isOpen ? close() : open(); });
  scrim.onclick = close; $('shClose').onclick = close; window.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });

  // quick tiles
  $('tWifi').onclick = () => { simWifi = !simWifi; paint(); };
  $('tBt').onclick = () => { simBt = !simBt; paint(); };
  $('tMic').onclick = () => { micMuted = !micMuted; if (micMuted && wake.checked) wake.checked = false; paint(); };
  $('tWake').onclick = () => { if (micMuted) return; wake.checked = !wake.checked; paint(); };
  $('tPay').onclick = async () => { try { const j = await (await fetch('/freeze', { method: 'POST', body: JSON.stringify({ on: !frozen }) })).json(); if (j.frozen !== undefined) frozen = j.frozen; } catch (e) {} paint(); refresh(); };
  $('br').oninput = e => { c.style.filter = 'brightness(' + e.target.value / 100 + ')'; $('brV').textContent = e.target.value + '%'; };

  // pocket
  $('pTop').onclick = () => { topup.click(); close(); };
  $('pAct').onclick = () => { const l = $('pList'), show = l.style.display === 'none'; l.style.display = show ? 'block' : 'none'; $('pAct').textContent = show ? 'Hide' : 'Show'; };
  $('abCopy').onclick = () => { if (sm && sm.pocket && sm.pocket.account) { try { navigator.clipboard.writeText(sm.pocket.account); } catch (e) {} $('abCopy').textContent = 'copied'; setTimeout(() => $('abCopy').textContent = 'copy', 1500); } };

  // buddy picker: real sprites
  const bd = $('buddies');
  ids.forEach((id, i) => {
    const ch = CHARACTERS[id], d = document.createElement('div'); d.className = 'buddy';
    const cv = document.createElement('canvas'); cv.width = N; cv.height = N; const g = cv.getContext('2d');
    ch.FRAMES.idle.forEach((row, j) => [...row].forEach((k, x) => { if (k !== '.') { g.fillStyle = ch.PALETTE[k]; g.fillRect(x, j, 1, 1); } }));
    d.appendChild(cv); d.appendChild(document.createTextNode(ch.name.split(' ')[0])); d.onclick = () => { pick(i); paint(); }; bd.appendChild(d);
  });

  // account
  $('aChg').onclick = () => { chg.click(); close(); };
  $('aAdd').onclick = () => { addc.click(); close(); };
  let armed = false;
  $('aOut').onclick = async () => {
    if (!armed) { armed = true; $('aOut').textContent = 'Tap again: forget wallet and contacts (pocket money stays)'; setTimeout(() => { armed = false; $('aOut').textContent = 'Sign out'; }, 5000); return; }
    armed = false; $('aOut').textContent = 'Sign out';
    const r = await fetch('/signout', { method: 'POST' }); if (!r.ok) { say = 'I need the PIN to sign out.'; state = 'sad'; return; }
    say = 'Signed out. I forgot your wallet and contacts.'; state = 'happy'; showOwner(); refresh();
  };
  // ---- Wi-Fi detail (SIMULATED: the real device runs its own captive portal, see firmware/src/wifi_setup.h) ----
  const wl = $('wifiLayer'); let wSel = null, wTimer = null;
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  function wPaint() { $('wSw').classList.toggle('on', simWifi); }
  async function wRefresh() {
    try {
      const [st, sc] = await Promise.all([fetch('/wifi/state').then(r => r.json()), fetch('/wifi/scan').then(r => r.json())]); wifiSsid = st.ssid || null;
      $('wCur').innerHTML = wifiSsid ? '<div class=row><div><b>' + esc(wifiSsid) + '</b><div class=dim>Connected</div></div><button class="btn small" id=wForget>Forget</button></div>' : '<span class=dim>Not connected</span>';
      const f = $('wForget'); if (f) f.onclick = async () => { await fetch('/wifi/forget', { method: 'POST' }); await wRefresh(); paint(); };
      $('wList').innerHTML = sc.filter(n => !n.connected).map(n => '<div class=net data-s="' + esc(n.ssid) + '" data-k=' + (n.secure ? 1 : 0) + '><span>' + esc(n.ssid) + '</span><span class=dim>' + (n.secure ? 'secured ' : 'open ') + '\u2582\u2584\u2586\u2588'.slice(0, 0) + ['', '\u2582', '\u2582\u2584', '\u2582\u2584\u2586', '\u2582\u2584\u2586\u2588'][n.bars] + '</span></div>').join('') || '<span class=dim>No other networks found</span>';
      wl.querySelectorAll('.net').forEach(el => el.onclick = () => wPick(el.dataset.s, el.dataset.k === '1'));
    } catch (e) {}
    wPaint();
  }
  function wPick(ssid, secure) { wSel = ssid; $('wJName').textContent = ssid; $('wMsg').textContent = ''; $('wPw').value = ''; $('wJoin').style.display = 'block'; if (!secure) wJoinNow(true); else $('wPw').focus(); }
  async function wJoinNow(open) {
    $('wMsg').textContent = 'Connecting...';
    try {
      const r = await fetch('/wifi/join', { method: 'POST', body: JSON.stringify({ ssid: wSel, password: open ? '' : $('wPw').value }) }), j = await r.json(); if (!r.ok) throw new Error(j.error);
      $('wMsg').textContent = 'Connected to ' + wSel; $('wJoin').style.display = 'none'; await wRefresh(); paint(); say = 'Wi-Fi connected: ' + wSel; state = 'happy';
    } catch (e) { $('wMsg').textContent = e.message || 'Could not connect'; }
  }
  $('wTry').onclick = () => wJoinNow(false);
  $('wPhone').onclick = async () => {   // password typed on the phone: the pet shows a QR instead of the hero
    const r = await (await fetch('/wifi/session', { method: 'POST', body: JSON.stringify({ ssid: wSel }) })).json(), ssid = wSel;
    wl.classList.remove('open'); close(); say = 'Scan this with your phone camera and type the Wi-Fi password there.'; state = 'ask'; hint = 'password goes on your phone'; setQr(r.url, false);
    clearInterval(wTimer); const t0 = Date.now();
    wTimer = setInterval(async () => { try { const s = await (await fetch('/wifi/result?code=' + r.code)).json();
      if (s.status === 'ok' || s.status === 'failed' || s.status === 'expired' || Date.now() - t0 > 300000) { clearInterval(wTimer); setQr(null);
        if (s.status === 'ok') { wifiSsid = ssid; say = 'Wi-Fi connected: ' + ssid; state = 'happy'; paint(); } else { say = 'That did not work. Try again from Settings.'; state = 'sad'; } } } catch (e) {} }, 1500);
  };
  $('wOpen').onclick = e => { e.stopPropagation(); wl.classList.add('open'); wRefresh(); };
  $('wBack').onclick = () => wl.classList.remove('open');
  $('wSw').onclick = () => { simWifi = !simWifi; paint(); wPaint(); };
  // ---- PIN lock: keypad + a fetch wrapper that asks for the PIN whenever the server answers 401 "PIN required" ----
  const _fetch = window.fetch.bind(window); let unlockToken = null, pinSet = false, pinResolve = null, pinBuf = '';
  const pl = $('pinLayer'), dots = $('pinDots'), pad = $('pinPad');
  for (let i = 0; i < 6; i++) { const d = document.createElement('div'); d.className = 'dot'; dots.appendChild(d); }
  ['1', '2', '3', '4', '5', '6', '7', '8', '9', '\u232b', '0', 'OK'].forEach(k => { const b = document.createElement('button'); b.className = 'pk' + (k === 'OK' ? ' ok' : ''); b.textContent = k; b.dataset.k = k; pad.appendChild(b); });
  function pinPaint() { [...dots.children].forEach((d, i) => d.classList.toggle('f', i < pinBuf.length)); pad.querySelector('[data-k=OK]').disabled = pinBuf.length < 4; }
  function pinDone(v) { pl.classList.remove('open'); if (!isOpen) scrim.classList.remove('open'); const r = pinResolve; pinResolve = null; pinBuf = ''; if (r) r(v); }
  pad.onclick = e => { const k = e.target.dataset && e.target.dataset.k; if (!k) return; if (k === 'OK') { if (pinBuf.length >= 4) pinDone(pinBuf); } else if (k === '\u232b') pinBuf = pinBuf.slice(0, -1); else if (pinBuf.length < 6) pinBuf += k; pinPaint(); };
  window.addEventListener('keydown', e => { if (!pl.classList.contains('open')) return; if (/^\d$/.test(e.key) && pinBuf.length < 6) pinBuf += e.key; else if (e.key === 'Backspace') pinBuf = pinBuf.slice(0, -1); else if (e.key === 'Enter' && pinBuf.length >= 4) return pinDone(pinBuf); else if (e.key === 'Escape') return pinDone(null); pinPaint(); });
  $('pinCancel').onclick = () => pinDone(null);
  function askPin(title, msg) { $('pinTitle').textContent = title; $('pinMsg').textContent = msg || ''; pinBuf = ''; pinPaint(); scrim.classList.add('open'); pl.classList.add('open'); return new Promise(r => { pinResolve = r; }); }
  async function unlockFlow() {
    let msg = '';
    for (;;) {
      const pin = await askPin('Enter PIN', msg); if (pin === null) return false;
      const r = await _fetch('/pin/verify', { method: 'POST', body: JSON.stringify({ pin }) }), j = await r.json();
      if (r.ok && j.ok) { unlockToken = j.token; const t = j.token; setTimeout(() => { if (unlockToken === t) unlockToken = null; }, 118000); return true; }
      msg = (j.error || 'Wrong PIN') + (j.lockoutSec ? ' Wait ' + j.lockoutSec + 's.' : (j.attemptsLeft !== undefined && j.attemptsLeft < 5 ? ' (' + j.attemptsLeft + ' tries left)' : ''));
    }
  }
  window.fetch = async (url, opts = {}) => {
    const same = typeof url === 'string' && url.startsWith('/'), withTok = o => (unlockToken && same ? { ...o, headers: { ...(o.headers || {}), 'x-nib-unlock': unlockToken } } : o);
    let r = await _fetch(url, withTok(opts));
    if (same && r.status === 401) { let j = null; try { j = await r.clone().json(); } catch (e) {} if (j && j.pin && await unlockFlow()) r = await _fetch(url, withTok(opts)); }
    return r;
  };
  function paintPin() { $('sPinS').textContent = pinSet ? 'On' : 'Off'; $('sPinBtn').style.display = pinSet ? 'none' : ''; $('sPinRow2').style.display = pinSet ? 'flex' : 'none'; }
  async function refreshPin() { try { pinSet = (await _fetch('/pin/state').then(r => r.json())).set; } catch (e) {} paintPin(); }
  async function setPinFlow(change) {
    const a = await askPin(change ? 'New PIN (4-6 digits)' : 'Choose a PIN (4-6 digits)'); if (a === null) return;
    const b = await askPin('Repeat the PIN'); if (b === null) return;
    if (a !== b) { say = 'The two PINs were different. Try again.'; state = 'sad'; return; }
    const r = await fetch('/pin/set', { method: 'POST', body: JSON.stringify({ pin: a }) }), j = await r.json();   // when a PIN already exists the wrapper asks for it first
    if (!r.ok) { say = j.error || 'The PIN was not saved.'; state = 'sad'; return; }
    unlockToken = null; say = 'PIN is on. I will ask for it before sensitive changes.'; state = 'happy'; refreshPin();
  }
  $('sPinBtn').onclick = () => setPinFlow(false); $('sPinChange').onclick = () => setPinFlow(true);
  $('sPinOff').onclick = async () => {
    const p = await askPin('Enter PIN to turn it off'); if (p === null) return;
    const r = await _fetch('/pin/remove', { method: 'POST', body: JSON.stringify({ pin: p }) }), j = await r.json();
    say = r.ok ? 'PIN is off.' : (j.error || 'Wrong PIN.'); state = r.ok ? 'happy' : 'sad'; unlockToken = null; refreshPin();
  };
  // ---- savings goal card ----
  $('gSet').onclick = async () => { $('gMsg').textContent = ''; const r = await fetch('/goal', { method: 'POST', body: JSON.stringify({ name: $('gName').value, target: +$('gAmt').value }) }), j = await r.json(); $('gMsg').textContent = r.ok ? 'Goal set!' : (j.error || 'Could not set the goal'); if (r.ok) { $('gName').value = ''; $('gAmt').value = ''; } await refresh(); };
  $('gClear').onclick = async () => { await fetch('/goal/clear', { method: 'POST' }); $('gMsg').textContent = 'Goal removed.'; await refresh(); };
  // tap the pet itself to meet the next buddy (the picker in this shade shows them all)
  c.addEventListener('click', e => {
    const r = c.getBoundingClientRect(), y = e.clientY - r.top - 8;
    if (isOpen || y < 60 || y > 350 || (typeof qrUrl !== 'undefined' && qrUrl)) return;
    pick(ci + 1); idleFace = 'wink'; idleUntil = Date.now() + 1600; say = 'Hi, I am ' + CHARACTERS[ids[ci]].name.split(' ')[0] + '!'; paint();
  });
  // mid-size pocket payment: ask for the PIN on the pet's screen, then the normal cancel window starts
  window.pinApprove = async (id, title) => {
    let msg = '';
    for (;;) {
      const pin = await askPin(title, msg);
      if (pin === null) { await _fetch('/cancel/' + id, { method: 'POST' }); return false; }
      const r = await _fetch('/pocket/approve/' + id, { method: 'POST', body: JSON.stringify({ pin }) }), j = await r.json();
      if (r.ok && j.ok) return true;
      if (r.status === 409) return false;   // expired, paused or already handled
      msg = (j.error || 'Wrong PIN') + (j.lockoutSec ? ' Wait ' + j.lockoutSec + 's.' : (j.attemptsLeft !== undefined && j.attemptsLeft < 5 ? ' (' + j.attemptsLeft + ' tries left)' : ''));
    }
  };
  refreshPin();
  paint();
})();
