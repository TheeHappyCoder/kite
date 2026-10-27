"use client";

import { useEffect, useState } from "react";
import { formatBytes } from "@/lib/format";
import type { Preferences, PreferencesPatch } from "@/lib/settings";
import { languageName, MODEL_LANGUAGES, ownLanguage, type TranslateState } from "@/lib/translate/languages";
import { Select } from "../ui/select";
import { Group, Note, Row, ToggleRow, quietButtonClass } from "./settings-ui";

/**
 * Settings → Appearance → Translate: which language messages are translated into, whether the
 * reader offers it, and the languages downloaded to this computer (with what they take). Reads only
 * what's on this computer: opening it never contacts Mozilla.
 */
export function TranslateGroup({ preferences, onPreferences }: { preferences: Preferences; onPreferences: (patch: PreferencesPatch) => unknown }) {
  const { to, offer } = preferences.translate;
  const target = to || ownLanguage();
  const [state, setState] = useState<{ key: string; data: TranslateState } | null>(null);
  const [round, setRound] = useState(0);
  const key = `${target}:${round}`;
  useEffect(() => {
    let live = true;
    fetch(`/api/translate?to=${target}&local=1`)
      .then((res) => (res.ok ? (res.json() as Promise<TranslateState>) : null))
      .then((data) => {
        if (live && data) setState({ key, data });
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [target, key]);
  const installed = state?.data.languages.filter((l) => l.installed) ?? [];

  const remove = async (code: string) => {
    await fetch(`/api/translate?language=${code}&to=${target}`, { method: "DELETE" }).catch(() => null);
    setRound((r) => r + 1);
  };

  const options = [
    { value: "", label: `Your language (${languageName(ownLanguage())})` },
    ...MODEL_LANGUAGES.map((code) => ({ value: code, label: languageName(code) })).sort((a, b) => a.label.localeCompare(b.label)),
  ];

  return (
    <Group title="Translate" description="On this PC, with Firefox's translation engine. Message text never leaves your computer.">
      <Row
        label="Translate into"
        detail="Messages in other languages are translated into this one."
        control={<Select label="Translate into" value={to} options={options} onChange={(value) => void onPreferences({ translate: { to: value } })} />}
      />
      <ToggleRow
        label="Offer to translate"
        detail={offer ? "A line under a message in another language, with Translate." : "Off: press T on a message to translate it."}
        value={offer}
        onChange={(value) => void onPreferences({ translate: { offer: value } })}
      />
      <Row label="Downloaded languages" detail={installed.length ? `${formatBytes(state?.data.stored ?? 0)} on this PC` : "None yet. The first time you translate a language, Kite asks before downloading it."}>
        {installed.length ? (
          <div className="flex flex-col gap-1">
            {installed.map((language) => (
              <div key={language.code} className="flex items-center gap-2 rounded-lg bg-pane-2 px-3 py-1.5 text-[13px]">
                <span className="flex-1">{languageName(language.code)}</span>
                <button onClick={() => void remove(language.code)} className={quietButtonClass}>
                  Remove
                </button>
              </div>
            ))}
          </div>
        ) : null}
      </Row>
      <Note className="mx-4 mb-3">Languages download once from Mozilla (about 35 MB each) and are listed in Privacy.</Note>
    </Group>
  );
}
