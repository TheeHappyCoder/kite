import { NextResponse } from "next/server";
import * as z from "zod";
import { clearUsageForAccount } from "@/server/ai-usage";
import { clearAttachmentCache } from "@/server/attachments";
import { ACCOUNT_COLORS, AccountFaceChoice, faceAsset, facePhoto } from "@/lib/mail/account-face";
import { getAsset, removeAsset } from "@/server/assets";
import { type AccountRow, compactSearchIndex, deleteAccount, faceInUse, getAccount, listAccounts, setAccountColor, setAccountFace, setAccountNickname } from "@/server/db";
import { rejectCrossSite } from "@/server/guard";
import { eventSource, usesMailCalendar } from "@/server/events";
import { removeSignature } from "@/server/settings";
import { googleLinked } from "@/server/mail/google/link";
import { contactPhotosFor, googleLinkable, oauthBySlug, providerFor } from "@/server/providers/registry";
import { ensureSyncLoop, syncIdle } from "@/server/sync";

export const runtime = "nodejs";

/** The user's pick wins; else the provider's photo from Kite's avatar cache (the version changes with it, so browsers refetch). */
function photoOf({ email, picture, face }: Pick<AccountRow, "email" | "picture" | "face">) {
  return facePhoto(face, picture ? `/api/avatar?email=${encodeURIComponent(email)}&v=${picture}` : null);
}

export async function GET() {
  ensureSyncLoop();
  const accounts = listAccounts().map(({ id, provider, email, name, color, picture, nickname, face }) => {
    // Gmail over IMAP: whether its optional Google sign-in (calendar and photos) is connected; undefined elsewhere.
    const googleLink = googleLinkable({ id, provider }) ? googleLinked(id) : undefined;
    // An account that could have them once it connects Google counts as missing the permission.
    const lacking = googleLink === false ? false : undefined;
    const calendar = eventSource({ id, provider });
    return {
      id,
      provider,
      email,
      name,
      nickname: nickname || null,
      color,
      face,
      photo: photoOf({ email, picture, face }),
      providerPhoto: photoOf({ email, picture, face: null }),
      // Undefined where the provider has no contact photos, so only its accounts are asked to reconnect.
      contactPhotos: contactPhotosFor({ id, provider })?.enabled(id) ?? lacking,
      reconnectFor: providerFor({ provider }).labels?.reconnectFor?.(id) ?? null,
      // Undefined where there are no events at all (a provider Kite only signs in to).
      calendar: calendar ? !calendar.missing(id) : lacking,
      // Events come from invites in its mail and Add to calendar stays in Kite (server/mail-calendar.ts).
      mailCalendar: usesMailCalendar({ id, provider }) || undefined,
      service: providerFor({ provider }).serviceName?.(id) ?? null,
      organisesLike: providerFor({ provider }).organisesLike?.(id) ?? null,
      googleLink,
    };
  });
  return NextResponse.json({ accounts, googleConfigured: !!oauthBySlug("google")?.auth.configured() });
}

const Patch = z.object({
  id: z.string().min(1),
  nickname: z.string().trim().max(40).nullable().optional(),
  color: z.enum(ACCOUNT_COLORS).optional(),
  face: AccountFaceChoice.optional(),
});

/** An uploaded picture goes once no account shows it. */
async function dropFace(face: string | null) {
  const asset = faceAsset(face);
  if (asset && !faceInUse(face!)) await removeAsset(asset);
}

/** How the account looks in Kite: its local name, ring colour and picture. Never sent to the provider. */
export async function PATCH(request: Request) {
  const rejected = rejectCrossSite(request);
  if (rejected) return rejected;
  const parsed = Patch.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    const name = parsed.error.issues.some((issue) => issue.path[0] === "nickname");
    return NextResponse.json({ error: name ? "Names can be up to 40 characters." : "Kite couldn't save that change." }, { status: 400 });
  }
  const { id, color, face } = parsed.data;
  const account = getAccount(id);
  if (!account) return NextResponse.json({ error: "Unknown account" }, { status: 404 });
  if (parsed.data.nickname !== undefined) setAccountNickname(id, parsed.data.nickname || null);
  if (color) setAccountColor(id, color);
  if (face !== undefined && face !== account.face) {
    const asset = faceAsset(face);
    if (asset && !(await getAsset(asset))) return NextResponse.json({ error: "That picture is gone. Upload it again." }, { status: 400 });
    setAccountFace(id, face);
    await dropFace(account.face);
  }
  const after = getAccount(id)!;
  return NextResponse.json({ ok: true, nickname: after.nickname, color: after.color, face: after.face, photo: photoOf(after), providerPhoto: photoOf({ ...after, face: null }) });
}

/**
 * Disconnects an account: revokes Kite's access at the provider and erases everything Kite kept from it
 * (mail, drafts, scheduled sends, collected rows and codes, cached attachments, its signature).
 */
export async function DELETE(request: Request) {
  const rejected = rejectCrossSite(request);
  if (rejected) return rejected;
  const id = new URL(request.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });
  const account = getAccount(id);
  if (account) {
    // Filters Kite made at the provider go first: once access is revoked, Kite can't remove them.
    const provider = providerFor(account);
    await provider.filters?.removeAccount(id).catch(() => {});
    await provider.auth.revoke(id);
  }
  await syncIdle(id);
  deleteAccount(id);
  if (account) await dropFace(account.face);
  clearUsageForAccount(id);
  removeSignature(id);
  // Cached files are named by a hash, so the whole cache goes (it refills on demand).
  await clearAttachmentCache();
  compactSearchIndex();
  return NextResponse.json({ ok: true });
}
