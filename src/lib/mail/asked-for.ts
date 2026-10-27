// Documents a message asks you for ("please send a copy of your ID"), found by plain
// keywords. Only used to order the compose file picker: matching files move up with a
// small note. Nothing is attached or guessed beyond that.

export type AskedKind = { id: string; label: string };

type Rule = AskedKind & {
  /** Phrases in the message text (lowercase, matched on word boundaries). */
  text: string[];
  /** Words in a file name (lowercase, matched against the name's words). */
  names: string[];
};

const RULES: Rule[] = [
  {
    id: "id",
    label: "ID copy",
    text: ["id copy", "copy of your id", "copy of my id", "certified id", "id document", "identity document", "id book", "smart id", "passport", "driver's licence", "drivers licence", "driver's license", "drivers license"],
    names: ["id", "passport", "licence", "license", "identity", "smartid"],
  },
  { id: "payslip", label: "payslip", text: ["payslip", "payslips", "pay slip", "pay slips", "salary slip", "proof of income"], names: ["payslip", "payslips", "salary"] },
  {
    id: "address",
    label: "proof of address",
    text: ["proof of address", "proof of residence", "utility bill", "municipal account"],
    names: ["address", "residence", "utility", "municipal", "poa", "por"],
  },
  { id: "invoice", label: "invoice", text: ["invoice", "invoices", "tax invoice"], names: ["invoice", "invoices", "inv"] },
  { id: "statement", label: "statement", text: ["statement", "statements", "bank statement", "bank statements"], names: ["statement", "statements"] },
  { id: "quote", label: "quote", text: ["quotation", "send a quote", "send me a quote", "send us a quote", "the quote"], names: ["quote", "quotation"] },
  { id: "receipt", label: "receipt", text: ["receipt", "receipts", "proof of payment"], names: ["receipt", "receipts", "pop", "payment"] },
  { id: "tax", label: "tax certificate", text: ["irp5", "it3a", "tax certificate", "tax clearance", "tax number"], names: ["irp5", "it3a", "tax"] },
  { id: "contract", label: "contract", text: ["contract", "signed agreement", "the agreement", "lease agreement"], names: ["contract", "agreement", "lease"] },
  { id: "cv", label: "CV", text: ["your cv", "a cv", "updated cv", "resume", "curriculum vitae"], names: ["cv", "resume"] },
];

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const PATTERNS = RULES.map((rule) => ({ rule, pattern: new RegExp(`(?:^|[^a-z0-9])(?:${rule.text.map(escape).join("|")})(?![a-z0-9])`, "i") }));

/** The kinds of document a message's new text mentions. */
export function askedFor(text: string): AskedKind[] {
  const normal = text.replace(/[’‘]/g, "'");
  return PATTERNS.filter(({ pattern }) => pattern.test(normal)).map(({ rule }) => ({ id: rule.id, label: rule.label }));
}

/** The asked-for kind a file name matches, if any. Names are split into words, so "id" never matches "video". */
export function askedMatch(fileName: string, kinds: AskedKind[]): AskedKind | null {
  if (!kinds.length) return null;
  // Split camel case and digits too: "MyPayslip2024.pdf" -> my payslip 2024.
  const words = new Set(
    fileName
      .replace(/\.[A-Za-z0-9]{1,5}$/, "")
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .toLowerCase()
      .split(/[^a-z0-9]+|(?<=[a-z])(?=[0-9])|(?<=[0-9])(?=[a-z])/)
      .filter(Boolean),
  );
  for (const kind of kinds) {
    const rule = RULES.find((r) => r.id === kind.id);
    if (rule?.names.some((n) => words.has(n))) return kind;
  }
  return null;
}
