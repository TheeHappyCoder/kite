// Kite's sky (globals.css) follows the local time: dawn, day, golden hour and night. The phase sits on
// <html> as data-sky, set before first paint (skyScript, inline in layout.tsx) and kept current while
// Kite is open (useSkyPhase in use-sky.ts). Dark panes always get the night sky, whatever the phase.

export type SkyPhase = "dawn" | "day" | "golden" | "night";

/** The phase for a local time, in minutes past midnight. */
export function skyPhase(minutes: number): SkyPhase {
  if (minutes >= 5 * 60 && minutes < 7 * 60 + 30) return "dawn";
  if (minutes >= 7 * 60 + 30 && minutes < 17 * 60) return "day";
  if (minutes >= 17 * 60 && minutes < 19 * 60) return "golden";
  return "night";
}

/** The same rule, inline before first paint (keep it in step with skyPhase). */
export const skyScript = `try{var d=new Date(),m=d.getHours()*60+d.getMinutes();document.documentElement.dataset.sky=m>=300&&m<450?"dawn":m>=450&&m<1020?"day":m>=1020&&m<1140?"golden":"night"}catch(e){}`;
