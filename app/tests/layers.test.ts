// 图层的纯函数测试：四角钉的透视矩阵（engine/layers.ts quadHomography）：bun test tests/layers.test.ts
import { expect, test } from 'bun:test';
import { quadHomography } from '../src/engine/layers';

const apply = (H: number[], x: number, y: number) => {
  const z = H[6]! * x + H[7]! * y + H[8]!;
  return [(H[0]! * x + H[1]! * y + H[2]!) / z, (H[3]! * x + H[4]! * y + H[5]!) / z];
};
const near = (a: number, b: number, eps = 1e-6) => expect(Math.abs(a - b)).toBeLessThan(eps);

test('corners land on the four points (perspective quad)', () => {
  const q = [[78, 64], [498, 92], [486, 352], [88, 384]];
  const H = quadHomography(1280, 720, q)!;
  const corners = [[0, 0], [1280, 0], [1280, 720], [0, 720]];
  corners.forEach(([x, y], i) => { const p = apply(H, x!, y!); near(p[0]!, q[i]![0]!); near(p[1]!, q[i]![1]!); });
  // straight lines stay straight: the layer's centre goes to the quad's diagonals' crossing
  const c = apply(H, 640, 360);
  const cross = (a: number[], b: number[], c2: number[], d: number[]) => {
    const t = ((c2[0]! - a[0]!) * (d[1]! - c2[1]!) - (c2[1]! - a[1]!) * (d[0]! - c2[0]!)) / ((b[0]! - a[0]!) * (d[1]! - c2[1]!) - (b[1]! - a[1]!) * (d[0]! - c2[0]!));
    return [a[0]! + t * (b[0]! - a[0]!), a[1]! + t * (b[1]! - a[1]!)];
  };
  const x = cross(q[0]!, q[2]!, q[1]!, q[3]!);
  near(c[0]!, x[0]!, 1e-6); near(c[1]!, x[1]!, 1e-6);
});

test('a parallelogram is affine; a degenerate quad is null', () => {
  const H = quadHomography(100, 50, [[10, 10], [110, 20], [120, 70], [20, 60]])!;
  near(H[6]!, 0); near(H[7]!, 0);
  const p = apply(H, 100, 50); near(p[0]!, 120); near(p[1]!, 70);
  expect(quadHomography(100, 50, [[0, 0], [10, 0], [20, 0], [30, 0]])).toBeNull();
});
