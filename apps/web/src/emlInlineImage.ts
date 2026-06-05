export type InlineImagePayload = {
  dataUrl: string;
  width: number;
  height: number;
};

export function applyInlineImageSize(
  img: HTMLImageElement,
  width: number,
  height: number,
): void {
  img.style.width = `${Math.max(1, Math.round(width))}px`;
  img.style.height = `${Math.max(1, Math.round(height))}px`;
  img.style.maxWidth = "none";
  img.style.display = "block";
  img.style.margin = "0.5em 0";
}

export function createInlineImageElement(
  dataUrl: string,
  width: number,
  height: number,
): HTMLImageElement {
  const img = document.createElement("img");
  img.src = dataUrl;
  img.setAttribute("alt", "");
  img.draggable = false;
  applyInlineImageSize(img, width, height);
  return img;
}

export function readImageDimensions(
  dataUrl: string,
): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      resolve({
        width: img.naturalWidth || img.width,
        height: img.naturalHeight || img.height,
      });
    };
    img.onerror = () => reject(new Error("image_load_failed"));
    img.src = dataUrl;
  });
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("image_read_failed"));
    reader.readAsDataURL(file);
  });
}

/** Read an image file at full resolution and return a data URL plus pixel dimensions. */
export async function readImageFileAsDataUrl(file: File): Promise<InlineImagePayload> {
  if (!file.type.startsWith("image/")) {
    throw new Error("not_an_image");
  }
  const dataUrl = await readFileAsDataUrl(file);
  const { width, height } = await readImageDimensions(dataUrl);
  return { dataUrl, width, height };
}

function rangeFromPoint(x: number, y: number): Range | null {
  const doc = document;
  if (typeof doc.caretRangeFromPoint === "function") {
    return doc.caretRangeFromPoint(x, y);
  }
  const pos = doc.caretPositionFromPoint?.(x, y);
  if (!pos) return null;
  const range = doc.createRange();
  range.setStart(pos.offsetNode, pos.offset);
  range.collapse(true);
  return range;
}

function selectionRangeInEditor(editor: HTMLElement): Range | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  if (!editor.contains(range.commonAncestorContainer)) return null;
  return range;
}

export function insertNodeInEditor(
  editor: HTMLElement,
  node: Node,
  point?: { x: number; y: number },
): void {
  editor.focus();
  let range =
    point != null ? rangeFromPoint(point.x, point.y) : selectionRangeInEditor(editor);
  if (range && !editor.contains(range.commonAncestorContainer)) {
    range = null;
  }
  if (!range) {
    range = document.createRange();
    range.selectNodeContents(editor);
    range.collapse(false);
  } else {
    range.collapse(true);
  }

  range.insertNode(node);
  const after = document.createRange();
  after.setStartAfter(node);
  after.collapse(true);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(after);
}

export function imageElementFromEventTarget(
  target: EventTarget | null,
  editor: HTMLElement,
): HTMLImageElement | null {
  if (!(target instanceof Node)) return null;
  if (target instanceof HTMLImageElement && editor.contains(target)) {
    return target;
  }
  if (target instanceof Element) {
    const img = target.closest("img");
    if (img instanceof HTMLImageElement && editor.contains(img)) {
      return img;
    }
  }
  return null;
}

export function resizeHandleStyleForImage(
  img: HTMLImageElement,
  wrap: HTMLElement,
): { left: number; top: number } {
  const imgRect = img.getBoundingClientRect();
  const wrapRect = wrap.getBoundingClientRect();
  const handleSize = 12;
  return {
    left: imgRect.right - wrapRect.left - handleSize / 2,
    top: imgRect.bottom - wrapRect.top - handleSize / 2,
  };
}

export function dataTransferHasImageFiles(dt: DataTransfer | null): boolean {
  if (!dt) return false;
  if (Array.from(dt.types).includes("Files")) return true;
  return Array.from(dt.items).some(
    (item) => item.kind === "file" && item.type.startsWith("image/"),
  );
}

export function imageFilesFromDataTransfer(dt: DataTransfer | null): File[] {
  if (!dt) return [];
  const out: File[] = [];
  for (const file of Array.from(dt.files)) {
    if (file.type.startsWith("image/")) out.push(file);
  }
  return out;
}

export function imageFileFromClipboard(dt: DataTransfer | null): File | null {
  if (!dt) return null;
  for (const file of Array.from(dt.files)) {
    if (file.type.startsWith("image/")) return file;
  }
  for (const item of Array.from(dt.items)) {
    if (item.kind === "file" && item.type.startsWith("image/")) {
      const file = item.getAsFile();
      if (file) return file;
    }
  }
  return null;
}
