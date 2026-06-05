import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import {
  Bold,
  ImagePlus,
  Italic,
  Link2,
  List,
  ListOrdered,
  Underline,
} from "lucide-react";
import {
  createInlineImageElement,
  dataTransferHasImageFiles,
  imageElementFromEventTarget,
  imageFileFromClipboard,
  imageFilesFromDataTransfer,
  insertNodeInEditor,
  readImageFileAsDataUrl,
  resizeHandleStyleForImage,
} from "./emlInlineImage.js";
import { api } from "./api.js";

export type EmlRichTextEditorProps = {
  html: string;
  onChange: (html: string) => void;
  ariaLabel?: string;
};

function exec(cmd: string, value?: string) {
  document.execCommand(cmd, false, value);
}

function imageInsertErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    if (err.message === "not_an_image") {
      return "Only image files can be inserted.";
    }
    if (err.message.includes("413")) {
      return "That image is too large for the server to accept.";
    }
  }
  return "Could not insert that image.";
}

export function EmlRichTextEditor({
  html,
  onChange,
  ariaLabel = "Email body",
}: EmlRichTextEditorProps) {
  const editorRef = useRef<HTMLDivElement>(null);
  const editorWrapRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const lastHtmlRef = useRef(html);
  const [dragOver, setDragOver] = useState(false);
  const [selectedImage, setSelectedImage] = useState<HTMLImageElement | null>(
    null,
  );
  const [resizeHandleStyle, setResizeHandleStyle] = useState<CSSProperties>({
    display: "none",
  });

  const syncHtml = useCallback(() => {
    const el = editorRef.current;
    if (!el) return;
    const next = el.innerHTML;
    lastHtmlRef.current = next;
    onChange(next);
  }, [onChange]);

  const updateResizeHandle = useCallback((img: HTMLImageElement | null) => {
    const wrap = editorWrapRef.current;
    if (!img || !wrap) {
      setResizeHandleStyle({ display: "none" });
      return;
    }
    const { left, top } = resizeHandleStyleForImage(img, wrap);
    setResizeHandleStyle({
      display: "block",
      left: `${left}px`,
      top: `${top}px`,
    });
  }, []);

  useEffect(() => {
    const el = editorRef.current;
    if (!el) return;
    if (html === lastHtmlRef.current && el.innerHTML === html) return;
    lastHtmlRef.current = html;
    el.innerHTML = html;
    setSelectedImage(null);
    setResizeHandleStyle({ display: "none" });
  }, [html]);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    for (const img of editor.querySelectorAll("img")) {
      img.classList.toggle("is-selected", img === selectedImage);
    }
  }, [selectedImage, html]);

  useEffect(() => {
    if (!selectedImage) return;
    const reposition = () => updateResizeHandle(selectedImage);
    reposition();
    const editor = editorRef.current;
    editor?.addEventListener("scroll", reposition);
    window.addEventListener("resize", reposition);
    return () => {
      editor?.removeEventListener("scroll", reposition);
      window.removeEventListener("resize", reposition);
    };
  }, [selectedImage, updateResizeHandle]);

  const runCommand = useCallback(
    (cmd: string, value?: string) => {
      editorRef.current?.focus();
      exec(cmd, value);
      syncHtml();
    },
    [syncHtml],
  );

  const insertLink = useCallback(() => {
    const url = window.prompt("Link URL (include https://)");
    if (!url?.trim()) return;
    runCommand("createLink", url.trim());
  }, [runCommand]);

  const selectImage = useCallback(
    (img: HTMLImageElement | null) => {
      setSelectedImage(img);
      updateResizeHandle(img);
    },
    [updateResizeHandle],
  );

  const insertImageWithSrc = useCallback(
    (
      src: string,
      width: number,
      height: number,
      point?: { x: number; y: number },
    ) => {
      const editor = editorRef.current;
      if (!editor) return;
      const img = createInlineImageElement(src, width, height);
      insertNodeInEditor(editor, img, point);
      syncHtml();
      selectImage(img);
    },
    [selectImage, syncHtml],
  );

  const insertImagesFromFiles = useCallback(
    async (files: File[], point?: { x: number; y: number }) => {
      if (files.length === 0) return;
      let dropPoint = point;
      for (const file of files) {
        try {
          const payload = await readImageFileAsDataUrl(file);
          const asset = await api<{ id: string; url: string }>(
            "/api/house-league/box-eml-assets",
            {
              method: "POST",
              body: JSON.stringify({
                dataUrl: payload.dataUrl,
                width: payload.width,
                height: payload.height,
              }),
            },
          );
          insertImageWithSrc(
            asset.url,
            payload.width,
            payload.height,
            dropPoint,
          );
          dropPoint = undefined;
        } catch (err) {
          window.alert(imageInsertErrorMessage(err));
        }
      }
    },
    [insertImageWithSrc],
  );

  const onPickImageFile = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const onImageFileInputChange = useCallback(
    (ev: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(ev.target.files ?? []);
      ev.target.value = "";
      void insertImagesFromFiles(files);
    },
    [insertImagesFromFiles],
  );

  const onEditorMouseDown = useCallback(
    (ev: React.MouseEvent) => {
      const editor = editorRef.current;
      if (!editor) return;
      if (
        ev.target instanceof HTMLElement &&
        ev.target.classList.contains("eml-inline-image-resize-handle")
      ) {
        return;
      }
      const img = imageElementFromEventTarget(ev.target, editor);
      if (img) {
        ev.preventDefault();
        selectImage(img);
        return;
      }
      selectImage(null);
    },
    [selectImage],
  );

  const onResizeHandleMouseDown = useCallback(
    (ev: React.MouseEvent) => {
      const img = selectedImage;
      if (!img) return;
      ev.preventDefault();
      ev.stopPropagation();

      const startX = ev.clientX;
      const startWidth = img.offsetWidth;
      const ratio =
        img.naturalWidth > 0
          ? img.naturalHeight / img.naturalWidth
          : startWidth > 0
            ? img.offsetHeight / startWidth
            : 1;

      const onMove = (e: MouseEvent) => {
        const width = Math.max(24, Math.round(startWidth + (e.clientX - startX)));
        img.style.width = `${width}px`;
        img.style.height = `${Math.max(1, Math.round(width * ratio))}px`;
        img.style.maxWidth = "none";
        updateResizeHandle(img);
      };

      const onUp = () => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        syncHtml();
      };

      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    },
    [selectedImage, syncHtml, updateResizeHandle],
  );

  const onEditorDragEnter = useCallback((ev: React.DragEvent) => {
    if (!dataTransferHasImageFiles(ev.dataTransfer)) return;
    ev.preventDefault();
    setDragOver(true);
  }, []);

  const onEditorDragLeave = useCallback((ev: React.DragEvent) => {
    const editor = editorRef.current;
    const related = ev.relatedTarget;
    if (editor && related instanceof Node && editor.contains(related)) return;
    setDragOver(false);
  }, []);

  const onEditorDragOver = useCallback((ev: React.DragEvent) => {
    if (!dataTransferHasImageFiles(ev.dataTransfer)) return;
    ev.preventDefault();
    ev.dataTransfer.dropEffect = "copy";
    setDragOver(true);
  }, []);

  const onEditorDrop = useCallback(
    (ev: React.DragEvent) => {
      const files = imageFilesFromDataTransfer(ev.dataTransfer);
      if (!files.length) return;
      ev.preventDefault();
      ev.stopPropagation();
      setDragOver(false);
      void insertImagesFromFiles(files, { x: ev.clientX, y: ev.clientY });
    },
    [insertImagesFromFiles],
  );

  const onEditorPaste = useCallback(
    (ev: React.ClipboardEvent) => {
      const file = imageFileFromClipboard(ev.clipboardData);
      if (!file) return;
      ev.preventDefault();
      void insertImagesFromFiles([file]);
    },
    [insertImagesFromFiles],
  );

  return (
    <div className="emails-eml-editor">
      <div
        className="emails-eml-editor-toolbar"
        role="toolbar"
        aria-label="Email formatting"
      >
        <button
          type="button"
          className="emails-eml-editor-tool"
          title="Bold"
          aria-label="Bold"
          onMouseDown={(ev) => ev.preventDefault()}
          onClick={() => runCommand("bold")}
        >
          <Bold size={16} strokeWidth={2} aria-hidden />
        </button>
        <button
          type="button"
          className="emails-eml-editor-tool"
          title="Italic"
          aria-label="Italic"
          onMouseDown={(ev) => ev.preventDefault()}
          onClick={() => runCommand("italic")}
        >
          <Italic size={16} strokeWidth={2} aria-hidden />
        </button>
        <button
          type="button"
          className="emails-eml-editor-tool"
          title="Underline"
          aria-label="Underline"
          onMouseDown={(ev) => ev.preventDefault()}
          onClick={() => runCommand("underline")}
        >
          <Underline size={16} strokeWidth={2} aria-hidden />
        </button>
        <span className="emails-eml-editor-tool-sep" aria-hidden />
        <button
          type="button"
          className="emails-eml-editor-tool"
          title="Bulleted list"
          aria-label="Bulleted list"
          onMouseDown={(ev) => ev.preventDefault()}
          onClick={() => runCommand("insertUnorderedList")}
        >
          <List size={16} strokeWidth={2} aria-hidden />
        </button>
        <button
          type="button"
          className="emails-eml-editor-tool"
          title="Numbered list"
          aria-label="Numbered list"
          onMouseDown={(ev) => ev.preventDefault()}
          onClick={() => runCommand("insertOrderedList")}
        >
          <ListOrdered size={16} strokeWidth={2} aria-hidden />
        </button>
        <button
          type="button"
          className="emails-eml-editor-tool"
          title="Insert link"
          aria-label="Insert link"
          onMouseDown={(ev) => ev.preventDefault()}
          onClick={insertLink}
        >
          <Link2 size={16} strokeWidth={2} aria-hidden />
        </button>
        <button
          type="button"
          className="emails-eml-editor-tool"
          title="Insert image"
          aria-label="Insert image"
          onMouseDown={(ev) => ev.preventDefault()}
          onClick={onPickImageFile}
        >
          <ImagePlus size={16} strokeWidth={2} aria-hidden />
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          className="emails-eml-editor-image-input"
          tabIndex={-1}
          aria-hidden
          onChange={onImageFileInputChange}
        />
      </div>
      <div ref={editorWrapRef} className="emails-eml-editor-body-wrap">
        <div
          ref={editorRef}
          className={
            dragOver
              ? "emails-eml-editor-body card is-dragover"
              : "emails-eml-editor-body card"
          }
          contentEditable
          role="textbox"
          aria-multiline="true"
          aria-label={ariaLabel}
          suppressContentEditableWarning
          onInput={syncHtml}
          onBlur={syncHtml}
          onMouseDown={onEditorMouseDown}
          onDragEnter={onEditorDragEnter}
          onDragLeave={onEditorDragLeave}
          onDragOver={onEditorDragOver}
          onDrop={onEditorDrop}
          onPaste={onEditorPaste}
        />
        <span
          className="eml-inline-image-resize-handle"
          style={resizeHandleStyle}
          role="presentation"
          aria-hidden
          onMouseDown={onResizeHandleMouseDown}
        />
      </div>
      <p className="emails-eml-editor-image-hint">
        Drag an image into the editor (or paste / use Insert image). Click an
        image, then drag the corner handle to resize. Images upload immediately
        at full resolution; save stores references so templates stay small.
      </p>
    </div>
  );
}
