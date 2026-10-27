import { PDFDocument, PDFName, PDFString, rgb, StandardFonts } from "pdf-lib";

// A sample job card for demo mode (demo attachments have no bytes): a fillable top half with
// text, date, checkbox, radio and dropdown fields, and a flat bottom half to sign by hand.

export async function samplePdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle("Sample job card");
  const page = doc.addPage([595, 842]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const form = doc.getForm();
  const ink = rgb(0.1, 0.1, 0.12);
  const muted = rgb(0.42, 0.42, 0.46);

  page.drawText("Harbour Plumbing", {
    x: 50,
    y: 780,
    size: 20,
    font: bold,
    color: ink,
  });
  page.drawText("Job card · sample form for trying Fill & sign", {
    x: 50,
    y: 760,
    size: 10,
    font,
    color: muted,
  });

  const label = (text: string, x: number, y: number) => page.drawText(text, { x, y, size: 10, font, color: ink });
  const textField = (name: string, x: number, y: number, width: number) => {
    const field = form.createTextField(name);
    field.addToPage(page, {
      x,
      y,
      width,
      height: 20,
      borderWidth: 0.6,
      borderColor: muted,
    });
    field.setFontSize(10);
    return field;
  };

  label("Customer name", 50, 718);
  textField("customer.name", 160, 712, 385);
  label("Address", 50, 688);
  textField("customer.address", 160, 682, 385);
  label("Phone", 50, 658);
  textField("customer.phone", 160, 652, 150);

  label("Date of visit", 330, 658);
  const date = textField("visit.date", 400, 652, 145);
  // Acrobat's date format action, so the editor offers a date picker for it.
  const js = doc.context.obj({
    S: PDFName.of("JavaScript"),
    JS: PDFString.of('AFDate_FormatEx("dd/mm/yyyy");'),
  });
  date.acroField.dict.set(PDFName.of("AA"), doc.context.obj({ F: js }));

  label("Work done", 50, 620);
  const work = form.createTextField("work.description");
  work.enableMultiline();
  // After addToPage: the font size lives in the default appearance (/DA) it creates.
  work.addToPage(page, {
    x: 160,
    y: 560,
    width: 385,
    height: 70,
    borderWidth: 0.6,
    borderColor: muted,
  });
  work.setFontSize(10);

  label("Job type", 50, 530);
  const type = form.createRadioGroup("job.type");
  [
    ["Repair", 160],
    ["Installation", 260],
    ["Inspection", 380],
  ].forEach(([option, x]) => {
    type.addOptionToPage(String(option), page, {
      x: Number(x),
      y: 526,
      width: 12,
      height: 12,
      borderWidth: 0.6,
      borderColor: muted,
    });
    label(String(option), Number(x) + 18, 528);
  });

  label("Payment", 50, 500);
  const payment = form.createDropdown("payment.method");
  payment.addOptions(["Card", "Cash", "EFT", "Account"]);
  payment.addToPage(page, {
    x: 160,
    y: 494,
    width: 150,
    height: 20,
    borderWidth: 0.6,
    borderColor: muted,
  });

  const done = form.createCheckBox("job.complete");
  done.addToPage(page, {
    x: 50,
    y: 462,
    width: 12,
    height: 12,
    borderWidth: 0.6,
    borderColor: muted,
  });
  label("Work completed to my satisfaction", 70, 464);

  page.drawLine({
    start: { x: 50, y: 430 },
    end: { x: 545, y: 430 },
    thickness: 0.5,
    color: muted,
  });
  page.drawText("Customer sign-off (flat: place your signature, name and date)", { x: 50, y: 405, size: 10, font: bold, color: ink });
  [
    ["Signature", 340],
    ["Name", 300],
    ["Date", 260],
  ].forEach(([text, y]) => {
    label(String(text), 50, Number(y));
    page.drawLine({
      start: { x: 120, y: Number(y) - 2 },
      end: { x: 400, y: Number(y) - 2 },
      thickness: 0.5,
      color: muted,
    });
  });

  return doc.save();
}
