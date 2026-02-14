import { PNG } from 'pngjs';
import type { ScreenshotAnalysis } from './browse-host.js';
import { logger } from './logger.js';

// 5x7 bitmap font glyphs for A-L, 0-9
// Each glyph is 5 columns x 7 rows, stored as 7 bytes (each byte = 5-bit row, MSB = leftmost pixel)
const GLYPHS: Record<string, number[]> = {
  A: [0b01110, 0b10001, 0b10001, 0b11111, 0b10001, 0b10001, 0b10001],
  B: [0b11110, 0b10001, 0b10001, 0b11110, 0b10001, 0b10001, 0b11110],
  C: [0b01110, 0b10001, 0b10000, 0b10000, 0b10000, 0b10001, 0b01110],
  D: [0b11110, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b11110],
  E: [0b11111, 0b10000, 0b10000, 0b11110, 0b10000, 0b10000, 0b11111],
  F: [0b11111, 0b10000, 0b10000, 0b11110, 0b10000, 0b10000, 0b10000],
  G: [0b01110, 0b10001, 0b10000, 0b10111, 0b10001, 0b10001, 0b01110],
  H: [0b10001, 0b10001, 0b10001, 0b11111, 0b10001, 0b10001, 0b10001],
  I: [0b01110, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100, 0b01110],
  J: [0b00111, 0b00010, 0b00010, 0b00010, 0b00010, 0b10010, 0b01100],
  K: [0b10001, 0b10010, 0b10100, 0b11000, 0b10100, 0b10010, 0b10001],
  L: [0b10000, 0b10000, 0b10000, 0b10000, 0b10000, 0b10000, 0b11111],
  '0': [0b01110, 0b10001, 0b10011, 0b10101, 0b11001, 0b10001, 0b01110],
  '1': [0b00100, 0b01100, 0b00100, 0b00100, 0b00100, 0b00100, 0b01110],
  '2': [0b01110, 0b10001, 0b00001, 0b00110, 0b01000, 0b10000, 0b11111],
  '3': [0b01110, 0b10001, 0b00001, 0b00110, 0b00001, 0b10001, 0b01110],
  '4': [0b00010, 0b00110, 0b01010, 0b10010, 0b11111, 0b00010, 0b00010],
  '5': [0b11111, 0b10000, 0b11110, 0b00001, 0b00001, 0b10001, 0b01110],
  '6': [0b01110, 0b10000, 0b10000, 0b11110, 0b10001, 0b10001, 0b01110],
  '7': [0b11111, 0b00001, 0b00010, 0b00100, 0b01000, 0b01000, 0b01000],
  '8': [0b01110, 0b10001, 0b10001, 0b01110, 0b10001, 0b10001, 0b01110],
  '9': [0b01110, 0b10001, 0b10001, 0b01111, 0b00001, 0b00001, 0b01110],
};

const GLYPH_W = 5;
const GLYPH_H = 7;
const CHAR_SPACING = 1;

type RGBA = { r: number; g: number; b: number; a: number };

function blendPixel(
  data: Buffer,
  idx: number,
  r: number,
  g: number,
  b: number,
  alpha: number,
): void {
  const invA = 1 - alpha;
  data[idx] = Math.round(r * alpha + data[idx] * invA);
  data[idx + 1] = Math.round(g * alpha + data[idx + 1] * invA);
  data[idx + 2] = Math.round(b * alpha + data[idx + 2] * invA);
  // Keep destination alpha at 255
}

function drawHLine(
  data: Buffer,
  width: number,
  y: number,
  x0: number,
  x1: number,
  color: RGBA,
  dashed: boolean,
): void {
  if (y < 0) return;
  for (let x = x0; x <= x1; x++) {
    if (dashed && (x >> 2) % 2 === 1) continue; // 4px on, 4px off
    const idx = (y * width + x) * 4;
    blendPixel(data, idx, color.r, color.g, color.b, color.a);
  }
}

function drawVLine(
  data: Buffer,
  width: number,
  height: number,
  x: number,
  y0: number,
  y1: number,
  color: RGBA,
  dashed: boolean,
): void {
  if (x < 0 || x >= width) return;
  for (let y = y0; y <= Math.min(y1, height - 1); y++) {
    if (dashed && (y >> 2) % 2 === 1) continue;
    const idx = (y * width + x) * 4;
    blendPixel(data, idx, color.r, color.g, color.b, color.a);
  }
}

function fillRect(
  data: Buffer,
  width: number,
  height: number,
  rx: number,
  ry: number,
  rw: number,
  rh: number,
  color: RGBA,
): void {
  const x0 = Math.max(0, rx);
  const y0 = Math.max(0, ry);
  const x1 = Math.min(width - 1, rx + rw - 1);
  const y1 = Math.min(height - 1, ry + rh - 1);
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const idx = (y * width + x) * 4;
      blendPixel(data, idx, color.r, color.g, color.b, color.a);
    }
  }
}

function drawCircleOutline(
  data: Buffer,
  width: number,
  height: number,
  cx: number,
  cy: number,
  radius: number,
  color: RGBA,
): void {
  // Bresenham's circle
  let x = radius;
  let y = 0;
  let err = 1 - radius;

  const plot = (px: number, py: number) => {
    if (px >= 0 && px < width && py >= 0 && py < height) {
      const idx = (py * width + px) * 4;
      blendPixel(data, idx, color.r, color.g, color.b, color.a);
    }
  };

  while (x >= y) {
    plot(cx + x, cy + y);
    plot(cx - x, cy + y);
    plot(cx + x, cy - y);
    plot(cx - x, cy - y);
    plot(cx + y, cy + x);
    plot(cx - y, cy + x);
    plot(cx + y, cy - x);
    plot(cx - y, cy - x);
    y++;
    if (err < 0) {
      err += 2 * y + 1;
    } else {
      x--;
      err += 2 * (y - x) + 1;
    }
  }
}

function drawText(
  data: Buffer,
  width: number,
  height: number,
  text: string,
  startX: number,
  startY: number,
  color: RGBA,
): void {
  let cursorX = startX;
  for (const ch of text) {
    const glyph = GLYPHS[ch.toUpperCase()];
    if (!glyph) {
      cursorX += GLYPH_W + CHAR_SPACING;
      continue;
    }
    for (let row = 0; row < GLYPH_H; row++) {
      const bits = glyph[row];
      for (let col = 0; col < GLYPH_W; col++) {
        if (bits & (1 << (GLYPH_W - 1 - col))) {
          const px = cursorX + col;
          const py = startY + row;
          if (px >= 0 && px < width && py >= 0 && py < height) {
            const idx = (py * width + px) * 4;
            blendPixel(data, idx, color.r, color.g, color.b, color.a);
          }
        }
      }
    }
    cursorX += GLYPH_W + CHAR_SPACING;
  }
}

function textWidth(text: string): number {
  return text.length * (GLYPH_W + CHAR_SPACING) - CHAR_SPACING;
}

// Grid column letters (A-L)
const COL_LETTERS = 'ABCDEFGHIJKL';

// Colors
const GRID_WHITE: RGBA = { r: 255, g: 255, b: 255, a: 0.35 };
const GRID_SHADOW: RGBA = { r: 0, g: 0, b: 0, a: 0.15 };
const LABEL_BG: RGBA = { r: 0, g: 0, b: 0, a: 0.5 };
const LABEL_TEXT: RGBA = { r: 255, g: 255, b: 255, a: 0.85 };
const INTERACTIVE_COLOR: RGBA = { r: 0, g: 200, b: 255, a: 0.8 };
const NON_INTERACTIVE_COLOR: RGBA = { r: 255, g: 180, b: 0, a: 0.7 };
const OMNIPARSER_COLOR: RGBA = { r: 0, g: 220, b: 100, a: 0.8 };
const MARKER_ID_BG: RGBA = { r: 0, g: 0, b: 0, a: 0.65 };
const MARKER_ID_TEXT: RGBA = { r: 255, g: 255, b: 255, a: 0.9 };

export function annotateScreenshot(
  pngBytes: Buffer,
  analysis: ScreenshotAnalysis,
): Buffer {
  let png: PNG;
  try {
    png = PNG.sync.read(pngBytes);
  } catch (err) {
    logger.warn({ err }, 'Failed to decode PNG for annotation, returning original');
    return pngBytes;
  }

  const { width, height, data } = png;
  const { grid, elements } = analysis;
  const cellW = width / grid.cols;
  const cellH = height / grid.rows;

  // 1. Grid lines (skip edges at 0 and max)
  // Vertical lines: between columns
  for (let c = 1; c < grid.cols; c++) {
    const x = Math.round(c * cellW);
    drawVLine(data, width, height, x, 0, height - 1, GRID_WHITE, true);
    drawVLine(data, width, height, x + 1, 0, height - 1, GRID_SHADOW, true);
  }
  // Horizontal lines: between rows
  for (let r = 1; r < grid.rows; r++) {
    const y = Math.round(r * cellH);
    drawHLine(data, width, y, 0, width - 1, GRID_WHITE, true);
    drawHLine(data, width, y + 1, 0, width - 1, GRID_SHADOW, true);
  }

  // 2. Cell labels (e.g. "A1" in top-left of each cell)
  const labelPad = 2;
  for (let r = 0; r < grid.rows; r++) {
    for (let c = 0; c < grid.cols; c++) {
      const label = COL_LETTERS[c] + String(r + 1);
      const lx = Math.round(c * cellW) + labelPad;
      const ly = Math.round(r * cellH) + labelPad;
      const tw = textWidth(label);
      // Background rect
      fillRect(data, width, height, lx - 1, ly - 1, tw + 2, GLYPH_H + 2, LABEL_BG);
      // Text
      drawText(data, width, height, label, lx, ly, LABEL_TEXT);
    }
  }

  // 3. Element markers
  const MARKER_RADIUS = 6;
  for (const el of elements) {
    const cx = el.center.x;
    const cy = el.center.y;
    if (cx < 0 || cx >= width || cy < 0 || cy >= height) continue;

    const color =
      el.role === 'omniparser'
        ? OMNIPARSER_COLOR
        : el.interactive
          ? INTERACTIVE_COLOR
          : NON_INTERACTIVE_COLOR;

    // Circle outline at element center
    drawCircleOutline(data, width, height, cx, cy, MARKER_RADIUS, color);
    drawCircleOutline(data, width, height, cx, cy, MARKER_RADIUS + 1, color);

    // ID badge offset to upper-right
    const idStr = String(el.id);
    const idW = textWidth(idStr);
    const badgeX = cx + MARKER_RADIUS + 2;
    const badgeY = cy - MARKER_RADIUS - 2;
    fillRect(data, width, height, badgeX - 1, badgeY - 1, idW + 2, GLYPH_H + 2, MARKER_ID_BG);
    drawText(data, width, height, idStr, badgeX, badgeY, MARKER_ID_TEXT);
  }

  return PNG.sync.write(png);
}
