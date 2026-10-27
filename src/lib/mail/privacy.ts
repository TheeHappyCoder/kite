// Privacy helpers shared by the server (stripping pixels when a message is stored) and the reader
// (naming what was stripped, cleaning tracking out of links). Plain string work, no DOM, linear.

/** Email and analytics services, matched against a tracker image's host or address. */
const SERVICES: [RegExp, string][] = [
  [/list-manage\.com|mailchimp|mcusercontent/, "Mailchimp"],
  // SendGrid's branded link domains look like url1234.mail.example.com.
  [/sendgrid\.net|^url\d+\./, "SendGrid"],
  [/hubspot|hs-analytics|hsforms|hubspotlinks|hubspotemail/, "HubSpot"],
  [/mailgun/, "Mailgun"],
  [/sparkpost|spgo\.io/, "SparkPost"],
  [/exacttarget|exct\.net|sfmc|marketingcloudapis/, "Salesforce Marketing Cloud"],
  [/pardot/, "Pardot"],
  [/google-analytics\.com|googletagmanager/, "Google Analytics"],
  [/substack/, "Substack"],
  [/beehiiv/, "beehiiv"],
  [/convertkit|ck\.page|kit-mail/, "Kit"],
  [/klaviyo|klclick/, "Klaviyo"],
  [/customer\.io|customeriomail/, "Customer.io"],
  [/braze|appboy/, "Braze"],
  [/iterable/, "Iterable"],
  [/mktoresp|mktossl|marketo|mkt\d+\.com/, "Marketo"],
  [/eloqua|en25\.com/, "Oracle Eloqua"],
  [/responsys|rsys\d*\.(net|com)/, "Oracle Responsys"],
  [/sailthru/, "Sailthru"],
  [/mjt\.lu|mailjet/, "Mailjet"],
  [/rs6\.net|constantcontact/, "Constant Contact"],
  [/createsend|cmail\d+\.com/, "Campaign Monitor"],
  [/mailerlite|mlsend/, "MailerLite"],
  [/activehosted|activecampaign/, "ActiveCampaign"],
  [/getdrip|drip\.com/, "Drip"],
  [/silverpop|goacoustic/, "Acoustic"],
  [/mixpanel/, "Mixpanel"],
  [/intercom/, "Intercom"],
  [/pstmrk\.it|postmarkapp/, "Postmark"],
  [/mandrillapp/, "Mandrill"],
  [/awstrack\.me|amazonses/, "Amazon SES"],
  [/lemlist/, "Lemlist"],
  [/mailtrack/, "Mailtrack"],
  [/superhuman/, "Superhuman"],
  [/yesware/, "Yesware"],
  [/mixmax/, "Mixmax"],
  [/outreach\.io/, "Outreach"],
  [/linkedin\.com\/emimp|licdn\.com\/.*emimp/, "LinkedIn"],
  [/bit\.ly/, "Bitly"],
  [/secureserver\.net/, "GoDaddy"],
  [/knock\.app/, "Knock"],
];

/** The service behind a tracker host or address, if Kite knows it. */
export function serviceFor(hostOrUrl: string): string | null {
  const value = hostOrUrl.toLowerCase();
  return SERVICES.find(([pattern]) => pattern.test(value))?.[1] ?? null;
}

const looksLikeHost = (value: string) => /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(value);

/**
 * What the reader shows for a message's stripped trackers: known services by name (once each),
 * and anything else as unknown hosts, kept for the details. Older messages stored raw hosts, so
 * those are named again here.
 */
export function describeTrackers(stored: string[] | undefined) {
  const named = new Set<string>();
  const unknown = new Set<string>();
  for (const entry of stored ?? []) {
    if (!looksLikeHost(entry)) named.add(entry);
    else {
      const service = serviceFor(entry);
      if (service) named.add(service);
      else unknown.add(entry);
    }
  }
  return { named: [...named], unknown: [...unknown], total: named.size + unknown.size };
}

const SECOND_LEVEL = new Set(["co", "com", "org", "net", "ac", "gov", "edu", "ltd", "plc"]);

/** mail.account.netflix.com -> netflix.com; shop.co.za stays shop.co.za. */
function registrableDomain(domain: string) {
  const labels = domain.toLowerCase().replace(/\.$/, "").split(".");
  const keep = labels.length > 2 && labels.at(-1)!.length === 2 && SECOND_LEVEL.has(labels.at(-2)!) ? 3 : 2;
  return labels.slice(-keep).join(".");
}

/**
 * Reads the receiving server's Authentication-Results (Gmail's own, `mx.google.com`): DMARC's
 * verdict when there is one, else whether DKIM passed for the From domain. "fail" means the
 * domain in From didn't send it: a likely forgery.
 */
export function senderAuth(results: string[], fromEmail: string): { result: "pass" | "fail" | "none"; domain?: string } {
  const fromDomain = fromEmail.split("@")[1]?.toLowerCase() ?? "";
  const own = results.filter((r) => /^\s*mx\.google\.com\b/i.test(r));
  const text = (own.length ? own : results).join(";");
  const dmarc = text.match(/\bdmarc=(\w+)(?:[^;]*?header\.from=([^\s;]+))?/i);
  if (dmarc) {
    const verdict = dmarc[1].toLowerCase();
    const domain = (dmarc[2] ?? fromDomain).toLowerCase();
    if (verdict === "pass") return { result: "pass", domain };
    if (verdict === "fail") return { result: "fail", domain };
  }
  for (const match of text.matchAll(/\bdkim=pass\b[^;]*?header\.(?:i|d)=@?([^\s;]+)/gi)) {
    if (fromDomain && registrableDomain(match[1]) === registrableDomain(fromDomain)) return { result: "pass", domain: registrableDomain(fromDomain) };
  }
  return { result: "none" };
}

/** Query parameters that only exist to track the click (campaign tags, subscriber ids, ad click ids). */
const TRACKING_PARAMS = new Set([
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "utm_id",
  "utm_name",
  "utm_brand",
  "utm_social",
  "utm_social-type",
  "mc_cid",
  "mc_eid",
  "_hsenc",
  "_hsmi",
  "__hstc",
  "__hssc",
  "__hsfp",
  "hsctatracking",
  "mkt_tok",
  "gclid",
  "dclid",
  "gbraid",
  "wbraid",
  "fbclid",
  "msclkid",
  "yclid",
  "twclid",
  "ttclid",
  "igshid",
  "ck_subscriber_id",
  "_kx",
  "oly_enc_id",
  "oly_anon_id",
  "vero_id",
  "vero_conv",
  "ml_subscriber",
  "ml_subscriber_hash",
  "sc_eh",
  "sc_cid",
  "ss_source",
  "ss_campaign_id",
  "ss_email_id",
  "trk_msg",
  "trk_contact",
  "trk_module",
  "trk_sid",
]);

/**
 * Links Kite never changes: anything that signs you in, confirms or resets something, or
 * unsubscribes. Those are often signed, and a broken one is worse than a tracked one.
 */
const HANDS_OFF = /unsub|opt-?out|optout|preferences|manage[-_]?subscription|login|log-in|signin|sign-in|sign_in|verify|verification|confirm|activate|reset|password|magic|token|auth|oauth|invite|accept|approve|redeem|download/i;

/**
 * Redirectors that carry the real address in a plain parameter: the link is replaced by that
 * address. Click trackers that hide it (Mailchimp, SendGrid) can't be unwrapped and stay as they are.
 */
const REDIRECTORS: { host: RegExp; path?: RegExp; params: string[] }[] = [
  { host: /^(www\.)?google\.[a-z.]+$/, path: /^\/url$/, params: ["q", "url"] },
  { host: /^l\.(facebook|instagram|messenger)\.com$/, params: ["u"] },
  { host: /^lm?\.facebook\.com$/, params: ["u"] },
  { host: /\.safelinks\.protection\.outlook\.com$/, params: ["url"] },
  { host: /^(www\.)?youtube\.com$/, path: /^\/redirect$/, params: ["q"] },
  { host: /^out\.reddit\.com$/, params: ["url"] },
  { host: /^(www\.)?linkedin\.com$/, path: /^\/redir\/redirect/, params: ["url"] },
  { host: /^slack-redir\.net$/, params: ["url"] },
];

function decodeParam(value: string) {
  try {
    return decodeURIComponent(value.replace(/\+/g, " "));
  } catch {
    return value;
  }
}

/** The address a known redirector points to, or null. */
function unwrap(url: URL): string | null {
  const rule = REDIRECTORS.find((r) => r.host.test(url.hostname) && (!r.path || r.path.test(url.pathname)));
  if (!rule) return null;
  for (const name of rule.params) {
    const target = url.searchParams.get(name);
    if (target && /^https?:\/\//i.test(target)) {
      try {
        return new URL(target).href;
      } catch {
        return null;
      }
    }
  }
  return null;
}

/**
 * Removes tracking parameters from one address, leaving everything else byte for byte (signed
 * query strings stay valid). Returns null when nothing changed or the link is hands-off.
 */
function cleanUrl(href: string): string | null {
  if (!/^https?:\/\//i.test(href) || HANDS_OFF.test(href)) return null;
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  const target = unwrap(url);
  if (target) {
    if (HANDS_OFF.test(target)) return null;
    return cleanUrl(target) ?? target;
  }
  const queryStart = href.indexOf("?");
  if (queryStart < 0) return null;
  const hashStart = href.indexOf("#", queryStart);
  const query = href.slice(queryStart + 1, hashStart < 0 ? undefined : hashStart);
  const hash = hashStart < 0 ? "" : href.slice(hashStart);
  const pairs = query.split("&");
  const kept = pairs.filter((pair) => !TRACKING_PARAMS.has(decodeParam(pair.split("=")[0]).toLowerCase()));
  if (kept.length === pairs.length) return null;
  return href.slice(0, queryStart) + (kept.length ? `?${kept.join("&")}` : "") + hash;
}

const decodeAttr = (value: string) => value.replace(/&amp;/gi, "&").replace(/&#38;/g, "&");
const encodeAttr = (value: string) => value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");

const hrefOf = (tag: string) => {
  const m = tag.match(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i);
  return m ? decodeAttr((m[1] ?? m[2] ?? m[3] ?? "").trim()) : "";
};

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
};

/** The site a link's visible text names, when the text looks like an address ("www.bank.com", "https://bank.com/login"). */
function namedSite(text: string) {
  const plain = text
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;|&#160;/gi, " ")
    .trim();
  if (!plain || plain.length > 200) return "";
  const m = plain.match(/^(?:https?:\/\/)?(?:www\.)?((?:[a-z0-9-]+\.)+[a-z]{2,})(?:[/:?#]\S*)?$/i);
  return m ? m[1].toLowerCase() : "";
}

/**
 * Protects an email's links: cleans tracking out of them (when `clean`), and flags links whose
 * visible text names one site but go to another (a common phishing trick) with a title that
 * says where they really go. Counts both.
 */
export function protectLinks(html: string, clean: boolean): { html: string; cleaned: number; misleading: number } {
  let cleaned = 0;
  let misleading = 0;
  let out = html;
  if (clean) {
    out = out.replace(/<a\b[^>]*>/gi, (tag) =>
      tag.replace(/(\bhref\s*=\s*)(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i, (attr, prefix: string, dq?: string, sq?: string, bare?: string) => {
        const next = cleanUrl(decodeAttr((dq ?? sq ?? bare ?? "").trim()));
        if (!next) return attr;
        cleaned++;
        return `${prefix}"${encodeAttr(next)}"`;
      }),
    );
  }
  // Link text that reads as an address is short: the bounded match keeps this scan linear.
  out = out.replace(/(<a\b[^>]*>)([^<]{1,200}|(?:<(?!\/?a\b)[^>]*>|[^<]){1,300}?)(<\/a>)/gi, (whole, open: string, text: string, close: string) => {
    const named = namedSite(text);
    const host = hostOf(hrefOf(open));
    if (!named || !host || registrableDomain(named) === registrableDomain(host)) return whole;
    misleading++;
    const flagged = open
      .replace(/\stitle\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/i, "")
      .replace(/^<a\b/i, `<a title="${encodeAttr(`Careful: this goes to ${host}, not ${named}`)}" data-kite-misleading`);
    return flagged + text + close;
  });
  return { html: cleaned || misleading ? out : html, cleaned, misleading };
}

/**
 * Turns remote images into placeholders until the user loads them: `src` becomes
 * `data-kite-hidden`, so nothing is requested and the box (with its alt text) keeps the layout.
 */
export function holdRemoteImages(html: string) {
  return html.replace(/<img\b[^>]*>/gi, (tag) => {
    const held = tag.replace(/\bsrc(\s*=\s*["']?https?:)/i, "data-kite-hidden$1");
    return held === tag ? tag : held.replace(/^<img\b/i, "<img data-kite-held");
  });
}
