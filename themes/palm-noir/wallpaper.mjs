// Palm Noir's wallpaper: the rail's little scene grown to fill the space
// behind the threads. It's drawn in layers so it fits any pane: the sky is a
// CSS gradient that stretches, the horizon (sun, sea, towers) sits along the
// bottom, a palm cluster stands at each side, and in dark mode a strip of
// stars runs along the top. Each mode has its own colours: a golden-hour
// dusk in light mode, a neon night in dark. The "live" versions add the
// movement (light on the water, blinking windows, twinkling stars), drawn in
// discrete steps so the page only repaints when something changes.

const r = (n) => Math.round(n * 10) / 10;
// Palms are big enough that whole pixels are plenty, which keeps them small.
const ri = (n) => Math.round(n);

export const MODES = {
  light: {
    sky: "linear-gradient(180deg, #efe4f6 0%, #f6d6e6 42%, #ffd2c4 70%, #ffd9ae 100%)",
    sunTop: "#fff6c2",
    sunMid: "#ffcf6e",
    sunBottom: "#ff8a5c",
    sunGlow: "#ffb38a",
    seaTop: "#a9cfdc",
    seaBottom: "#7da7c4",
    horizonLine: "#ffffff",
    glints: ["#ffffff", "#fff0c9", "#ffd1e3"],
    swell: "#ffffff",
    towers: "#b79cc4",
    windows: "#fff3c4",
    palms: "#3b2350",
    palmsFar: "#6f4f86",
    stars: null,
  },
  dark: {
    sky: "linear-gradient(180deg, #1c1042 0%, #2a1452 30%, #4f1a6c 58%, #a3246f 80%, #f0466e 92%, #ff7a4a 100%)",
    sunTop: "#fff3a6",
    sunMid: "#ffd166",
    sunBottom: "#ff7a45",
    sunGlow: "#ff7a7a",
    seaTop: "#3a1561",
    seaBottom: "#13082a",
    horizonLine: "#ff8ab8",
    glints: ["#ff5fa2", "#ff8a3d", "#ffb357"],
    swell: "#2de2e6",
    towers: "#24103f",
    windows: "#ffd166",
    palms: "#08030f",
    palmsFar: "#1d0c34",
    stars: "#ffffff",
  },
};

// A feathery palm frond: a curved rib from the crown to the tip, with thin
// leaflets hanging off both sides, longest near the middle.
function frond(cx, cy, len, angle, droop, leaf) {
  const a = (angle * Math.PI) / 180;
  const tip = [cx + len * Math.cos(a), cy + len * Math.sin(a) + droop];
  const ctl = [cx + len * 0.55 * Math.cos(a), cy + len * 0.55 * Math.sin(a) - droop * 0.35];
  const at = (t) => [
    (1 - t) ** 2 * cx + 2 * (1 - t) * t * ctl[0] + t * t * tip[0],
    (1 - t) ** 2 * cy + 2 * (1 - t) * t * ctl[1] + t * t * tip[1],
  ];
  const tangent = (t) => {
    const dx = 2 * (1 - t) * (ctl[0] - cx) + 2 * t * (tip[0] - ctl[0]);
    const dy = 2 * (1 - t) * (ctl[1] - cy) + 2 * t * (tip[1] - ctl[1]);
    const m = Math.hypot(dx, dy) || 1;
    return [dx / m, dy / m];
  };
  let d = `M${ri(cx)} ${ri(cy)}Q${ri(ctl[0])} ${ri(ctl[1])} ${ri(tip[0])} ${ri(tip[1])}`;
  const parts = [];
  for (let t = 0.1; t < 0.97; t += 0.055) {
    const [px, py] = at(t);
    const [tx, ty] = tangent(t);
    const size = leaf * Math.sin(Math.PI * Math.min(1, t * 1.15)) * (1 - t * 0.35);
    for (const side of [1, -1]) {
      const nx = -ty * side;
      const ny = tx * side;
      // Leaflets sweep towards the tip and hang down a little.
      const ex = px + nx * size + tx * size * 0.55;
      const ey = py + ny * size + ty * size * 0.55 + size * 0.45;
      const bx = px + tx * size * 0.16;
      const by = py + ty * size * 0.16;
      parts.push(`M${ri(px)} ${ri(py)}L${ri(ex)} ${ri(ey)}L${ri(bx)} ${ri(by)}Z`);
    }
  }
  return { rib: d, leaves: parts.join("") };
}

// One palm: a tapering, gently curved trunk with a few rings, a crown of
// fronds and a cluster of coconuts.
function palm({ base, crown, bend, width, fronds, fill }) {
  const [bx, by] = base;
  const [cx, cy] = crown;
  const mx = (bx + cx) / 2 + bend;
  const my = (by + cy) / 2;
  const w0 = width;
  const w1 = width * 0.45;
  const trunk =
    `M${ri(bx - w0)} ${ri(by)}Q${ri(mx - (w0 + w1) / 2)} ${ri(my)} ${ri(cx - w1)} ${ri(cy)}` +
    `L${ri(cx + w1)} ${ri(cy)}Q${ri(mx + (w0 + w1) / 2)} ${ri(my)} ${ri(bx + w0)} ${ri(by)}Z`;
  let ribs = "";
  let leaves = "";
  for (const [len, ang, droop, leaf] of fronds) {
    const f = frond(cx, cy, len, ang, droop, leaf);
    ribs += f.rib;
    leaves += f.leaves;
  }
  const nuts = [
    [cx - w1 * 1.3, cy + w1 * 1.6],
    [cx + w1 * 1.2, cy + w1 * 1.8],
    [cx, cy + w1 * 2.4],
  ]
    .map(([x, y]) => `<circle cx="${ri(x)}" cy="${ri(y)}" r="${ri(w1 * 1.15)}"/>`)
    .join("");
  return (
    `<g fill="${fill}"><path d="${trunk}"/>${nuts}<path d="${leaves}"/></g>` +
    `<path d="${ribs}" fill="none" stroke="${fill}" stroke-width="${r(width * 0.42)}" stroke-linecap="round"/>`
  );
}

// The fronds of a full crown: length, angle (0 is right, 90 is down), droop,
// leaflet size. Scaled by `s`.
const crown = (s) =>
  [
    [210, 192, 70, 34],
    [190, 222, 25, 32],
    [150, 258, -5, 26],
    [140, 290, -10, 24],
    [165, 318, 5, 28],
    [205, 345, 45, 33],
    [215, 12, 95, 34],
    [170, 160, 95, 28],
  ].map(([l, a, d, f]) => [l * s, a, d * s, f * s]);

// The left cluster: a tall palm leaning in from the edge and a shorter one
// behind it. Drawn on a 600 by 1000 canvas, bottom-left anchored.
export function palmsLeft(mode) {
  const c = MODES[mode];
  return svg(600, 1000, [
    palm({ base: [230, 1000], crown: [330, 470], bend: -40, width: 13, fronds: crown(0.75), fill: c.palmsFar }),
    palm({ base: [70, 1000], crown: [150, 190], bend: 60, width: 20, fronds: crown(1.05), fill: c.palms }),
  ]);
}

// The right cluster: one palm leaning out over the water, a smaller one
// beside it. Drawn on a 520 by 1000 canvas, bottom-right anchored.
export function palmsRight(mode) {
  const c = MODES[mode];
  return svg(520, 1000, [
    palm({ base: [380, 1000], crown: [300, 560], bend: 30, width: 12, fronds: crown(0.7), fill: c.palmsFar }),
    palm({ base: [470, 1000], crown: [350, 330], bend: -70, width: 17, fronds: crown(0.9), fill: c.palms }),
  ]);
}

// The horizon: the sun half set behind the sea, its glow, towers along the
// shore at both sides, and light on the water. 1600 by 440, bottom anchored.
export function horizon(mode, live) {
  const c = MODES[mode];
  const H = 440;
  const sea = 300;
  const sunX = 800;
  const sunR = 150;
  const step = (values, dur, begin) =>
    live ? `<animate attributeName="opacity" values="${values}" dur="${dur}s" begin="${begin}s" calcMode="discrete" repeatCount="indefinite"/>` : "";

  const stripes = [];
  for (let y = sea - 120; y < sea; y += 22) {
    const h = 3 + ((y - (sea - 120)) / 120) * 9;
    stripes.push(`<rect x="0" y="${r(y)}" width="1600" height="${r(h)}"/>`);
  }

  // Towers: left and right of the sun, as a skyline on the shore. Each
  // tower's windows sit on a grid inside its own outline, and a steady
  // scatter of them is lit, so a light can never land in the sky or in a gap.
  const lit = (i, c, row, salt) => {
    const v = Math.sin(i * 12.9898 + c * 78.233 + row * 37.719 + salt) * 43758.5453;
    return v - Math.floor(v);
  };
  const towerSet = (x0, widths, heights, salt) => {
    let x = x0;
    let rects = "";
    const wins = [];
    widths.forEach((w, i) => {
      const h = heights[i];
      const top = sea - h;
      rects += `<rect x="${x}" y="${top}" width="${w}" height="${h}"/>`;
      const cols = Math.max(1, Math.floor((w - 6) / 10));
      const rows = Math.max(1, Math.floor((h - 14) / 16));
      const inset = (w - cols * 10 + 5) / 2;
      for (let c = 0; c < cols; c++) {
        for (let row = 0; row < rows; row++) {
          const v = lit(i, c, row, salt);
          if (v < 0.24) wins.push([r(x + inset + c * 10), top + 8 + row * 16, v]);
        }
      }
      x += w + 3;
    });
    return { rects, wins };
  };
  const left = towerSet(70, [34, 22, 46, 28, 38, 18, 30], [70, 44, 118, 86, 150, 60, 96], 1.7);
  const right = towerSet(1180, [26, 44, 30, 52, 24, 36, 40], [56, 132, 88, 176, 64, 110, 78], 4.3);
  const windows = [...left.wins, ...right.wins].map(([x, y, v]) =>
    `<rect x="${x}" y="${y}" width="5" height="6" fill="${c.windows}">` +
      (v < 0.08 ? step(v < 0.04 ? "1;1;1;0.15;1" : "1;0.2;1;1;1", r(3 + v * 40), r(v * 30)) : "") +
      `</rect>`,
  );

  // Light on the water: bands under the sun, narrowing towards the viewer.
  const glints = [];
  for (let i = 0; i < 9; i++) {
    const y = sea + 10 + i * 14;
    const half = 190 - i * 17 + (i % 2) * 14;
    const col = c.glints[i % c.glints.length];
    glints.push(
      `<rect x="${sunX - half}" y="${y}" width="${half * 2}" height="${r(4 - i * 0.25)}" rx="2" fill="${col}" opacity="0.9">` +
        step(i % 2 ? "0.9;0.35;0.9;0.6" : "0.5;0.9;0.4;0.9", r(1.2 + (i % 3) * 0.3), r(i * 0.13)) +
        `</rect>`,
    );
  }
  const swell = [
    [120, 380, 260], [430, 410, 220], [1040, 372, 240], [1300, 404, 200], [260, 428, 160], [1150, 430, 180],
  ]
    .map(([x, y, w], i) => `<rect x="${x}" y="${y}" width="${w}" height="2" rx="1" fill="${c.swell}" opacity="0.45">${step("0.45;0.15;0.45", r(2.2 + i * 0.4), r(i * 0.5))}</rect>`)
    .join("");

  return svg(1600, H, [
    `<defs>
<linearGradient id="sun" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${c.sunTop}"/><stop offset="0.5" stop-color="${c.sunMid}"/><stop offset="1" stop-color="${c.sunBottom}"/></linearGradient>
<linearGradient id="sea" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${c.seaTop}"/><stop offset="1" stop-color="${c.seaBottom}"/></linearGradient>
<radialGradient id="glow" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="${c.sunGlow}" stop-opacity="0.55"/><stop offset="1" stop-color="${c.sunGlow}" stop-opacity="0"/></radialGradient>
<mask id="cut"><rect width="1600" height="${H}" fill="#fff"/><g fill="#000">${stripes.join("")}</g></mask>
</defs>`,
    `<ellipse cx="${sunX}" cy="${sea - 40}" rx="420" ry="230" fill="url(#glow)"/>`,
    `<circle cx="${sunX}" cy="${sea - 20}" r="${sunR}" fill="url(#sun)" mask="url(#cut)"/>`,
    `<g fill="${c.towers}">${left.rects}${right.rects}</g>${windows.join("")}`,
    `<rect x="0" y="${sea}" width="1600" height="${H - sea}" fill="url(#sea)"/>`,
    `<rect x="0" y="${sea}" width="1600" height="2" fill="${c.horizonLine}" opacity="0.7"/>`,
    glints.join(""),
    swell,
  ]);
}

// Stars for the dark sky, as a strip that repeats across the top.
export function stars(live) {
  const pts = [
    [30, 40, 1.4], [95, 120, 1], [160, 30, 1.8], [230, 90, 1.1], [300, 50, 1.3], [360, 150, 0.9],
    [420, 20, 1.2], [480, 110, 1.6], [540, 60, 1], [600, 170, 1.2], [70, 200, 1], [250, 210, 1.3],
    [410, 230, 0.9], [560, 250, 1.1],
  ];
  return svg(640, 280, [
    pts
      .map(
        ([x, y, s], i) =>
          `<circle cx="${x}" cy="${y}" r="${s}" fill="${MODES.dark.stars}" opacity="0.8">` +
          (live && i % 3 === 0
            ? `<animate attributeName="opacity" values="0.8;0.2;0.8;0.8" dur="${r(2.5 + (i % 4) * 0.7)}s" begin="${r(i * 0.3)}s" calcMode="discrete" repeatCount="indefinite"/>`
            : "") +
          `</circle>`,
      )
      .join(""),
  ]);
}

function svg(w, h, parts) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" preserveAspectRatio="xMidYMax meet">${parts.join("")}</svg>`;
}

export function toUrl(svgText) {
  const encoded = svgText.replace(/\n/g, "").replace(/[#%<>"{}|\\^`]/g, (ch) => encodeURIComponent(ch));
  return `url("data:image/svg+xml,${encoded}")`;
}
