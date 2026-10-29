"use client";

/**
 * Saves an attachment, saying why when it can't. A plain download link fails without a word when the
 * server answers with an error (an expired sign-in, a file gone from the message), in a browser and
 * in the desktop app alike. So the file is fetched first, which also puts it in Kite's attachment
 * cache, and only then saved through its own link (so Windows' download note keeps Kite's address:
 * "Show the email" reads it). Failures go to the app's toast through the `kite:toast` event.
 */
export async function saveAttachment(url: string, name: string) {
  try {
    const res = await fetch(url);
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(
        data.error === "reconnect"
          ? `${name} can't download until you reconnect its account in Settings → Accounts.`
          : (data.error ?? `${name} didn't download. Try again.`),
      );
    }
    await res.body?.cancel();
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    link.click();
  } catch (error) {
    const message = error instanceof Error && error.message !== "Failed to fetch" ? error.message : `${name} didn't download. Check that Kite is running, then try again.`;
    window.dispatchEvent(new CustomEvent("kite:toast", { detail: message }));
  }
}

/** For a download link's onClick: saves through `saveAttachment` instead of the bare link. */
export function onDownloadClick(url: string, name: string) {
  return (event: React.MouseEvent) => {
    event.preventDefault();
    void saveAttachment(url, name);
  };
}
