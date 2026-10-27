import {
  decodePDFRawStream,
  EncryptedPDFError,
  LineCapStyle,
  PDFArray,
  PDFCheckBox,
  PDFDict,
  PDFDocument,
  PDFDropdown,
  PDFHexString,
  PDFName,
  PDFOptionList,
  PDFRadioGroup,
  PDFRawStream,
  PDFSignature,
  PDFString,
  PDFTextField,
  StandardFonts,
  rgb,
  type PDFField,
  type PDFFont,
} from "pdf-lib";

// Fill & sign: reads a PDF's real form fields and writes a filled copy. Pure data in, bytes out
// (pdf-lib only, no DOM), so the editor, and later "sign like last time" or an AI, drive it the same way.
// Positions are PDF user space (points, origin bottom-left), the same space pdf.js converts to.

type FieldKind = "text" | "date" | "checkbox" | "radio" | "dropdown" | "list" | "signature";

/** One widget of a form field: where it sits and what it takes. A radio group has one per choice. */
export type FormField = {
  /** `${name}#${widget index}`, unique per widget. */
  id: string;
  name: string;
  kind: FieldKind;
  page: number;
  rect: { x: number; y: number; width: number; height: number };
  /** The value this radio widget selects. */
  option?: string;
  /** Dropdown and list choices. */
  options?: string[];
  readOnly: boolean;
  multiline?: boolean;
  maxLength?: number;
  /** Acrobat date format ("dd/mm/yyyy") for text fields that hold a date. */
  dateFormat?: string;
  /** The field's tooltip (/TU), shown as a hint. */
  label?: string;
  /** Text size in points, the same in the editor and the saved copy. */
  fontSize?: number;
};

export type FieldValue = string | boolean;

export type FormInfo = {
  fields: FormField[];
  /** Current values by field name: text, the selected option ("" for none), or a checkbox's state. */
  values: Record<string, FieldValue>;
  /** Has an XFA form, which Kite can't fill field by field. */
  xfa: boolean;
  /** Already carries a digital signature, which any change breaks. */
  signed: boolean;
};

export type PlacedKind = "text" | "tick" | "date" | "signature";

/** Something placed on the page by hand. `x, y` is the bottom-left corner. */
export type Placed = {
  id: string;
  kind: PlacedKind;
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
  text?: string;
};

type FillState = {
  /** Only the fields the user changed, by name. */
  values: Record<string, FieldValue>;
  items: Placed[];
};

export class LockedPdfError extends Error {}

/** Placed text sits on a baseline this far up its box, at this share of its height. */
export const TEXT_BASELINE = 0.24;
export const TEXT_SIZE = 0.72;
/** A tick, in a 24-unit box. */
export const TICK_PATH = "M 3 13 L 9 19 L 21 5";
const INK = rgb(0.07, 0.08, 0.12);

async function load(bytes: Uint8Array) {
  try {
    return await PDFDocument.load(bytes, { updateMetadata: false });
  } catch (error) {
    if (error instanceof EncryptedPDFError) throw new LockedPdfError("locked");
    throw error;
  }
}

/** Reads the fields in the order Tab should visit them: page by page, in the page's own order. */
export async function readForm(bytes: Uint8Array): Promise<FormInfo> {
  const doc = await load(bytes);
  const form = doc.getForm();
  const pages = doc.getPages();
  const annotOrder = pages.map((page) => {
    const annots = page.node.lookup(PDFName.of("Annots"));
    const order = new Map<string, number>();
    if (annots instanceof PDFArray) annots.asArray().forEach((ref, i) => order.set(ref.toString(), i));
    return order;
  });
  const rowOrder = pages.map((page) => page.node.get(PDFName.of("Tabs"))?.toString() === "/R");

  const fields: (FormField & { order: number })[] = [];
  const values: Record<string, FieldValue> = {};
  let signed = false;

  for (const field of form.getFields()) {
    const name = field.getName();
    const kind = kindOf(field);
    if (!kind) continue;
    if (field instanceof PDFSignature && field.acroField.dict.get(PDFName.of("V"))) signed = true;

    const base = {
      name,
      kind,
      readOnly: field.isReadOnly(),
      label: tooltip(field),
    };
    if (field instanceof PDFTextField) {
      values[name] = field.getText() ?? "";
      Object.assign(base, {
        multiline: field.isMultiline(),
        maxLength: field.getMaxLength(),
        dateFormat: dateFormat(field),
        fontSize: textFontSize(field),
      });
      if (base.kind === "text" && (base as FormField).dateFormat) base.kind = "date";
    } else if (field instanceof PDFCheckBox) values[name] = field.isChecked();
    else if (field instanceof PDFRadioGroup) values[name] = field.getSelected() ?? "";
    else if (field instanceof PDFDropdown || field instanceof PDFOptionList) {
      values[name] = field.getSelected()[0] ?? "";
      Object.assign(base, { options: field.getOptions() });
    }

    const options = field instanceof PDFRadioGroup ? field.getOptions() : [];
    field.acroField.getWidgets().forEach((widget, i) => {
      const ref = doc.context.getObjectRef(widget.dict);
      const pageRef = widget.P();
      let index = pageRef ? pages.findIndex((p) => p.ref === pageRef) : -1;
      if (index < 0 && ref) {
        const found = doc.findPageForAnnotationRef(ref);
        index = found ? pages.indexOf(found) : -1;
      }
      if (index < 0) return;
      const rect = widget.getRectangle();
      if (rect.width <= 0 || rect.height <= 0) return;
      const order = rowOrder[index] ? -rect.y * 10_000 + rect.x : ((ref ? annotOrder[index].get(ref.toString()) : undefined) ?? 99_999);
      fields.push({
        ...(base as Omit<FormField, "id" | "page" | "rect">),
        id: `${name}#${i}`,
        page: index,
        rect,
        option: options[i],
        order,
      });
    });
  }

  fields.sort((a, b) => a.page - b.page || a.order - b.order);
  for (const f of fields) delete (f as Partial<typeof f>).order;
  return { fields, values, xfa: form.hasXFA(), signed };
}

function kindOf(field: PDFField): FieldKind | null {
  if (field instanceof PDFTextField) return "text";
  if (field instanceof PDFCheckBox) return "checkbox";
  if (field instanceof PDFRadioGroup) return "radio";
  if (field instanceof PDFDropdown) return "dropdown";
  if (field instanceof PDFOptionList) return "list";
  if (field instanceof PDFSignature) return "signature";
  return null;
}

function text(value: unknown): string | undefined {
  if (value instanceof PDFString || value instanceof PDFHexString) return value.decodeText();
  if (value instanceof PDFRawStream) return new TextDecoder("latin1").decode(decodePDFRawStream(value).decode());
  return undefined;
}

function tooltip(field: PDFField) {
  return text(field.acroField.dict.lookup(PDFName.of("TU")))?.trim() || undefined;
}

/** Acrobat's built-in AFDate_Format(n) choices. */
const AF_DATE_FORMATS = [
  "m/d",
  "m/d/yy",
  "mm/dd/yy",
  "mm/yy",
  "d-mmm",
  "d-mmm-yy",
  "dd-mmm-yy",
  "yy-mm-dd",
  "mmm-yy",
  "mmmm-yy",
  "mmm d, yyyy",
  "mmmm d, yyyy",
];

/** A text field formatted as a date by its Acrobat format action. */
function dateFormat(field: PDFTextField): string | undefined {
  const dicts = [field.acroField.dict, ...field.acroField.getWidgets().map((w) => w.dict)];
  for (const dict of dicts) {
    const actions = dict.lookup(PDFName.of("AA"));
    if (!(actions instanceof PDFDict)) continue;
    const format = actions.lookup(PDFName.of("F"));
    const js = format instanceof PDFDict ? text(format.lookup(PDFName.of("JS"))) : undefined;
    if (!js) continue;
    const ex = js.match(/AFDate_(?:Format|Keystroke)Ex\(\s*["']([^"']+)["']/);
    if (ex) return ex[1];
    const n = js.match(/AFDate_(?:Format|Keystroke)\(\s*(\d+)\s*\)/);
    if (n) return AF_DATE_FORMATS[Number(n[1])] ?? "dd/mm/yyyy";
  }
  return undefined;
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** Writes a date in an Acrobat format ("dd/mm/yyyy", "d mmm yyyy", ...). */
export function formatAcrobatDate(date: Date, format: string) {
  const d = date.getDate();
  const m = date.getMonth();
  const y = date.getFullYear();
  return format.replace(/yyyy|yy|mmmm|mmm|mm|m|dd|d/g, (token) => {
    switch (token) {
      case "yyyy":
        return String(y);
      case "yy":
        return String(y).slice(2);
      case "mmmm":
        return MONTHS[m];
      case "mmm":
        return MONTHS[m].slice(0, 3);
      case "mm":
        return String(m + 1).padStart(2, "0");
      case "m":
        return String(m + 1);
      case "dd":
        return String(d).padStart(2, "0");
      default:
        return String(d);
    }
  });
}

function ownFontSize(field: PDFTextField) {
  const size = field.acroField.getDefaultAppearance()?.match(/([\d.]+)\s+Tf/)?.[1];
  return size ? Number(size) : 0;
}

/** A text field's font size: its own when set and it fits, otherwise one that suits the box. */
function textFontSize(field: PDFTextField) {
  const multiline = field.isMultiline();
  const height = field.acroField.getWidgets()[0]?.getRectangle().height ?? 20;
  const own = ownFontSize(field);
  if (own > 0 && own <= (multiline ? Math.min(height * 0.8, 16) : height * 0.8)) return own;
  return multiline ? 10 : Math.max(6, Math.min(height * 0.62, 12));
}

/** Characters the built-in font can't write (it covers Western European text). */
export async function unsupportedCharacters(texts: string[]) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bad = new Set<string>();
  for (const value of texts) {
    for (const ch of value) {
      if (ch === "\n" || bad.has(ch)) continue;
      try {
        font.encodeText(ch);
      } catch {
        bad.add(ch);
      }
    }
  }
  return [...bad];
}

function drawItems(doc: PDFDocument, font: PDFFont, items: Placed[], signature: Awaited<ReturnType<PDFDocument["embedPng"]>> | null) {
  const pages = doc.getPages();
  for (const item of items) {
    const page = pages[item.page];
    if (!page) continue;
    if (item.kind === "text" || item.kind === "date") {
      const value = item.text?.trim();
      if (value)
        page.drawText(value, {
          x: item.x,
          y: item.y + item.h * TEXT_BASELINE,
          size: item.h * TEXT_SIZE,
          font,
          color: INK,
        });
    } else if (item.kind === "tick") {
      const scale = item.w / 24;
      page.drawSvgPath(TICK_PATH, {
        x: item.x,
        y: item.y + item.h,
        scale,
        borderColor: INK,
        borderWidth: 2.6 * scale,
        borderLineCap: LineCapStyle.Round,
      });
    } else if (signature) {
      page.drawImage(signature, {
        x: item.x,
        y: item.y,
        width: item.w,
        height: item.h,
      });
    }
  }
}

type FillResult = { bytes: Uint8Array; flattened: boolean };

/** A new file with the user's values and placed items. The original bytes are never changed. */
export async function applyFill(
  original: Uint8Array,
  state: FillState,
  { flatten, signature }: { flatten: boolean; signature?: Uint8Array | null },
): Promise<FillResult> {
  const doc = await load(original);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const form = doc.getForm();
  // The AcroForm copy is what viewers show once XFA is gone.
  if (form.hasXFA()) form.deleteXFA();

  for (const [name, value] of Object.entries(state.values)) {
    const field = form.getFieldMaybe(name);
    if (!field || field.isReadOnly()) continue;
    if (field instanceof PDFTextField) {
      const max = field.getMaxLength();
      // Write at the size the editor showed ("auto" would make pdf-lib fill the whole box).
      const size = textFontSize(field);
      if (size !== ownFontSize(field)) field.setFontSize(size);
      field.setText(String(value).slice(0, max ?? undefined) || undefined);
    } else if (field instanceof PDFCheckBox) {
      if (value) field.check();
      else field.uncheck();
    } else if (field instanceof PDFRadioGroup || field instanceof PDFDropdown) {
      if (value) field.select(String(value));
      else field.clear();
    } else if (field instanceof PDFOptionList) {
      if (value) field.select(String(value));
      else field.clear();
    }
  }
  if (Object.keys(state.values).length) form.updateFieldAppearances(font);

  const needsSignature = state.items.some((i) => i.kind === "signature");
  const image = needsSignature && signature ? await doc.embedPng(signature) : null;
  drawItems(doc, font, state.items, image);

  let flattened = false;
  if (flatten && form.getFields().length) {
    try {
      form.flatten({ updateFieldAppearances: false });
      flattened = true;
    } catch {
      // Some forms carry fields without an appearance; the copy is still filled, just not flattened.
    }
  }
  return {
    bytes: await doc.save({ updateFieldAppearances: false }),
    flattened,
  };
}

/**
 * A copy built from page images, for PDFs locked by their sender (pdf-lib can't rewrite encrypted
 * files). Items here are in the image page's own space (origin bottom-left, page size in points).
 */
export async function imagePdf(pages: { jpeg: Uint8Array; width: number; height: number }[], items: Placed[], signature?: Uint8Array | null) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const p of pages) {
    const page = doc.addPage([p.width, p.height]);
    page.drawImage(await doc.embedJpg(p.jpeg), {
      x: 0,
      y: 0,
      width: p.width,
      height: p.height,
    });
  }
  const image = signature && items.some((i) => i.kind === "signature") ? await doc.embedPng(signature) : null;
  drawItems(doc, font, items, image);
  return doc.save();
}
