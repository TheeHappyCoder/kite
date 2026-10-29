"use client";

import dynamic from "next/dynamic";

// Screens and dialogs the inbox doesn't need on first load: their code arrives after it.

/** Fill & sign loads pdf.js and pdf-lib only when it opens. */
export const PdfEditor = dynamic(() => import("../../files/pdf-editor"), { ssr: false });
export const SettingsView = dynamic(() => import("../../settings/settings-view").then((m) => m.SettingsView), { ssr: false });
export const CalendarView = dynamic(() => import("../../calendar/calendar-view").then((m) => m.CalendarView), { ssr: false });
export const ScreenshotEditor = dynamic(() => import("../screenshot/screenshot-editor"), { ssr: false });
export const AddEventDialog = dynamic(() => import("../../today/add-event").then((m) => m.AddEventDialog), { ssr: false });
export const NotesView = dynamic(() => import("../../notes/notes-view").then((m) => m.NotesView), { ssr: false });
export const AutomationsView = dynamic(() => import("../../automations/automations-view").then((m) => m.AutomationsView), { ssr: false });
export const ContactsView = dynamic(() => import("../../contacts/contacts-view").then((m) => m.ContactsView), { ssr: false });
export const FilesView = dynamic(() => import("../../files/files-view").then((m) => m.FilesView), { ssr: false });
/** A space's name, colour, logo and pockets in one card (components/mail/space-editor.tsx). */
export const SpaceEditor = dynamic(() => import("../space-editor").then((m) => m.SpaceEditor), { ssr: false });
export const AiSettings = dynamic(() => import("../../ai-settings").then((m) => m.AiSettings), { ssr: false });
// Compose (editor, recipients, attach picker) loads when the first draft opens; it's cached after.
export const Compose = dynamic(() => import("../compose").then((m) => m.Compose), { ssr: false });
export const Onboarding = dynamic(() => import("../../onboarding").then((m) => m.Onboarding), { ssr: false });
