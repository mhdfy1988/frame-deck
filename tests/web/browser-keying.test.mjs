import test from "node:test";
import assert from "node:assert/strict";
import {
  guessBackground,
  removeBackground,
  validateSize,
} from "../../browser/keying/core.js";
import { seedColorDistance } from "../../browser/keying/color-distance.js";
import { containPoint } from "../../browser/ui/keying-controls.js";

const green = [0, 255, 0, 255],
  red = [200, 40, 20, 255];
function fixture() {
  const pixels = new Uint8ClampedArray(9 * 9 * 4);
  for (let y = 0; y < 9; y++)
    for (let x = 0; x < 9; x++)
      pixels.set(
        x >= 2 && x <= 6 && y >= 2 && y <= 6 ? red : green,
        (y * 9 + x) * 4,
      );
  pixels.set(green, (4 * 9 + 4) * 4);
  for (const p of [0, 8, 72, 80]) pixels.set(red, p * 4);
  return pixels;
}
const options = {
  color: [0, 255, 0],
  tolerance: 30,
  softness: 12,
  cleanup: 70,
  connected: true,
};
test("EazyCut边缘多数色不受四角主体影响，连通与全图明确区分", () => {
  const source = fixture(),
    original = source.slice();
  assert.deepEqual(guessBackground(source, 9, 9), [0, 255, 0]);
  const connected = removeBackground(source, 9, 9, options).data;
  assert.equal(connected[1 * 4 + 3], 0);
  assert.equal(connected[(4 * 9 + 4) * 4 + 3], 255, "封闭绿孔默认保留");
  assert.deepEqual([...connected.slice(0, 4)], red, "角点主体不应被当背景");
  const global = removeBackground(source, 9, 9, {
    ...options,
    connected: false,
  }).data;
  assert.equal(
    global[(4 * 9 + 4) * 4 + 3],
    0,
    "全图模式可去孔洞，也无法识别同色配饰",
  );
  assert.deepEqual(
    [...global.slice((3 * 9 + 3) * 4, (3 * 9 + 3) * 4 + 4)],
    red,
  );
  assert.deepEqual(source, original, "输入原图不可变");
});
test("柔边与去底色只作用于软边，不改不透明主体RGB", () => {
  const source = new Uint8ClampedArray([...red, 80, 190, 30, 255]);
  const d = seedColorDistance(0, 255, 0)(80, 190, 30);
  const settings = {
    ...options,
    connected: false,
    tolerance: d - 5,
    softness: 10,
  };
  const untouched = removeBackground(source, 2, 1, {
    ...settings,
    cleanup: 0,
  }).data;
  const clean = removeBackground(source, 2, 1, {
    ...settings,
    cleanup: 100,
  }).data;
  assert.equal(clean[7], 128);
  assert.equal(untouched[7], 128);
  assert.notDeepEqual([...clean.slice(4, 7)], [...untouched.slice(4, 7)]);
  assert.deepEqual([...clean.slice(0, 4)], red);
});
test("已有透明度不增加；严格校验参数，适配1200万像素而非600万", () => {
  const source = new Uint8ClampedArray([200, 40, 20, 127, 0, 255, 0, 0]);
  assert.deepEqual(
    [...removeBackground(source, 2, 1, options).data],
    [...source],
  );
  validateSize(4000, 3000);
  assert.throws(() => validateSize(4000, 3001));
  for (const input of [
    { connected: "false" },
    { tolerance: 101 },
    { softness: -1 },
    { cleanup: 101 },
    { color: [NaN, 0, 0] },
  ])
    assert.throws(() =>
      removeBackground(fixture(), 9, 9, { ...options, ...input }),
    );
});
test("原图取色坐标避开contain留白，边界不越界", () => {
  const rect = { left: 10, top: 20, width: 200, height: 200 };
  assert.equal(containPoint(15, 120, rect, 100, 200), null);
  assert.deepEqual(containPoint(60, 20, rect, 100, 200), [0, 0]);
  assert.deepEqual(containPoint(159, 219, rect, 100, 200), [99, 199]);
  assert.equal(containPoint(160, 120, rect, 100, 200), null);
  assert.equal(containPoint(100, 30, rect, 200, 100), null);
});
