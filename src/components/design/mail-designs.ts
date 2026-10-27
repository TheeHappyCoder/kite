"use client";

import type { BrandKit, EmailTemplate, TemplateInput } from "@/lib/design/brand";

// Client calls for designed mail: email templates and the brand kit (kept locally).

async function request<T>(url: string, method = "GET", body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? "That didn't go through. Try again.");
  return data;
}

export type MailDesigns = { templates: EmailTemplate[]; brand: BrandKit };

export const loadMailDesigns = () => request<MailDesigns>("/api/templates");

export const saveTemplate = (input: TemplateInput) => request<{ template: EmailTemplate }>("/api/templates", "POST", input).then((r) => r.template);

export const deleteTemplate = (id: string) => request<{ ok: true }>(`/api/templates/${id}`, "DELETE");

export const saveBrand = (brand: BrandKit) => request<{ brand: BrandKit }>("/api/templates/brand", "PUT", brand).then((r) => r.brand);
