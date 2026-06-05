import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createDb } from "../db/client.js";
import {
  boxEmlAssetPublicUrl,
  externalizeEmlTemplateAssets,
  getBoxEmlTemplateAsset,
  inlineEmlTemplateAssets,
} from "./boxEmlAssets.js";

const tempDbPaths: string[] = [];

function testDb() {
  const dbPath = path.join(
    os.tmpdir(),
    `box-eml-assets-${crypto.randomUUID()}.sqlite`,
  );
  tempDbPaths.push(dbPath);
  return createDb(`file:${dbPath.replaceAll("\\", "/")}`);
}

describe("boxEmlAssets", () => {
  it("externalizes data URLs and inlines them back for EML export", () => {
    const db = testDb();
    const dataUrl =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const html = `<p>Hello</p><img src="${dataUrl}" style="width:1px;height:1px;" alt="">`;

    const stored = externalizeEmlTemplateAssets(db, html);
    expect(stored).not.toContain("data:image/png;base64");
    expect(stored).toContain("/api/house-league/box-eml-assets/");

    const match = /box-eml-assets\/([0-9a-f-]+)/i.exec(stored);
    expect(match).not.toBeNull();
    const asset = getBoxEmlTemplateAsset(db, match![1]);
    expect(asset?.mimeType).toBe("image/png");

    const inlined = inlineEmlTemplateAssets(db, stored);
    expect(inlined).toContain(dataUrl);
    expect(inlined).toContain('style="width:1px;height:1px;"');
  });

  it("leaves existing asset URLs unchanged", () => {
    const db = testDb();
    const dataUrl =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const stored = externalizeEmlTemplateAssets(
      db,
      `<img src="${dataUrl}" alt="">`,
    );
    const assetId = stored.match(/box-eml-assets\/([0-9a-f-]+)/i)?.[1];
    expect(assetId).toBeTruthy();
    const url = boxEmlAssetPublicUrl(assetId!);
    const again = externalizeEmlTemplateAssets(db, `<img src="${url}" alt="">`);
    expect(again).toBe(`<img src="${url}" alt="">`);
  });
});
