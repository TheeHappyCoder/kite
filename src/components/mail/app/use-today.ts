"use client";

import { useEffect, useMemo, useState } from "react";
import type { ThreadOverride } from "@/lib/mail/overrides";
import type { AccountScope } from "@/lib/mail/scope";
import type { Account, Thread } from "@/lib/mail/types";
import { demoToday, dueTodayCount, forAccount, type TodayData } from "@/lib/today";

/**
 * Today, read from the local copy whenever mail or a calendar changes (`refresh`). `now`
 * is when it was read, so grouping by day stays put between reads (and moves on at the next one).
 * Demo mode builds it from the sample threads.
 */
export function useToday({
  ready,
  live,
  accountId,
  threads,
  overrides,
  accounts,
  waitDays,
  refresh,
}: {
  ready: boolean;
  live: boolean;
  accountId: AccountScope;
  threads: Thread[];
  overrides: Record<string, ThreadOverride>;
  accounts: Account[];
  waitDays: number;
  refresh: string;
}) {
  const [clock, setClock] = useState(0);
  useEffect(() => { const timer = setInterval(() => setClock((v) => v + 1), 60_000); return () => clearInterval(timer); }, []);
  const [today, setToday] = useState<{ data: TodayData; now: string } | null>(null);
  useEffect(() => {
    if (!ready) return;
    const controller = new AbortController();
    fetch(`/api/today?account=${accountId}`, { signal: controller.signal })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error("Today couldn't be read"))))
      .then((data: TodayData) => setToday({ data, now: new Date().toISOString() }))
      .catch(() => {});
    return () => controller.abort();
  }, [ready, accountId, refresh, waitDays, clock]);
  const todayData = useMemo(
    () =>
      !today
        ? null
        : live
          ? today.data
          : forAccount(demoToday(threads, overrides, { accounts, waitDays, now: new Date(today.now).getTime() }), accountId),
    [today, live, threads, overrides, accountId, accounts, waitDays],
  );
  const todayNow = useMemo(() => (today ? new Date(today.now) : null), [today]);
  const todayCount = todayData && todayNow ? dueTodayCount(todayData, todayNow) : 0;
  return { todayData, todayNow, todayCount };
}
