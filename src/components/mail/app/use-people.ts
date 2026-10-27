"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { participants } from "@/lib/mail/people";
import { patchPerson, personKey, type PersonPatch, type PersonPrefs } from "@/lib/mail/person-prefs";
import type { Account, Thread } from "@/lib/mail/types";
import { postJson, type SetToast } from "./util";

/**
 * Per-person local state (VIP, private note, always load images), applied at once then saved,
 * and the People panel beside the reader: open or not, and who it shows for which conversation.
 */
export function usePeople({ accounts, selected, setToast }: { accounts: Account[]; selected: Thread | null; setToast: SetToast }) {
  const [people, setPeople] = useState<Record<string, PersonPrefs>>({});
  const peopleRef = useRef(people);
  useEffect(() => {
    peopleRef.current = people;
  }, [people]);
  const putPerson = useCallback((key: string, prefs: PersonPrefs | null) => {
    setPeople((current) => {
      const next = { ...current };
      if (prefs) next[key] = prefs;
      else delete next[key];
      return next;
    });
  }, []);
  const vips = useMemo(() => new Set(Object.keys(people).filter((email) => people[email].vip)), [people]);
  /** Changes a person's local state (VIP, private note): applied at once, then saved. */
  const updatePerson = useCallback(
    ({ email, ...patch }: PersonPatch) => {
      const key = personKey(email);
      const before = peopleRef.current[key];
      putPerson(key, patchPerson(before, patch));
      return postJson<{ prefs: PersonPrefs | null }>("/api/people", { email: key, ...patch })
        .then((res) => putPerson(key, res.prefs))
        .catch(() => {
          putPerson(key, before ?? null);
          setToast({ message: "Kite couldn't save that change. Try again." });
        });
    },
    [putPerson, setToast],
  );

  const [peopleOpen, setPeopleOpen] = useState(false);
  const [personPick, setPersonPick] = useState<{ threadId: string; email: string } | null>(null);
  const myEmails = useMemo(() => accounts.map((a) => a.email), [accounts]);
  const showPerson = useCallback(
    (email: string) => {
      if (!selected) return;
      setPersonPick({ threadId: selected.id, email });
      setPeopleOpen(true);
    },
    [selected],
  );
  /** Marks (or unmarks) the person shown in the People panel, else the conversation's main correspondent, as a VIP. */
  const toggleVip = useCallback(() => {
    if (!selected) return;
    const email = (personPick?.threadId === selected.id ? personPick.email : null) ?? participants(selected, myEmails)[0]?.email;
    if (!email) return;
    const vip = !peopleRef.current[personKey(email)]?.vip;
    void updatePerson({ email, vip });
    setToast({ message: vip ? `${email} is a VIP` : `${email} is no longer a VIP` });
  }, [selected, personPick, myEmails, updatePerson, setToast]);

  return { people, setPeople, vips, updatePerson, peopleOpen, setPeopleOpen, personPick, myEmails, showPerson, toggleVip };
}
