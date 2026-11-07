const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const external = require('../JS/zentral_panel_geometry.uc.js');
const source = readFileSync(join(__dirname, '../JS/Zentral.uc.js'), 'utf8');
const start = source.indexOf('  const ZentralGeometryBuiltin = {');
const end = source.indexOf('  class ZentralApps {', start);
assert.ok(start >= 0 && end > start, 'The fallback must be extracted from the real app source');
const fallback = vm.runInNewContext(source.slice(start, end) + '\nZentralGeometryBuiltin;');
const plain = value => JSON.parse(JSON.stringify(value));
const implementations = [['external module', external], ['embedded fallback', fallback]];

for (const [name, geometry] of implementations) {
  test(`${name}: rectangles remain reachable with and without partial overflow`, () => {
    const bounds = { left: 50, top: 20, width: 1000, height: 800 };
    const rect = { x: -400, y: 900, w: 420, h: 500 };
    assert.deepEqual(plain(geometry.clampRect(rect, bounds)), { x: 50, y: 320, w: 420, h: 500 });
    assert.deepEqual(plain(geometry.clampRect(rect, bounds, {}, { allowOverflow: true })), { x: -290, y: 740, w: 420, h: 500 });
    assert.deepEqual(plain(geometry.clampRect({ x: NaN, y: NaN, w: 0, h: 0 }, bounds)), { x: 50, y: 20, w: 320, h: 360 });
  });

  test(`${name}: docking follows either sidebar and the opposite vertical app bar`, () => {
    const common = { panelWidth: 400, topInset: 40, windowWidth: 1200, windowHeight: 800 };
    const cases = [
      [{ sidebarRect: { left: 0, right: 200, width: 200 } }, 212, 'left', 788, 'right'],
      [{ isSidebarRight: true, sidebarRect: { left: 1000, right: 1200, width: 200 } }, 588, 'right', 12, 'left'],
      [{ isPlacementVerticalBar: true, vbRect: { width: 48 }, sidebarRect: { left: 0, right: 200, width: 200 } }, 740, 'right', 212, 'left'],
      [{ isPlacementVerticalBar: true, isSidebarRight: true, vbRect: { width: 48 }, sidebarRect: { left: 1000, right: 1200, width: 200 } }, 60, 'left', 588, 'right'],
      [{ isPlacementVerticalBar: true, isVbRevealed: false }, 788, 'right', 12, 'left'],
      [{ isSidebarCollapsed: true, sidebarRect: { left: 0, right: 200, width: 200 } }, 207, 'left', 788, 'right'],
    ];
    for (const [params, sidebarX, sidebarSide, oppositeX, oppositeSide] of cases) {
      assert.deepEqual(plain(geometry.getDockSlots({ ...common, ...params })), {
        sidebar: { x: sidebarX, y: 40, w: 400, h: 748, side: sidebarSide },
        opposite: { x: oppositeX, y: 40, w: 400, h: 748, side: oppositeSide },
      });
    }
  });

  test(`${name}: snapping distinguishes both edges from a panel in the center`, () => {
    const slots = { sidebar: { x: 12, w: 400, side: 'left' }, opposite: { x: 788, w: 400, side: 'right' } };
    assert.equal(geometry.hitTestSnapZone({ pointerX: 450, panelRect: { x: 70, w: 400 } }, slots, 80), 'sidebar');
    assert.equal(geometry.hitTestSnapZone({ pointerX: 700, panelRect: { left: 750, width: 400 } }, slots, 80), 'opposite');
    assert.equal(geometry.hitTestSnapZone({ pointerX: 600, panelRect: { x: 400, w: 400 } }, slots, 80), null);
  });

  test(`${name}: all eight resize handles move only their intended edges`, () => {
    const rect = { x: 400, y: 300, w: 400, h: 400 };
    const cases = [
      ['e', { x: 400, y: 300, w: 450, h: 400 }],
      ['w', { x: 450, y: 300, w: 350, h: 400 }],
      ['n', { x: 400, y: 340, w: 400, h: 360 }],
      ['s', { x: 400, y: 300, w: 400, h: 460 }],
      ['ne', { x: 400, y: 340, w: 450, h: 360 }],
      ['nw', { x: 450, y: 340, w: 350, h: 360 }],
      ['se', { x: 400, y: 300, w: 450, h: 460 }],
      ['sw', { x: 450, y: 300, w: 350, h: 460 }],
    ];
    for (const [direction, expected] of cases) {
      assert.deepEqual(plain(geometry.computeResize(direction, rect, 50, 60)), expected);
      assert.deepEqual(plain(geometry.computeResize(rect, direction, 50, 60)), expected);
    }
  });

  test(`${name}: controls flip to a reachable side near either window edge`, () => {
    const bounds = { left: 0, width: 1200 };
    assert.equal(geometry.pickPillSide({ x: -100, w: 400 }, bounds, 44, 'left'), 'right');
    assert.equal(geometry.pickPillSide({ x: 1050, w: 400 }, bounds, 44, 'right'), 'left');
    assert.equal(geometry.pickPillSide({ x: 400, w: 400 }, bounds, 44, 'left'), 'left');
  });
}
