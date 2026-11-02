"use client";

import { createContext, useContext } from "react";
import type { Preferences } from "@/lib/settings";

/** Which folded parts of a message start open (Settings → Appearance), provided by mail-app. */
export const FoldContext = createContext<Preferences["reader"]>({ quoted: false, signatures: false });

export const useFold = () => useContext(FoldContext);
