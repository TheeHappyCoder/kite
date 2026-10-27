import * as z from "zod";

// What Kite asks an AI to do, grouped so each group can run on its own model (Settings → AI):
// a cheap model for extraction and summaries, a strong one for writing. Every call to
// server/ai.ts `generateJson` names its task; `preferences.aiModels` maps a task to a connected
// model's id, and a task without one uses the default model.

export const AI_TASKS = ["summarise", "rule_drafts", "draft", "rewrite", "design", "test"] as const;
export type AiTask = (typeof AI_TASKS)[number];

/** The rows on the AI page, in this order. */
export const AI_TASK_INFO: Record<AiTask, { label: string; detail: string }> = {
  summarise: { label: "Summarise", detail: "A conversation's summary, on click." },
  rule_drafts: { label: "Automation drafts", detail: "Replies drafted by automations with Allow AI (each can pick its own)." },
  draft: { label: "Draft with AI", detail: "Replies you ask for in the reader." },
  rewrite: { label: "Rewrite", detail: "Selected text in compose." },
  design: { label: "Describe", detail: "Automations written from your description." },
  test: { label: "Connection test", detail: "Save and test in AI setup." },
};

/** Task -> connected model id. A task not here runs on the default model. */
export const AiModelChoices = z.partialRecord(z.enum(AI_TASKS), z.string().max(120));
export type AiModelChoices = z.infer<typeof AiModelChoices>;
