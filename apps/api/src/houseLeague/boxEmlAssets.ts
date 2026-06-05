import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { boxEmlTemplateAssets } from "../db/schema.js";

export const BOX_EML_ASSET_URL_PREFIX = "/api/house-league/box-eml-assets/";

export type BoxEmlAssetRecord = {
  id: string;
  mimeType: string;
  dataBase64: string;
  width: number | null;
  height: number | null;
};

const DATA_URL_IMG_RE =
  /<img\b([^>]*?)\bsrc=(["'])(data:image\/[^"']+)\2([^>]*)>/gi;

const ASSET_URL_IMG_RE = new RegExp(
  `<img\\b([^>]*?)\\bsrc=(["'])${BOX_EML_ASSET_URL_PREFIX.replace(/\//g, "\\/")}([^"']+)\\2([^>]*)>`,
  "gi",
);

function parseDataUrl(dataUrl: string): { mimeType: string; dataBase64: string } | null {
  const match = /^data:(image\/[^;]+);base64,(.+)$/is.exec(dataUrl.trim());
  if (!match) return null;
  return { mimeType: match[1].toLowerCase(), dataBase64: match[2] };
}

export function boxEmlAssetPublicUrl(id: string): string {
  return `${BOX_EML_ASSET_URL_PREFIX}${id}`;
}

export function createBoxEmlTemplateAsset(
  db: Db,
  input: {
    mimeType: string;
    dataBase64: string;
    width?: number | null;
    height?: number | null;
  },
): BoxEmlAssetRecord {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  db.insert(boxEmlTemplateAssets)
    .values({
      id,
      mimeType: input.mimeType,
      dataBase64: input.dataBase64,
      width: input.width ?? null,
      height: input.height ?? null,
      createdAt: now,
    })
    .run();
  return {
    id,
    mimeType: input.mimeType,
    dataBase64: input.dataBase64,
    width: input.width ?? null,
    height: input.height ?? null,
  };
}

export function getBoxEmlTemplateAsset(
  db: Db,
  id: string,
): BoxEmlAssetRecord | null {
  const row = db
    .select()
    .from(boxEmlTemplateAssets)
    .where(eq(boxEmlTemplateAssets.id, id))
    .get();
  if (!row) return null;
  return {
    id: row.id,
    mimeType: row.mimeType,
    dataBase64: row.dataBase64,
    width: row.width,
    height: row.height,
  };
}

export function createBoxEmlTemplateAssetFromDataUrl(
  db: Db,
  dataUrl: string,
  width?: number | null,
  height?: number | null,
): BoxEmlAssetRecord {
  const parsed = parseDataUrl(dataUrl);
  if (!parsed) throw new Error("invalid_image_data_url");
  return createBoxEmlTemplateAsset(db, {
    mimeType: parsed.mimeType,
    dataBase64: parsed.dataBase64,
    width,
    height,
  });
}

/** Replace inline data-URL images with stored asset URLs (smaller templates). */
export function externalizeEmlTemplateAssets(db: Db, html: string): string {
  return html.replace(
    DATA_URL_IMG_RE,
    (full, before, quote, dataUrl, after) => {
      try {
        const asset = createBoxEmlTemplateAssetFromDataUrl(db, dataUrl);
        return `<img${before}src=${quote}${boxEmlAssetPublicUrl(asset.id)}${quote}${after}>`;
      } catch {
        return full;
      }
    },
  );
}

/** Expand stored asset URLs back to data URLs for standalone .eml HTML. */
export function inlineEmlTemplateAssets(db: Db, html: string): string {
  return html.replace(
    ASSET_URL_IMG_RE,
    (full, before, quote, assetId, after) => {
      const asset = getBoxEmlTemplateAsset(db, assetId);
      if (!asset) return full;
      const dataUrl = `data:${asset.mimeType};base64,${asset.dataBase64}`;
      return `<img${before}src=${quote}${dataUrl}${quote}${after}>`;
    },
  );
}
