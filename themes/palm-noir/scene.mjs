// The little scene at the foot of the rail: a striped sun going down over the
// sea, a few towers on the shore and two palms in front, all drawn here as
// SVG so the theme needs no image files. scene(false) is still; scene(true)
// is the same picture with the sun's stripes drifting down, the light on the
// water shimmering and a few windows blinking, which the skin shows only
// while agents are working.
//
// The picture is 44 by 96 units and is drawn at that size in pixels.

const NIGHT = "#13082a";
const NIGHT_FAR = "#24103f";

const r = (n) => Math.round(n * 100) / 100;

// A palm frond: a curved leaf from the crown out to its tip. `angle` is in
// degrees (0 points right, 90 points down), `droop` pulls the middle down.
function frond([cx, cy], len, angle, droop, width) {
  const a = (angle * Math.PI) / 180;
  const tip = [cx + len * Math.cos(a), cy + len * Math.sin(a) + droop * 0.6];
  const mid = [(cx + tip[0]) / 2, (cy + tip[1]) / 2 - droop * 0.15];
  const px = -Math.sin(a);
  const py = Math.cos(a);
  const c1 = [mid[0] - px * width, mid[1] - py * width - droop * 0.5];
  const c2 = [mid[0] + px * width * 0.35, mid[1] + py * width * 0.35 - droop * 0.2];
  return `M${r(cx)} ${r(cy)}Q${r(c1[0])} ${r(c1[1])} ${r(tip[0])} ${r(tip[1])}Q${r(c2[0])} ${r(c2[1])} ${r(cx)} ${r(cy)}Z`;
}

// A trunk: a tapering curve from the base to the crown.
function trunk([bx, by], [cx, cy], bend, base, top) {
  const mx = (bx + cx) / 2 + bend;
  const my = (by + cy) / 2;
  return (
    `M${r(bx - base)} ${r(by)}Q${r(mx - (base + top) / 2)} ${r(my)} ${r(cx - top)} ${r(cy)}` +
    `L${r(cx + top)} ${r(cy)}Q${r(mx + (base + top) / 2)} ${r(my)} ${r(bx + base)} ${r(by)}Z`
  );
}

function palm(base, crown, bend, size, fill) {
  const s = size;
  const leaves = [
    [13 * s, 200, 5 * s, 2.4 * s],
    [12 * s, 235, 2 * s, 2.2 * s],
    [10 * s, 290, 1 * s, 2 * s],
    [12 * s, 320, 2 * s, 2.2 * s],
    [14 * s, 350, 6 * s, 2.4 * s],
    [11 * s, 25, 6 * s, 2 * s],
    [10 * s, 155, 6 * s, 2 * s],
  ];
  const path = [trunk(base, crown, bend, 1.5 * s, 0.7 * s), ...leaves.map(([l, a, d, w]) => frond(crown, l, a, d, w))].join("");
  return `<path fill="${fill}" d="${path}"/>`;
}

export function scene(live) {
  const anim = (attrs) => (live ? `<animate ${attrs} repeatCount="indefinite"/>` : "");

  // Stripes across the lower half of the sun, cut out with a mask. Live, the
  // band of stripes slides down one stripe's height and repeats.
  const stripes = [];
  for (let y = 44.5; y < 70; y += 3.5) stripes.push(`<rect x="0" y="${r(y)}" width="44" height="1.3"/>`);
  const drift = live
    ? `<animateTransform attributeName="transform" type="translate" from="0 0" to="0 3.5" dur="1.1s" repeatCount="indefinite"/>`
    : "";

  // Light on the water under the sun.
  const glints = [
    [64.6, 9, 35, "#ff5fa2", 1.1, "0s"],
    [67.6, 12, 32, "#ff8a3d", 1, "0.3s"],
    [70.6, 14.5, 29.5, "#ffb357", 0.9, "0.6s"],
    [73.6, 17, 27, "#ff5fa2", 0.8, "0.15s"],
    [76.6, 19, 25, "#ff8a3d", 0.7, "0.45s"],
  ]
    .map(
      ([y, x1, x2, c, h, b]) =>
        `<rect x="${x1}" y="${y}" width="${r(x2 - x1)}" height="${h}" rx="0.5" fill="${c}">` +
        anim(`attributeName="opacity" values="1;0.35;1" dur="1.3s" begin="${b}"`) +
        `</rect>`,
    )
    .join("");

  // A few teal lines further out.
  const swell = [
    [82, 3, 11],
    [87, 27, 39],
    [91.5, 8, 18],
  ]
    .map(([y, x1, x2]) => `<rect x="${x1}" y="${y}" width="${x2 - x1}" height="0.8" rx="0.4" fill="#2de2e6" opacity="0.55"/>`)
    .join("");

  // Towers on the shore to the right, with a few lit windows.
  const towers = [
    [26.5, 3, 6],
    [29.5, 3.5, 11],
    [33, 2.5, 8],
    [35.5, 4, 15],
    [39.5, 2.5, 9],
    [42, 2, 5],
  ]
    .map(([x, w, h]) => `<rect x="${x}" y="${62 - h}" width="${w}" height="${h}"/>`)
    .join("");
  const windows = [
    [30.5, 54, "0s"],
    [36.5, 50, "0.7s"],
    [37.5, 56, "1.6s"],
    [33.5, 57, "1.1s"],
  ]
    .map(
      ([x, y, b]) =>
        `<rect x="${x}" y="${y}" width="0.9" height="0.9" fill="#ffd166">` +
        anim(`attributeName="opacity" values="1;1;0.15;1" dur="2.4s" begin="${b}"`) +
        `</rect>`,
    )
    .join("");

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 44 96" width="44" height="96">
<defs>
<linearGradient id="sun" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff3a6"/><stop offset="0.45" stop-color="#ffd166"/><stop offset="1" stop-color="#ff7a45"/></linearGradient>
<linearGradient id="sea" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3a1561"/><stop offset="1" stop-color="${NIGHT}"/></linearGradient>
<radialGradient id="glow" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="#ffb357" stop-opacity="0.55"/><stop offset="1" stop-color="#ff5fa2" stop-opacity="0"/></radialGradient>
<clipPath id="lower"><rect x="0" y="44" width="44" height="22"/></clipPath>
<mask id="cut"><rect width="44" height="96" fill="#fff"/><g clip-path="url(#lower)"><g fill="#000">${drift}${stripes.join("")}</g></g></mask>
</defs>
<circle cx="21" cy="47" r="22" fill="url(#glow)"/>
<circle cx="21" cy="47" r="15" fill="url(#sun)" mask="url(#cut)"/>
<g fill="${NIGHT_FAR}">${towers}</g>${windows}
<rect x="0" y="62" width="44" height="34" fill="url(#sea)"/>
<rect x="0" y="62" width="44" height="0.6" fill="#ff8ab8" opacity="0.7"/>
${glints}${swell}
${palm([40.5, 96], [35, 66], 1.5, 0.62, NIGHT_FAR)}
${palm([7, 96], [12.5, 41], 3.5, 1, NIGHT)}
</svg>`;
}

// For CSS: the SVG as a url() with only the characters that need it escaped.
export function sceneUrl(live) {
  const svg = scene(live).replace(/\n/g, "");
  const encoded = svg.replace(/[#%<>"{}|\\^`]/g, (c) => encodeURIComponent(c));
  return `url("data:image/svg+xml,${encoded}")`;
}
