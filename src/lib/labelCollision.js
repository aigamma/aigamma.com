// Horizontal-collision merging for the level labels on the Gamma Inflection
// and Gamma Map charts. Two level labels whose rendered x-positions are within
// COLLISION_THRESHOLD_PX of each other are merged into a single label whose
// text is the concatenation of the individual labels' "KEY VALUE" segments,
// joined with " / " and ordered so the higher-priority key appears first.
//
// Priority convention: walls (CW, PW) rank above the volatility flip (FLIP)
// because walls are structurally more significant — they mark the strikes
// where dealer gamma is concentrated, whereas the flip is an integrated
// zero-crossing that migrates around during a session. Within the wall tier
// CW and PW share the same numeric priority, and the tie is broken by the
// alphabetical key order so the merge output is deterministic.
//
// The merged label inherits the position (x, top) of the highest-priority
// label in the group. That means a CW+FLIP merge will sit at CW's top-of-plot
// anchor rather than FLIP's above-the-rangeslider anchor, which is the right
// call: the walls occupy the visually dominant label row on both charts and
// the merged label belongs up there with its peer walls.

const COLLISION_THRESHOLD_PX = 40;

function formatValue(v) {
  return Number(v).toLocaleString('en-US', { maximumFractionDigits: 0 });
}

export function mergeCollidingLabels(labels) {
  if (!labels || labels.length === 0) return [];

  // Single-label case still gets normalized into the segment shape so the
  // render path can treat every level label uniformly.
  if (labels.length === 1) {
    const l = labels[0];
    return [
      {
        x: l.x,
        top: l.top,
        color: l.color,
        segments: [{ key: l.key, value: l.value, color: l.color, display: `${l.key} ${formatValue(l.value)}` }],
      },
    ];
  }

  // Union-find over the proximity graph so chains (A-B close, B-C close,
  // A-C not close) merge into a single group.
  const n = labels.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (i) => {
    let root = i;
    while (parent[root] !== root) root = parent[root];
    while (parent[i] !== root) {
      const next = parent[i];
      parent[i] = root;
      i = next;
    }
    return root;
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (Math.abs(labels[i].x - labels[j].x) < COLLISION_THRESHOLD_PX) {
        union(i, j);
      }
    }
  }

  const groups = new Map();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(labels[i]);
  }

  const result = [];
  for (const group of groups.values()) {
    group.sort((a, b) => a.priority - b.priority || a.key.localeCompare(b.key));
    const anchor = group[0];
    result.push({
      x: anchor.x,
      top: anchor.top,
      color: anchor.color,
      segments: group.map((g) => ({
        key: g.key,
        value: g.value,
        color: g.color,
        display: `${g.key} ${formatValue(g.value)}`,
      })),
    });
  }

  return result;
}
