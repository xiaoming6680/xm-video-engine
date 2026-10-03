// Helpers for posing an MMD character (from Still_Shining v10): keep a skirt out of the legs, and check the camera
// against the skirt (the user's rule for Douyin: no low angles, nothing up the skirt). Model-agnostic: bones are
// looked up by name in the skinned mesh's skeleton; the defaults are the MMD standard / semi-standard names.
// Pure functions of the current pose (no state): call after posing and after any wind on the chains.
//   const bones = boneMap(mesh);
//   collideSkirt(mesh, bones, { chains: skirtChains(bones, /^スカート_(\d+)_(\d+)$/) });
//   const m = thighView(bones, camera.position);  if (m.dist < 7 && m.angle < 55) console.warn(`MODESTY ...`);
// Still_Shining's teto3d.ts / figure.ts are the full use (with a scan over the whole film: render.ts scan).
import * as THREE from 'three';

/** Bones of a skinned mesh by name. */
export function boneMap(mesh: THREE.SkinnedMesh) {
  const m = new Map<string, THREE.Bone>();
  for (const b of mesh.skeleton.bones) m.set(b.name, b);
  return m;
}

/**
 * The skirt's chains (root -> tip) from bone names matching `re` with two numeric groups: (index down the chain,
 * index around the waist), e.g. /^スカート_(\d+)_(\d+)$/ for Tda-style skirts. Swap the groups with `aroundFirst`.
 */
export function skirtChains(bones: Map<string, THREE.Bone>, re: RegExp, aroundFirst = false): string[][] {
  const by = new Map<number, [number, string][]>();
  for (const name of bones.keys()) {
    const m = re.exec(name);
    if (!m) continue;
    const down = +m[aroundFirst ? 2 : 1]!, around = +m[aroundFirst ? 1 : 2]!;
    if (!by.has(around)) by.set(around, []);
    by.get(around)!.push([down, name]);
  }
  return [...by.entries()].sort((a, b) => a[0] - b[0]).map(([, l]) => l.sort((a, b) => a[0] - b[0]).map(([, n]) => n));
}

interface Capsule { a: THREE.Vector3; b: THREE.Vector3; r: number }
const _s1 = new THREE.Vector3(), _s2 = new THREE.Vector3(), _s3 = new THREE.Vector3();
const _qw = new THREE.Quaternion(), _qp = new THREE.Quaternion();

/** Penetration of point p into the capsule (> 0: inside, by that much). */
function pen(p: THREE.Vector3, c: Capsule) {
  _s1.subVectors(c.b, c.a);
  const u = THREE.MathUtils.clamp(_s2.subVectors(p, c.a).dot(_s1) / Math.max(_s1.lengthSq(), 1e-12), 0, 1);
  return c.r - _s3.copy(c.a).addScaledVector(_s1, u).distanceTo(p);
}

/** Turn a bone by a world-space rotation (about its own head), children following. */
function rotateWorld(b: THREE.Bone, qw: THREE.Quaternion) {
  if (!b.parent) return;
  b.getWorldQuaternion(_qw);
  b.parent.getWorldQuaternion(_qp);
  b.quaternion.copy(_qp.invert().multiply(qw.clone().multiply(_qw)));
  b.updateMatrixWorld(true);
}

export interface Leg { hip: string; knee: string; ankle: string }
/** MMD semi-standard D bones (the legs are skinned to them when present); use 左足/左ひざ/左足首 otherwise. */
export const LEGS_D: Leg[] = [{ hip: '左足D', knee: '左ひざD', ankle: '左足首D' }, { hip: '右足D', knee: '右ひざD', ankle: '右足首D' }];

export interface SkirtOptions {
  /** Chains of bone names, root (at the waistband) -> tip, going round the waist in order. */
  chains: string[][];
  legs?: Leg[];
  /**
   * The thigh capsule in model units: from `from` to `to` below the hip joint along the thigh, radius `r` (take them
   * from the model's thigh rigid body, a little larger: the skirt's bones run inside the cloth). Tda Teto: 0.79,
   * 4.35, 1.15 (rigid body 1.107).
   */
  thigh?: { from: number; to: number; r: number };
  /** Shin + boot radius (model units). Tda Teto: 0.8 (rigid body 0.69). */
  shinR?: number;
  /** The pelvis bone whose up is the waistband's axis. */
  pelvis?: string;
  /** Largest lift (deg): the flap lifts like cloth over the knees, it does not flip up. */
  maxLift?: number;
}

/**
 * Keep the skirt outside the legs. Each chain is a flap hinged on the waistband: when a raised thigh (or the wind)
 * puts any of its bones inside a leg, the flap swings outward about the waistband's tangent just far enough to clear
 * it; neighbours follow half-way (the cloth between chains does not tear); then each lower segment falls back
 * toward where it was until it rests on the leg (the hem drapes over the thigh instead of sticking out stiff).
 */
export function collideSkirt(mesh: THREE.SkinnedMesh, bones: Map<string, THREE.Bone>, o: SkirtOptions) {
  mesh.updateMatrixWorld(true);
  const s = mesh.matrixWorld.getMaxScaleOnAxis();
  const th = o.thigh ?? { from: 0.79, to: 4.35, r: 1.15 };
  const caps: Capsule[] = [];
  for (const leg of o.legs ?? LEGS_D) {
    const hb = bones.get(leg.hip), kb = bones.get(leg.knee), ab = bones.get(leg.ankle);
    if (!hb || !kb || !ab) continue;
    const hip = hb.getWorldPosition(new THREE.Vector3()), knee = kb.getWorldPosition(new THREE.Vector3()), ankle = ab.getWorldPosition(new THREE.Vector3());
    const d = knee.clone().sub(hip).normalize();
    caps.push({ a: hip.clone().addScaledVector(d, th.from * s), b: hip.clone().addScaledVector(d, th.to * s), r: th.r * s });
    caps.push({ a: knee, b: ankle, r: (o.shinR ?? 0.8) * s });
  }
  const chains = o.chains.map((c) => c.map((n) => bones.get(n)!)).filter((bs) => bs.length > 1 && bs.every(Boolean));
  if (!chains.length || !caps.length) return;
  const P = chains.map((bs) => bs.map((b) => b.getWorldPosition(new THREE.Vector3())));
  const C = new THREE.Vector3();
  for (const ps of P) C.add(ps[0]!);
  C.divideScalar(P.length);
  const pelvis = bones.get(o.pelvis ?? '下半身');
  const up = new THREE.Vector3(0, 1, 0).applyQuaternion(pelvis ? pelvis.getWorldQuaternion(new THREE.Quaternion()) : mesh.getWorldQuaternion(new THREE.Quaternion())).normalize();
  const worst = (ps: THREE.Vector3[], from = 1) => {
    let m = -Infinity;
    for (let i = from; i < ps.length; i++) for (const c of caps) m = Math.max(m, pen(ps[i]!, c));
    return m;
  };
  const q = new THREE.Quaternion();
  const rotated = (ps: THREE.Vector3[], axis: THREE.Vector3, a: number) => {
    q.setFromAxisAngle(axis, a);
    return ps.map((p) => p.clone().sub(ps[0]!).applyQuaternion(q).add(ps[0]!));
  };
  // 1) the lift each flap needs on its own (+angle swings it outward)
  const axes = P.map((ps) => {
    const rad = ps[0]!.clone().sub(C);
    rad.addScaledVector(up, -rad.dot(up)).normalize();
    return new THREE.Vector3().crossVectors(rad, up).normalize();
  });
  const MAX = THREE.MathUtils.degToRad(o.maxLift ?? 110), STEP = THREE.MathUtils.degToRad(4);
  const lift = P.map((ps, j) => {
    if (worst(ps) <= 0) return 0;
    let lo = 0, hi = MAX;
    for (let a = STEP; a <= MAX; a += STEP) { if (worst(rotated(ps, axes[j]!, a)) <= 0) { hi = a; break; } lo = a; }
    for (let k = 0; k < 4; k++) { const m = (lo + hi) / 2; if (worst(rotated(ps, axes[j]!, m)) <= 0) hi = m; else lo = m; }
    return hi;
  });
  // 2) neighbours follow half-way
  const n = lift.length;
  const smooth = lift.map((v, j) => Math.max(v, 0.5 * lift[(j + n - 1) % n]!, 0.5 * lift[(j + 1) % n]!));
  // 3) swing the flaps, then let each segment fall back toward where it was until it touches a leg
  chains.forEach((bs, j) => {
    const a = smooth[j]!;
    if (a <= 1e-4) return;
    const before = P[j]!.map((p, i) => (i < P[j]!.length - 1 ? P[j]![i + 1]!.clone().sub(p).normalize() : null));
    rotateWorld(bs[0]!, q.setFromAxisAngle(axes[j]!, a));
    for (let i = 1; i < bs.length - 1; i++) {
      const b = bs[i]!, want = before[i]!;
      const ps = bs.map((x) => x.getWorldPosition(new THREE.Vector3()));
      const cur = ps[i + 1]!.clone().sub(ps[i]!).normalize();
      if (cur.dot(want) > 0.9995) continue;
      const full = new THREE.Quaternion().setFromUnitVectors(cur, want), id = new THREE.Quaternion();
      const ok = (k: number) => {
        const qq = id.clone().slerp(full, k);
        return worst(ps.slice(i).map((p) => p.clone().sub(ps[i]!).applyQuaternion(qq).add(ps[i]!)), 1) <= 0;
      };
      let lo = 0, hi = 1;
      if (ok(1)) lo = 1;
      else for (let k = 0; k < 5; k++) { const m = (lo + hi) / 2; if (ok(m)) lo = m; else hi = m; }
      if (lo > 1e-3) rotateWorld(b, new THREE.Quaternion().slerp(full, lo));
    }
  });
}

/**
 * Modesty check: the angle (deg) between the thighs' direction (hips -> knees, both legs) and the direction from her
 * hips to the camera, and that distance (world units). A small angle from close by means the camera looks up along
 * the thighs into the skirt. Still_Shining flags dist < 7 m with angle < 55 deg (close shots: side views only).
 */
export function thighView(bones: Map<string, THREE.Bone>, camPos: THREE.Vector3, legs: Leg[] = LEGS_D) {
  const hip = new THREE.Vector3(), knee = new THREE.Vector3(), v = new THREE.Vector3();
  let n = 0;
  for (const leg of legs) {
    const hb = bones.get(leg.hip), kb = bones.get(leg.knee);
    if (!hb || !kb) continue;
    hip.add(hb.getWorldPosition(v)); knee.add(kb.getWorldPosition(v)); n++;
  }
  if (!n) return { angle: 180, dist: Infinity };
  hip.divideScalar(n); knee.divideScalar(n);
  const th = knee.sub(hip).normalize(), c = camPos.clone().sub(hip);
  const dist = c.length();
  return { angle: THREE.MathUtils.radToDeg(Math.acos(THREE.MathUtils.clamp(th.dot(c.normalize()), -1, 1))), dist };
}
