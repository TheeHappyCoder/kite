import "server-only";

import { NextResponse } from "next/server";
import { LabelError, ProviderError, ReconnectRequired } from "./mail/errors";
import { AttachmentError } from "./attachments";
import { OutgoingError } from "./outgoing";
import { UploadError } from "./uploads";
import { InviteError } from "./calendar";
import { EventError } from "./events";
import * as z from "zod";

export function errorResponse(error: unknown) {
  if (error instanceof ReconnectRequired) {
    return NextResponse.json({ error: "reconnect", accountId: error.accountId }, { status: 401 });
  }
  // Problems the user can fix (a missing file, a message over the size limit) are explained as they are.
  if (error instanceof AttachmentError || error instanceof OutgoingError || error instanceof UploadError || error instanceof LabelError || error instanceof EventError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }
  if (error instanceof InviteError) return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
  if (error instanceof z.ZodError) return NextResponse.json({ error: error.issues[0]?.message ?? "That didn't look right" }, { status: 400 });
  if (error instanceof Error && ["RuleError", "ExpectError", "CollectionError"].includes(error.name)) return NextResponse.json({ error: error.message }, { status: 400 });
  if (error instanceof ProviderError) {
    console.error(error.message);
    return NextResponse.json({ error: `${error.service} request failed` }, { status: error.status === 404 ? 404 : 502 });
  }
  console.error(error);
  return NextResponse.json({ error: "Something went wrong" }, { status: 500 });
}
