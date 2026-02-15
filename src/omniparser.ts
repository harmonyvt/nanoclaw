import { logger } from './logger.js';
import { isReplicateConfigured, runModel } from './replicate-client.js';
import {
  OMNIPARSER_ENABLED,
  OMNIPARSER_BOX_THRESHOLD,
  OMNIPARSER_IOU_THRESHOLD,
  OMNIPARSER_TIMEOUT_MS,
} from './config.js';

export type OmniParserElement = {
  label: string;
  bbox: { x: number; y: number; width: number; height: number };
  center: { x: number; y: number };
  source: 'omniparser';
};

export type OmniParserResult = {
  elements: OmniParserElement[];
  latencyMs: number;
};

type OmniParserApiOutput = {
  parsed_content_list?: string;
  label_coordinates?: Record<string, number[]> | string;
};

/**
 * Check if OmniParser is enabled and configured.
 */
export function isOmniParserEnabled(): boolean {
  return OMNIPARSER_ENABLED && isReplicateConfigured();
}

/**
 * Detect UI elements in a screenshot using OmniParser via Replicate API.
 * Returns null on any failure (timeout, network, parse error) — never throws.
 */
export async function detectElements(
  screenshotPng: Buffer,
  imageSize: { width: number; height: number },
): Promise<OmniParserResult | null> {
  if (!isReplicateConfigured()) {
    logger.warn('OmniParser enabled but REPLICATE_API_TOKEN not set');
    return null;
  }

  const startMs = Date.now();
  try {
    const result = await callReplicate(screenshotPng, imageSize);
    if (result) {
      result.latencyMs = Date.now() - startMs;
      logger.info(
        { module: 'omniparser', elements: result.elements.length, latencyMs: result.latencyMs },
        'OmniParser detection completed',
      );
    }
    return result;
  } catch (err) {
    logger.warn(
      { module: 'omniparser', durationMs: Date.now() - startMs, err: err instanceof Error ? err.message : String(err) },
      'OmniParser detection failed, proceeding without vision elements',
    );
    return null;
  }
}

const OMNIPARSER_MODEL =
  'microsoft/omniparser-v2:49cf3d41b8d3aca1360514e83be4c97131ce8f0d99abfc365526d8384caa88df' as const;

async function callReplicate(
  screenshotPng: Buffer,
  imageSize: { width: number; height: number },
): Promise<OmniParserResult | null> {
  const encStartMs = Date.now();
  const base64Image = screenshotPng.toString('base64');
  const dataUri = `data:image/png;base64,${base64Image}`;
  logger.debug(
    { module: 'omniparser', encodingMs: Date.now() - encStartMs, byteLength: screenshotPng.length },
    'Screenshot encoded for OmniParser',
  );

  const output = await runModel<OmniParserApiOutput>(OMNIPARSER_MODEL, {
    image: dataUri,
    box_threshold: OMNIPARSER_BOX_THRESHOLD,
    iou_threshold: OMNIPARSER_IOU_THRESHOLD,
  }, { timeoutMs: OMNIPARSER_TIMEOUT_MS });

  if (!output) {
    logger.warn('Replicate prediction succeeded but output is empty');
    return null;
  }

  const parsedContentList = output.parsed_content_list ?? '';
  const labelCoordinates = output.label_coordinates;

  const elements = parseOmniParserOutput(
    parsedContentList,
    labelCoordinates,
    imageSize.width,
    imageSize.height,
  );

  return { elements, latencyMs: 0 };
}

/**
 * Parse OmniParser's response into structured elements.
 *
 * parsed_content_list: newline-delimited, e.g.:
 *   "Icon Box ID 0: search icon"
 *   "Text Box ID 1: Settings"
 *
 * label_coordinates: JSON dict or string, e.g.:
 *   {"0": [x_norm, y_norm, w_norm, h_norm], ...}
 *
 * Coordinates are in xywh format (top-left x, top-left y, width, height),
 * normalized 0-1 ratios relative to image dimensions.
 */
export function parseOmniParserOutput(
  parsedContentList: string,
  labelCoordinates: Record<string, number[]> | string | undefined,
  imageWidth: number,
  imageHeight: number,
): OmniParserElement[] {
  // Parse coordinates
  let coordsMap: Record<string, number[]>;
  if (typeof labelCoordinates === 'string') {
    try {
      coordsMap = JSON.parse(labelCoordinates);
    } catch {
      logger.warn('Failed to parse OmniParser label_coordinates string');
      return [];
    }
  } else if (labelCoordinates && typeof labelCoordinates === 'object') {
    coordsMap = labelCoordinates;
  } else {
    logger.warn(
      { type: typeof labelCoordinates },
      'Unexpected OmniParser label_coordinates format',
    );
    return [];
  }

  // Parse content list
  const lines = parsedContentList
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  const elements: OmniParserElement[] = [];

  for (const line of lines) {
    // Match patterns like "Icon Box ID 0: search icon" or "Text Box ID 1: Settings"
    const match = line.match(/(?:Box\s+)?ID\s+(\d+)\s*:\s*(.+)/i);
    if (!match) continue;

    const id = match[1];
    const label = match[2].trim();
    const coords = coordsMap[id];
    if (!coords || coords.length < 4) continue;

    // OmniParser returns xywh format (top-left x, top-left y, width, height),
    // all normalized 0-1 ratios relative to image dimensions.
    const [xn, yn, wn, hn] = coords;
    const x1 = Math.round(xn * imageWidth);
    const y1 = Math.round(yn * imageHeight);
    const w = Math.round(wn * imageWidth);
    const h = Math.round(hn * imageHeight);

    elements.push({
      label,
      bbox: {
        x: x1,
        y: y1,
        width: w,
        height: h,
      },
      center: {
        x: Math.round(x1 + w / 2),
        y: Math.round(y1 + h / 2),
      },
      source: 'omniparser',
    });
  }

  return elements;
}
