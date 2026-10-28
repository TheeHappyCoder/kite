/** Google formats its 16 letters in groups; copied text can include invisible separators. */
export const appPasswordLetters = (value: string) => value.replace(/[\s\u200B-\u200D\u2060]/g, "");
