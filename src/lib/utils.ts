import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import { differenceInCalendarDays, format, isToday } from "date-fns";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatListDate(iso: string) {
  const date = new Date(iso);
  if (isToday(date)) return format(date, "HH:mm");
  const days = differenceInCalendarDays(new Date(), date);
  if (days < 7) return format(date, "EEE");
  return format(date, "d MMM");
}

export function formatFullDate(iso: string) {
  return format(new Date(iso), "EEE d MMM, HH:mm");
}

export function initials(name: string) {
  const parts = name.replace(/[^\p{L}\s]/gu, "").trim().split(/\s+/);
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase() || "?";
}

export function avatarHue(seed: string) {
  let hash = 0;
  for (const char of seed) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash % 360;
}
