// Pocket-pet character set — 24x24 pixel sprites, generated procedurally:
// layers (back/body/front) -> auto outline -> light/shade -> shared face states.
// Browser: window.NIB.CHARACTERS ; node: module.exports.
(function (root) {
  const N = 24;
  const BASE = {
    o: "#0d0820", k: "#0d0820", w: "#ffffff", c: "#ff6f9f", m: "#0d0820", t: "#ff4d79",
    A: "#ffd23f", R: "#ff4d79", V: "#a58bff", O: "#ff9a2e", G: "#7dff6b", X: "#6b6785", Z: "#5ef2ff",
  };
  const E = (cx, cy, rx, ry, n = 2) => (x, y) => Math.pow(Math.abs(x - cx) / rx, n) + Math.pow(Math.abs(y - cy) / ry, n) <= 1;
  const R = (x0, y0, w, h) => (x, y) => x >= x0 && x < x0 + w && y >= y0 && y < y0 + h;
  const T = (ax, ay, by, hw) => (x, y) => y >= ay && y <= by && Math.abs(x - ax) <= ((y - ay + 0.5) / (by - ay + 1)) * hw; // triangle, apex up
  const AND = (a, b) => (x, y) => a(x, y) && b(x, y);
  const OR = (...f) => (x, y) => f.some(t => t(x, y));
  const body = E(11.5, 12.5, 10, 8, 4);
  const feet = (c = "s", y = 21) => [{ t: R(6, y, 4, 2), c }, { t: R(14, y, 4, 2), c }];

  const SPECS = {
    nib: { name: "Nib", pal: { b: "#45f5c8", s: "#1fb394", d: "#0e7566", h: "#f0fffb" },
      back: feet(), body, orb: [9, 0], stem: true },
    panda: { name: "Bamboo", pal: { b: "#f6f6fb", s: "#cfcce0", d: "#a29fbc", h: "#ffffff", e: "#2a2540" },
      back: [{ t: E(5, 6, 3, 3), c: "e" }, { t: E(18, 6, 3, 3), c: "e" }, { t: E(2, 15, 2.6, 3.6), c: "e" }, { t: E(21, 15, 2.6, 3.6), c: "e" }, ...feet("e")],
      body, front: [{ t: E(6, 10.5, 3.5, 3.6), c: "e" }, { t: E(17, 10.5, 3.5, 3.6), c: "e" }, { t: R(11, 13, 2, 1), c: "e" }],
      eye: { fill: "w", pupil: true, line: "w" } },
    hedgehog: { name: "Spike", pal: { b: "#f7d6a8", s: "#dcae78", d: "#b88653", h: "#fff2dc", e: "#5c3f33", f: "#8a6050" },
      back: [{ t: (x, y) => y <= 17 && Math.pow(Math.abs(x - 11.5) / 11, 2) + Math.pow(Math.abs(y - 12) / 10, 2) <= (x % 3 === 1 ? 1.16 : 0.92), c: (x, y) => ((x + y) % 4 === 0 ? "f" : "e") }, ...feet("e")],
      body: E(11.5, 13.5, 9.5, 7.2, 4), front: [{ t: (x, y) => E(11.5, 13.5, 9.5, 7.2, 4)(x, y) && y <= 7 + (x % 2), c: (x, y) => ((x + y) % 3 === 0 ? "f" : "e") }, { t: R(11, 13, 2, 1), c: "k" }] },
    dragon: { name: "Ember", pal: { b: "#7ee05a", s: "#4fb43d", d: "#2f7f2a", h: "#e2ffd0", e: "#a58bff", f: "#7a5cff", g: "#ffe08a", n: "#fff4cf", p: "#ff9a2e" },
      back: [{ t: T(6, 0, 6, 2.6), c: "n" }, { t: T(17, 0, 6, 2.6), c: "n" }, { t: E(2, 13, 2.4, 4), c: "e" }, { t: E(21.3, 13, 2.4, 4), c: "e" }, { t: E(21.2, 19.5, 2, 1.7), c: "s" }, ...feet()],
      body, front: [{ t: E(11.5, 17, 5, 3.4), c: (x, y) => (y % 2 === 0 ? "g" : "n") }], after: g => { g[13][10] = "d"; g[13][13] = "d"; g[19][22] = "p"; } },
    cat: { name: "Ginger", pal: { b: "#ffa94d", s: "#e07f23", d: "#a85a14", h: "#ffe3b8", e: "#ffe6c4", f: "#7a3d0f", n: "#ff6f9f" },
      back: [{ t: T(6, 1, 7, 3.4), c: "b" }, { t: T(17, 1, 7, 3.4), c: "b" }, { t: E(21.3, 17, 1.6, 4.5), c: "s" }, ...feet()],
      body, front: [{ t: T(6, 3, 7, 1.6), c: "n" }, { t: T(17, 3, 7, 1.6), c: "n" }, { t: R(8, 6, 1, 2), c: "f" }, { t: R(11, 6, 2, 3), c: "f" }, { t: R(15, 6, 1, 2), c: "f" }, { t: E(11.5, 15.5, 4.5, 2.6), c: "e" }, { t: R(11, 13, 2, 1), c: "n" }] },
    fox: { name: "Foxy", pal: { b: "#ff7a2e", s: "#d9551a", d: "#a33a0e", h: "#ffd3ad", e: "#2b1b17", g: "#fff3e6" },
      back: [{ t: T(5, 0, 7, 3.6), c: "b" }, { t: T(18, 0, 7, 3.6), c: "b" }, { t: T(5, 0, 3, 1.6), c: "e" }, { t: T(18, 0, 3, 1.6), c: "e" }, { t: E(21.1, 17, 2.1, 4.6), c: "b" }, { t: E(21.3, 20.6, 1.9, 2), c: "g" }, ...feet()],
      body, front: [{ t: OR(E(6.5, 16.5, 5, 3.4), E(17.5, 16.5, 5, 3.4), E(11.5, 17.5, 4, 3)), c: "g" }, { t: R(11, 13, 2, 1), c: "e" }] },
    bunny: { name: "Fluff", pal: { b: "#fff0fa", s: "#e5c6e8", d: "#c29bca", h: "#ffffff", e: "#ffb3d1" },
      back: [{ t: E(7, 6, 2.4, 5.2), c: "b" }, { t: E(16, 6, 2.4, 5.2), c: "b" }, { t: E(7, 6, 1.1, 4), c: "e" }, { t: E(16, 6, 1.1, 4), c: "e" }, ...feet()],
      body: E(11.5, 14, 10, 7.5, 4), front: [{ t: R(11, 13, 2, 1), c: "e" }] },
    ghost: { name: "Boo", pal: { b: "#e8eeff", s: "#bcc7f2", d: "#8e9bd6", h: "#ffffff" },
      back: [], body: (x, y) => (y <= 14.5 ? E(11.5, 12.5, 10, 8, 4)(x, y) : Math.abs(x - 11.5) <= 10 && y <= 19 + (Math.floor(x / 3) % 2 === 0 ? 2 : 0)) },
    robot: { name: "Beep", pal: { b: "#aab8d6", s: "#7f8fb5", d: "#566794", h: "#eef3ff", e: "#12122e" },
      back: [{ t: R(0, 11, 2, 4), c: "d" }, { t: R(22, 11, 2, 4), c: "d" }, ...feet("d")],
      body: E(11.5, 13.5, 10, 7.8, 8), front: [{ t: R(3, 8, 18, 9), c: "e" }], orb: [9, 0], stem: true,
      eye: { fill: "Z", glint: "w", line: "Z" }, mouthC: "Z", noCheeks: true },
    penguin: { name: "Pingo", pal: { b: "#2d3a6b", s: "#1f2a52", d: "#141c3d", h: "#7a91e0", g: "#ffffff", f: "#dde4ff", n: "#ffa51f", p: "#e08410" },
      back: [{ t: E(1.5, 14.5, 2, 4.5), c: "s" }, { t: E(22, 14.5, 2, 4.5), c: "s" }, { t: R(5, 21, 5, 2), c: "n" }, { t: R(14, 21, 5, 2), c: "n" }],
      body: E(11.5, 12.8, 10, 8.4, 3), front: [{ t: OR(E(6.7, 10.5, 3.4, 3.6), E(16.3, 10.5, 3.4, 3.6)), c: "g" }, { t: E(11.5, 17, 6.8, 4.6), c: (x, y) => (x + y > 31 ? "f" : "g") }],
      beak: true, noCheeks: true },
  };

  const HL = [[4, 7], [5, 6], [6, 6], [4, 8], [7, 5], [8, 5], [3, 9]];
  const ORB = { idle: "A", blink: "A", listening: "R", thinking: "V", happy: "G", ask: "O", sad: "X", sleepy: "X", surprised: "O", love: "R", wink: "A", laugh: "G", confused: "V", lookl: "A", lookr: "A", yawn: "X" };

  function build(spec, state) {
    const g = Array.from({ length: N }, () => Array(N).fill("."));
    const put = (layers, shaded) => layers.forEach(l => { for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) if (l.t(x, y)) g[y][x] = typeof l.c === "function" ? l.c(x, y) : l.c; });
    put(spec.back || []);
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) if (spec.body(x, y)) {
      const p = (x - 11.5) * 0.6 + (y - 12.5) * 0.8;
      g[y][x] = p > 8.2 ? "d" : p > 5.6 ? "s" : "b";
    }
    put(spec.front || []);
    const solid = (x, y) => x >= 0 && y >= 0 && x < N && y < N && g[y][x] !== "." && g[y][x] !== "o";
    const og = g.map(r => r.slice());
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) if (og[y][x] === "." && [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([a, b]) => solid(x + a, y + b))) g[y][x] = "o";
    for (const [x, y] of HL) if (g[y][x] === "b") g[y][x] = "h";
    const P = (list, c) => list.forEach(([x, y]) => { if (x >= 0 && y >= 0 && x < N && y < N) g[y][x] = c; });
    const rect = (x0, y0, w, h) => { const r = []; for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) r.push([x, y]); return r; };
    if (spec.orb) {
      const [ox, oy] = spec.orb;
      if (spec.stem) P([[ox + 2, oy + 3], [ox + 3, oy + 3], [ox + 2, oy + 4], [ox + 3, oy + 4]], "o");
      P([[1, 0], [2, 0], [3, 0], [4, 0], [0, 1], [5, 1], [0, 2], [5, 2], [1, 3], [4, 3]].map(([a, b]) => [ox + a, oy + b]), "o");
      P([[1, 1], [2, 1], [3, 1], [4, 1], [1, 2], [2, 2], [3, 2], [4, 2], [2, 3], [3, 3]].map(([a, b]) => [ox + a, oy + b]), ORB[state]);
      g[oy + 1][ox + 1] = "w";
    }
    // ----- face -----
    const eye = spec.eye || {}, fill = eye.fill || "k", glint = eye.glint || "w", line = eye.line || "k", mc = spec.mouthC || "m";
    const eyes = (dy = 0, h = 4, dx = 0) => { for (const x0 of [5 + dx, 16 + dx]) { P(rect(x0, 9 + dy, 3, h), fill); if (eye.pupil) P(rect(x0 + 1, 10 + dy, 2, h - 1), "k"); else g[9 + dy][x0] = glint; } };
    const cheeks = () => { if (!spec.noCheeks) P([...rect(3, 13, 3, 2), ...rect(18, 13, 3, 2)], "c"); };
    const mouth = pts => { if (!spec.beak) P(pts, mc); };
    if (spec.beak) { P(rect(10, 13, 4, 2), "n"); P(rect(11, 15, 2, 1), "p"); }
    const worry = [[9, 16], [10, 15], [11, 14], [12, 14], [13, 15], [14, 16]];
    const smile = [[9, 14], [10, 15], [11, 15], [12, 15], [13, 15], [14, 14]];
    if (state === "idle") { eyes(); cheeks(); mouth(smile); }
    if (state === "blink") { P([[5, 11], [6, 11], [7, 11], [16, 11], [17, 11], [18, 11]], line); cheeks(); mouth(smile); }
    if (state === "listening") { eyes(-1, 5); cheeks(); mouth(rect(11, 14, 2, 3)); }
    if (state === "thinking") { eyes(-1); cheeks(); mouth([[10, 15], [11, 15], [12, 15], [13, 15]]); }
    if (state === "happy") { P([[5, 11], [6, 10], [7, 11], [16, 11], [17, 10], [18, 11]], line); cheeks(); mouth([...rect(9, 14, 6, 1), ...rect(10, 15, 4, 1)]); if (!spec.beak) P([[11, 15], [12, 15], [11, 16], [12, 16]], "t"); }
    if (state === "ask") { eyes(); cheeks(); mouth(worry); }
    if (state === "sad") { P([[5, 10], [6, 11], [7, 11], [16, 11], [17, 11], [18, 10]], line); mouth(worry); P([[20, 12], [20, 13]], "w"); }
    // ---- extra feelings and idle faces ----
    const heart = x0 => P([[x0 + 1, 9], [x0 + 3, 9], [x0, 10], [x0 + 1, 10], [x0 + 2, 10], [x0 + 3, 10], [x0 + 4, 10], [x0 + 1, 11], [x0 + 2, 11], [x0 + 3, 11], [x0 + 2, 12]], "t");
    const shut = () => P([[5, 11], [6, 11], [7, 11], [16, 11], [17, 11], [18, 11]], line);
    const oneEye = x0 => { P(rect(x0, 9, 3, 4), fill); if (eye.pupil) P(rect(x0 + 1, 10, 2, 3), "k"); else g[9][x0] = glint; };
    if (state === "sleepy") { shut(); cheeks(); mouth([[11, 15], [12, 15]]); }
    if (state === "surprised") { eyes(-1, 5); P([[5, 7], [6, 7], [7, 7], [16, 7], [17, 7], [18, 7]], line); cheeks(); mouth(rect(11, 14, 2, 2)); }
    if (state === "love") { heart(4); heart(15); cheeks(); mouth(smile); }
    if (state === "wink") { oneEye(5); P([[16, 11], [17, 11], [18, 10]], line); cheeks(); mouth(smile); }
    if (state === "laugh") { P([[5, 11], [6, 10], [7, 11], [16, 11], [17, 10], [18, 11]], line); cheeks(); mouth([...rect(8, 14, 8, 1), ...rect(9, 15, 6, 1), ...rect(10, 16, 4, 1)]); if (!spec.beak) P([[11, 16], [12, 16]], "t"); }
    if (state === "confused") { oneEye(5); P(rect(16, 10, 3, 3), fill); if (!eye.pupil) g[10][16] = glint; cheeks(); mouth([[9, 15], [10, 14], [11, 15], [12, 14], [13, 15], [14, 14]]); }
    if (state === "lookl") { eyes(0, 4, -1); cheeks(); mouth(smile); }
    if (state === "lookr") { eyes(0, 4, 1); cheeks(); mouth(smile); }
    if (state === "yawn") { shut(); cheeks(); mouth(rect(10, 13, 4, 4)); }
    if (spec.after) spec.after(g);
    return g.map(r => r.join(""));
  }

  const STATES = ["idle", "blink", "listening", "thinking", "happy", "ask", "sad", "sleepy", "surprised", "love", "wink", "laugh", "confused", "lookl", "lookr", "yawn"];
  const CHARACTERS = {};
  for (const [id, spec] of Object.entries(SPECS)) {
    CHARACTERS[id] = { id, name: spec.name, PALETTE: { ...BASE, ...spec.pal }, FRAMES: Object.fromEntries(STATES.map(s => [s, build(spec, s)])) };
  }
  const api = { N, STATES, CHARACTERS, PALETTE: CHARACTERS.nib.PALETTE, FRAMES: CHARACTERS.nib.FRAMES };
  if (typeof module !== "undefined") module.exports = api; else root.NIB = api;
})(typeof window !== "undefined" ? window : globalThis);
