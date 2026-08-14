export interface ScreenPoint {
  x: number;
  y: number;
}

export interface DropLine {
  from: number;
  to: number;
}

export interface CodeMirrorDropBridge {
  length: number;
  posAtCoords(point: ScreenPoint): number | null;
  lineAt(offset: number): DropLine;
  coordsAtPos(offset: number): { top: number; bottom: number } | null;
}

export type ResolvedLineDrop =
  | { kind: "precise"; offset: number; markerTop: number }
  | { kind: "fallback"; reason: string };

type UnknownRecord = Record<PropertyKey, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null;
}

export function asCodeMirrorDropBridge(value: unknown): CodeMirrorDropBridge | null {
  try {
    if (!isRecord(value) || !isRecord(value.state)) return null;
    const doc = value.state.doc;
    if (!isRecord(doc)) return null;

    const { length } = doc;
    const lineAt = doc.lineAt;
    const posAtCoords = value.posAtCoords;
    const coordsAtPos = value.coordsAtPos;
    if (
      !Number.isInteger(length)
      || (length as number) < 0
      || typeof lineAt !== "function"
      || typeof posAtCoords !== "function"
      || typeof coordsAtPos !== "function"
    ) return null;

    return {
      length: length as number,
      posAtCoords: point => posAtCoords.call(value, point) as number | null,
      lineAt: offset => lineAt.call(doc, offset) as DropLine,
      coordsAtPos: offset => coordsAtPos.call(value, offset) as { top: number; bottom: number } | null,
    };
  } catch {
    return null;
  }
}

function fallback(reason: string): ResolvedLineDrop {
  return { kind: "fallback", reason };
}

function isLine(value: unknown, length: number, offset: number): value is DropLine {
  if (!isRecord(value)) return false;
  const { from, to } = value;
  return Number.isInteger(from)
    && Number.isInteger(to)
    && (from as number) >= 0
    && (from as number) <= offset
    && offset <= (to as number)
    && (to as number) <= length;
}

function isCoordinates(value: unknown): value is { top: number; bottom: number } {
  if (!isRecord(value)) return false;
  const { top, bottom } = value;
  return typeof top === "number"
    && Number.isFinite(top)
    && typeof bottom === "number"
    && Number.isFinite(bottom)
    && top <= bottom;
}

export function resolveLineDrop(
  bridge: CodeMirrorDropBridge,
  point: ScreenPoint,
  editorBounds: { top: number; bottom: number },
): ResolvedLineDrop {
  try {
    if (
      !isRecord(bridge)
      || !Number.isInteger(bridge.length)
      || bridge.length < 0
      || typeof bridge.posAtCoords !== "function"
      || typeof bridge.lineAt !== "function"
      || typeof bridge.coordsAtPos !== "function"
    ) return fallback("CodeMirror drop capabilities are unavailable.");

    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
      return fallback("Screen coordinates are unavailable.");
    }
    if (
      !Number.isFinite(editorBounds.top)
      || !Number.isFinite(editorBounds.bottom)
      || editorBounds.top > editorBounds.bottom
      || point.y < editorBounds.top
      || point.y > editorBounds.bottom
    ) return fallback("The pointer is outside the editor bounds.");

    const position = bridge.posAtCoords(point);
    if (position === null) {
      const lastLine = bridge.lineAt(bridge.length);
      if (!isLine(lastLine, bridge.length, bridge.length)) {
        return fallback("CodeMirror returned an invalid last line.");
      }
      const lastCoordinates = bridge.coordsAtPos(bridge.length);
      if (isCoordinates(lastCoordinates) && point.y > lastCoordinates.bottom) {
        return { kind: "precise", offset: bridge.length, markerTop: lastCoordinates.bottom };
      }
      return fallback("CodeMirror could not resolve the pointer position.");
    }
    if (!Number.isInteger(position) || position < 0 || position > bridge.length) {
      return fallback("CodeMirror returned an out-of-range position.");
    }

    const line = bridge.lineAt(position);
    if (!isLine(line, bridge.length, position)) {
      return fallback("CodeMirror returned an invalid target line.");
    }
    const coordinates = bridge.coordsAtPos(line.from);
    if (!isCoordinates(coordinates)) {
      return fallback("The target line coordinates are unavailable.");
    }
    if (line.to === bridge.length && point.y > coordinates.bottom) {
      // ponytail: query the virtualized document end only after CodeMirror says
      // the pointer is on the final logical line; ordinary lines avoid this layout read.
      try {
        const lastCoordinates = bridge.coordsAtPos(bridge.length);
        if (isCoordinates(lastCoordinates) && point.y > lastCoordinates.bottom) {
          return { kind: "precise", offset: bridge.length, markerTop: lastCoordinates.bottom };
        }
      } catch {
        // The visible target is still precise even when the offscreen end is unavailable.
      }
    }
    return { kind: "precise", offset: line.from, markerTop: coordinates.top };
  } catch {
    return fallback("CodeMirror drop resolution failed.");
  }
}
