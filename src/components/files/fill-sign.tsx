"use client";

import { createContext, useContext } from "react";
import type { FileRef } from "./file-preview";

/** Opens the Fill & sign editor (provided by the app shell; absent inside compose). `layout`: a remembered layout to place on open, for review. */
export const FillSignContext = createContext<((file: FileRef, options?: { layout?: string }) => void) | null>(null);

export const useFillSign = () => useContext(FillSignContext);
