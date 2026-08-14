import assert from "node:assert/strict";
import test from "node:test";
import {
  asCodeMirrorDropBridge,
  resolveLineDrop,
  type CodeMirrorDropBridge,
  type DropLine,
  type ResolvedLineDrop,
} from "../src/editorDrop.ts";

const lines: DropLine[] = [
  { from: 0, to: 4 },
  { from: 5, to: 9 },
  { from: 10, to: 14 },
];

function lineAt(offset: number): DropLine {
  if (offset <= 4) return lines[0] as DropLine;
  if (offset <= 9) return lines[1] as DropLine;
  return lines[2] as DropLine;
}

function coordsAtPos(offset: number): { top: number; bottom: number } | null {
  if (offset === 0) return { top: 40, bottom: 60 };
  if (offset === 5) return { top: 100, bottom: 120 };
  if (offset === 10 || offset === 14) return { top: 150, bottom: 170 };
  return null;
}

function bridge(overrides: Partial<CodeMirrorDropBridge> = {}): CodeMirrorDropBridge {
  return {
    length: 14,
    posAtCoords: () => 7,
    lineAt,
    coordsAtPos,
    ...overrides,
  };
}

function assertFallback(result: ResolvedLineDrop): void {
  assert.equal(result.kind, "fallback");
  if (result.kind === "fallback") assert.match(result.reason, /\S/);
}

test("the runtime guard adapts only a complete CodeMirror-shaped object and keeps method receivers", () => {
  const doc = {
    length: 14,
    lineAt(offset: number) {
      assert.equal(this, doc);
      return lineAt(offset);
    },
  };
  const runtime = {
    state: { doc },
    posAtCoords(point: { x: number; y: number }) {
      assert.equal(this, runtime);
      return point.x === 10 ? 7 : null;
    },
    coordsAtPos(offset: number) {
      assert.equal(this, runtime);
      return coordsAtPos(offset);
    },
  };

  const adapted = asCodeMirrorDropBridge(runtime);
  assert.ok(adapted);
  assert.equal(adapted.length, 14);
  assert.equal(adapted.posAtCoords({ x: 10, y: 110 }), 7);
  assert.deepEqual(adapted.lineAt(7), { from: 5, to: 9 });
  assert.deepEqual(adapted.coordsAtPos(5), { top: 100, bottom: 120 });

  const invalid = [
    null,
    {},
    { state: { doc: { length: 14, lineAt } }, posAtCoords() {} },
    { state: { doc: { length: -1, lineAt } }, posAtCoords() {}, coordsAtPos() {} },
    { state: { doc: { length: 14 } }, posAtCoords() {}, coordsAtPos() {} },
  ];
  for (const value of invalid) assert.equal(asCodeMirrorDropBridge(value), null);

  const throwing = Object.defineProperty({}, "state", {
    get() {
      throw new Error("private editor changed");
    },
  });
  assert.equal(asCodeMirrorDropBridge(throwing), null);
});

test("a coordinate in the middle of a line snaps to line.from and uses that line's top", () => {
  const result = resolveLineDrop(
    bridge({ posAtCoords: () => 7 }),
    { x: 20, y: 110 },
    { top: 20, bottom: 260 },
  );
  assert.deepEqual(result, { kind: "precise", offset: 5, markerTop: 100 });
});

test("the first line snaps to offset zero", () => {
  const result = resolveLineDrop(
    bridge({ posAtCoords: () => 2 }),
    { x: 20, y: 50 },
    { top: 20, bottom: 260 },
  );
  assert.deepEqual(result, { kind: "precise", offset: 0, markerTop: 40 });
});

test("a visible target remains precise when the offscreen document end has no coordinates", () => {
  const result = resolveLineDrop(
    bridge({
      posAtCoords: () => 7,
      coordsAtPos: offset => offset === 5 ? { top: 100, bottom: 120 } : null,
    }),
    { x: 20, y: 110 },
    { top: 20, bottom: 260 },
  );

  assert.deepEqual(result, { kind: "precise", offset: 5, markerTop: 100 });
});

test("a normal visible line does not query the virtualized document end", () => {
  const calls: number[] = [];
  const result = resolveLineDrop(
    bridge({
      posAtCoords: () => 7,
      coordsAtPos: offset => {
        calls.push(offset);
        return offset === 5 ? { top: 100, bottom: 120 } : null;
      },
    }),
    { x: 20, y: 110 },
    { top: 20, bottom: 260 },
  );

  assert.deepEqual(result, { kind: "precise", offset: 5, markerTop: 100 });
  assert.deepEqual(calls, [5]);
});

test("editor whitespace below the last line resolves to document end and the last line bottom", () => {
  const result = resolveLineDrop(
    bridge({ posAtCoords: () => 12 }),
    { x: 20, y: 220 },
    { top: 20, bottom: 260 },
  );
  assert.deepEqual(result, { kind: "precise", offset: 14, markerTop: 170 });

  assertFallback(resolveLineDrop(
    bridge({ posAtCoords: () => null }),
    { x: 20, y: 280 },
    { top: 20, bottom: 260 },
  ));
});

test("null positions and unavailable target coordinates return a visible fallback", () => {
  assertFallback(resolveLineDrop(
    bridge({ posAtCoords: () => null }),
    { x: 20, y: 110 },
    { top: 20, bottom: 260 },
  ));

  assertFallback(resolveLineDrop(
    bridge({
      posAtCoords: () => 7,
      coordsAtPos: offset => offset === 10 ? { top: 150, bottom: 170 } : null,
    }),
    { x: 20, y: 110 },
    { top: 20, bottom: 260 },
  ));
});

test("missing capabilities, thrown methods, and out-of-range offsets all return fallback", () => {
  assertFallback(resolveLineDrop(
    {} as CodeMirrorDropBridge,
    { x: 20, y: 110 },
    { top: 20, bottom: 260 },
  ));

  const throwingBridges = [
    bridge({ posAtCoords: () => { throw new Error("position failed"); } }),
    bridge({ lineAt: () => { throw new Error("line failed"); } }),
    bridge({ coordsAtPos: () => { throw new Error("coordinates failed"); } }),
  ];
  for (const candidate of throwingBridges) {
    assertFallback(resolveLineDrop(candidate, { x: 20, y: 110 }, { top: 20, bottom: 260 }));
  }

  for (const offset of [-1, 15, 1.5]) {
    assertFallback(resolveLineDrop(
      bridge({ posAtCoords: () => offset }),
      { x: 20, y: 110 },
      { top: 20, bottom: 260 },
    ));
  }
});

test("invalid screen coordinates, bounds, and line records return fallback", () => {
  assertFallback(resolveLineDrop(
    bridge(),
    { x: Number.NaN, y: 110 },
    { top: 20, bottom: 260 },
  ));
  assertFallback(resolveLineDrop(
    bridge(),
    { x: 20, y: 110 },
    { top: 260, bottom: 20 },
  ));
  assertFallback(resolveLineDrop(
    bridge({ lineAt: () => ({ from: 9, to: 5 }) }),
    { x: 20, y: 110 },
    { top: 20, bottom: 260 },
  ));
});
