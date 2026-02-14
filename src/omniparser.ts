import { logger } from './logger.js';
import {
  OMNIPARSER_ENABLED,
  OMNIPARSER_REPLICATE_TOKEN,
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

/**
 * Check if OmniParser is enabled and configured.
 */
export function isOmniParserEnabled(): boolean {
  return OMNIPARSER_ENABLED && OMNIPARSER_REPLICATE_TOKEN.length > 0;
}

/**
 * Detect UI elements in a screenshot using OmniParser via Replicate API.
 * Returns null on any failure (timeout, network, parse error) — never throws.
 */
export async function detectElements(
  screenshotPng: Buffer,
  imageSize: { width: number; height: number },
): Promise<OmniParserResult | null> {
  if (!OMNIPARSER_REPLICATE_TOKEN) {
    logger.warn('OmniParser enabled but OMNIPARSER_REPLICATE_TOKEN not set');
    return null;
  }

  const startTime = Date.now();
  try {
    const result = await callReplicate(screenshotPng, imageSize);
    if (result) {
      result.latencyMs = Date.now() - startTime;
      logger.info(
        { elements: result.elements.length, latencyMs: result.latencyMs },
        'OmniParser detection completed',
      );
    }
    return result;
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'OmniParser detection failed, proceeding without vision elements',
    );
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function callReplicate(
  screenshotPng: Buffer,
  imageSize: { width: number; height: number },
): Promise<OmniParserResult | null> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), OMNIPARSER_TIMEOUT_MS);

  try {
    const base64Image = screenshotPng.toString('base64');
    const dataUri = `data:image/png;base64,${base64Image}`;

    // Create prediction
    const createResponse = await fetch(
      'https://api.replicate.com/v1/models/microsoft/omniparser-v2/predictions',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${OMNIPARSER_REPLICATE_TOKEN}`,
          'Content-Type': 'application/json',
          Prefer: 'wait',
        },
        body: JSON.stringify({
          input: {
            image: dataUri,
            box_threshold: OMNIPARSER_BOX_THRESHOLD,
            iou_threshold: OMNIPARSER_IOU_THRESHOLD,
          },
        }),
        signal: controller.signal,
      },
    );

    if (!createResponse.ok) {
      const body = await createResponse.text().catch(() => '');
      logger.warn(
        { status: createResponse.status, body: body.slice(0, 200) },
        'Replicate prediction create failed',
      );
      return null;
    }

    let prediction = (await createResponse.json()) as {
      id: string;
      status: string;
      output?: Record<string, unknown>;
      error?: string;
    };

    // If not completed via Prefer: wait, poll for result
    const deadline = Date.now() + OMNIPARSER_TIMEOUT_MS;
    while (
      prediction.status !== 'succeeded' &&
      prediction.status !== 'failed' &&
      prediction.status !== 'canceled' &&
      Date.now() < deadline
    ) {
      await sleep(500);
      const pollResponse = await fetch(
        `https://api.replicate.com/v1/predictions/${prediction.id}`,
        {
          headers: {
            Authorization: `Bearer ${OMNIPARSER_REPLICATE_TOKEN}`,
          },
          signal: controller.signal,
        },
      );
      if (!pollResponse.ok) {
        logger.warn(
          { status: pollResponse.status },
          'Replicate prediction poll failed',
        );
        return null;
      }
      prediction = (await pollResponse.json()) as typeof prediction;
    }

    if (prediction.status !== 'succeeded') {
      logger.warn(
        { status: prediction.status, error: prediction.error },
        'Replicate prediction did not succeed',
      );
      return null;
    }

    if (!prediction.output) {
      logger.warn('Replicate prediction succeeded but output is empty');
      return null;
    }

    const parsedContentList = String(
      prediction.output.parsed_content_list || '',
    );
    const labelCoordinates = prediction.output.label_coordinates;

    const elements = parseOmniParserOutput(
      parsedContentList,
      labelCoordinates,
      imageSize.width,
      imageSize.height,
    );

    return { elements, latencyMs: 0 };
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Parse OmniParser's response into structured elements.
 *
 * parsed_content_list: newline-delimited, e.g.:
 *   "Icon Box ID 0: search icon"
 *   "Text Box ID 1: Settings"
 *
 * label_coordinates: JSON dict or string, e.g.:
 *   {"0": [x1_norm, y1_norm, x2_norm, y2_norm], ...}
 *
 * Coordinates are normalized 0-1 ratios relative to image dimensions.
 */
export function parseOmniParserOutput(
  parsedContentList: string,
  labelCoordinates: unknown,
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
  } else if (
    labelCoordinates &&
    typeof labelCoordinates === 'object' &&
    !Array.isArray(labelCoordinates)
  ) {
    coordsMap = labelCoordinates as Record<string, number[]>;
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

    // Coordinates are normalized 0-1 ratios
    const [x1n, y1n, x2n, y2n] = coords;
    const x1 = Math.round(x1n * imageWidth);
    const y1 = Math.round(y1n * imageHeight);
    const x2 = Math.round(x2n * imageWidth);
    const y2 = Math.round(y2n * imageHeight);

    elements.push({
      label,
      bbox: {
        x: x1,
        y: y1,
        width: x2 - x1,
        height: y2 - y1,
      },
      center: {
        x: Math.round((x1 + x2) / 2),
        y: Math.round((y1 + y2) / 2),
      },
      source: 'omniparser',
    });
  }

  return elements;
}
