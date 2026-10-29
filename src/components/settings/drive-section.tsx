"use client";

import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ArrowDown01Icon, ArrowRight01Icon, ArrowUp01Icon, Cancel01Icon, File01Icon, Folder01Icon, FolderCloudIcon } from "@hugeicons/core-free-icons";
import {
  DRIVE_FOLDER_INFO,
  DRIVE_LEVEL_INFO,
  driveFolders,
  levelsAllowed,
  MAX_LEVELS,
  SPLIT_CHOICES,
  tidyLevels,
  type DriveFolder,
  type DriveLevel,
  type DrivePrefs,
  type DrivePreviewNode,
} from "@/lib/drive";
import { blurFade } from "@/lib/motion";
import type { Preferences, PreferencesPatch } from "@/lib/settings";
import { cn } from "@/lib/utils";
import { Icon } from "../icon";
import { Select } from "../ui/select";
import { Spinner } from "../ui/spinner";
import { Switch } from "../ui/switch";
import { Tooltip } from "../ui/tooltip";
import { Group, Note, Page, Row, Segmented, ToggleRow } from "./settings-ui";

/*
 * Settings → Files: the Kite drive (lib/drive.ts, src-tauri/src/drive.rs). One switch, then the
 * building blocks: each on or off, in the user's order, split inside by levels picked from a fixed
 * set (person, year, month, week, file type, account), with a live preview of the real tree. No
 * folders of the user's own: those are saved searches.
 */

export function DriveSection(props: { preferences: Preferences; onPreferences: (patch: PreferencesPatch) => Promise<void>; desktop: boolean; accounts: number }) {
  const { drive, savedSearches } = props.preferences;
  const set = (patch: Partial<DrivePrefs>) => void props.onPreferences({ drive: { ...patch, offered: true } }).catch(() => {});
  const folders = driveFolders(drive);
  const save = (next: typeof folders) => set({ folders: next.map(({ kind, on, levels }) => ({ kind, on, levels })) });
  const update = (kind: DriveFolder, change: Partial<(typeof folders)[number]>) => save(folders.map((f) => (f.kind === kind ? { ...f, ...change } : f)));
  const move = (index: number, by: -1 | 1) => {
    const next = [...folders];
    const [item] = next.splice(index, 1);
    next.splice(index + by, 0, item);
    save(next);
  };

  return (
    <Page icon={FolderCloudIcon} title="Files" description="Every file in your mail as folders in Explorer, and in every app's Open window.">
      {!props.desktop ? <Note>Kite in Explorer is part of the Kite desktop app. These settings apply there.</Note> : null}

      <Group title="Kite in Explorer">
        <ToggleRow
          label="Show your files in Explorer"
          detail={
            drive.on
              ? "Kite is in Explorer's side panel. Files download when you open them; nothing there changes your mail."
              : "Adds Kite to Explorer's side panel, next to OneDrive. Off: nothing of it is on this computer."
          }
          value={drive.on}
          onChange={(on) => set({ on })}
        />
        {drive.on ? <Row label="Good to know" detail="Windows Search can see the files' names, and files you open stay in your user folder until you switch this off." /> : null}
      </Group>

      <Group title="Folders" description="Switch on what you want, in the order you want it, and choose how each one splits inside.">
        {folders.map((folder, index) => {
          const info = DRIVE_FOLDER_INFO[folder.kind];
          return (
            <Row
              key={folder.kind}
              label={info.label}
              detail={info.detail}
              control={
                <div className="flex items-center gap-2">
                  <span className="flex flex-col">
                    <Tooltip label="Move up" side="left">
                      <button aria-label={`Move ${info.label} up`} disabled={index === 0} onClick={() => move(index, -1)} className={ARROW}>
                        <Icon icon={ArrowUp01Icon} size={12} />
                      </button>
                    </Tooltip>
                    <Tooltip label="Move down" side="left">
                      <button aria-label={`Move ${info.label} down`} disabled={index === folders.length - 1} onClick={() => move(index, 1)} className={ARROW}>
                        <Icon icon={ArrowDown01Icon} size={12} />
                      </button>
                    </Tooltip>
                  </span>
                  <Switch value={folder.on} onChange={(on) => update(folder.kind, { on })} label={info.label} />
                </div>
              }
            >
              {folder.on ? (
                <div className="flex flex-col gap-2.5">
                  {folder.kind === "people" ? (
                    <Segmented
                      label="Who gets a folder"
                      value={drive.people}
                      options={[
                        { id: "everyone", label: "Everyone" },
                        { id: "written", label: "People you've written to" },
                        { id: "vips", label: "VIPs" },
                      ]}
                      onChange={(people) => set({ people })}
                    />
                  ) : null}
                  {folder.kind === "searches" ? (
                    savedSearches.length ? (
                      <div className="flex flex-col gap-1">
                        {savedSearches.map((search) => (
                          <label key={search.id} className="flex min-w-0 items-center gap-3 py-1">
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-[13px]">{search.name}</span>
                              <span className="block truncate text-[12px] text-pane-muted">{search.query}</span>
                            </span>
                            <Switch
                              size="sm"
                              label={`Show ${search.name} as a folder`}
                              value={drive.searches.includes(search.id)}
                              onChange={(on) => set({ searches: on ? [...drive.searches, search.id] : drive.searches.filter((id) => id !== search.id) })}
                            />
                          </label>
                        ))}
                      </div>
                    ) : (
                      <p className="text-[12px] text-pane-muted">Save a search from the search bar first; it can then be a folder here.</p>
                    )
                  ) : null}
                  <Levels kind={folder.kind} levels={folder.levels} accounts={props.accounts} onChange={(levels) => update(folder.kind, { levels: tidyLevels(folder.kind, levels) })} />
                </div>
              ) : null}
            </Row>
          );
        })}
        <Row
          label="Only split big folders"
          detail={drive.splitOver ? `A folder with ${drive.splitOver} files or fewer stays one list, at every level.` : "Every folder splits, however few files it holds."}
          control={
            <Select
              label="Only split big folders"
              value={String(drive.splitOver)}
              options={SPLIT_CHOICES.map((n) => ({ value: String(n), label: n ? `Over ${n} files` : "Always split" }))}
              onChange={(value) => set({ splitOver: Number(value) as DrivePrefs["splitOver"] })}
            />
          }
        />
      </Group>

      <Preview drive={drive} />
    </Page>
  );
}

const ARROW = "grid size-5 place-items-center rounded-full text-pane-muted hover:bg-pane-2 hover:text-pane-fg disabled:opacity-30 touch:size-8";

/** "Inside each": the levels as chips in order, each removable, and a picker for one more. */
function Levels({ kind, levels, accounts, onChange }: { kind: DriveFolder; levels: DriveLevel[]; accounts: number; onChange: (levels: DriveLevel[]) => void }) {
  const left = levelsAllowed(kind).filter((l) => !levels.includes(l) && (l !== "account" || accounts > 1));
  // By date's first level is what it is: it can change, not go.
  const fixed = kind === "months" && levels.length === 1;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="mr-1 text-[12px] text-pane-muted">{kind === "months" ? "Folders" : "Inside each"}</span>
      {levels.length ? null : <span className="text-[12px] text-pane-muted">one list of files</span>}
      {levels.map((level, i) => (
        <span key={level} className="flex items-center gap-1.5">
          {i ? <Icon icon={ArrowRight01Icon} size={11} className="text-pane-muted" /> : null}
          <span className="flex h-7 items-center gap-1 rounded-full border border-pane-border bg-pane-2 pl-2.5 pr-1 text-[12px] touch:h-9">
            {DRIVE_LEVEL_INFO[level]}
            {fixed ? <span className="w-1.5" /> : (
              <Tooltip label={`Don't split by ${DRIVE_LEVEL_INFO[level].toLowerCase()}`} side="top">
                <button aria-label={`Remove ${DRIVE_LEVEL_INFO[level]}`} onClick={() => onChange(levels.filter((l) => l !== level))} className="grid size-5 place-items-center rounded-full text-pane-muted hover:bg-pane-hover hover:text-pane-fg">
                  <Icon icon={Cancel01Icon} size={10} />
                </button>
              </Tooltip>
            )}
          </span>
        </span>
      ))}
      {levels.length < MAX_LEVELS && left.length ? (
        <Select<DriveLevel | "">
          label="Split by"
          value=""
          variant="borderless"
          options={[{ value: "", label: "+ Split by" }, ...left.map((l) => ({ value: l, label: DRIVE_LEVEL_INFO[l] }))]}
          onChange={(value) => value && onChange([...levels, value])}
        />
      ) : null}
    </div>
  );
}

/** What the drive looks like with these choices, from the real files (a few folders per level). */
function Preview({ drive }: { drive: DrivePrefs }) {
  const key = JSON.stringify({ ...drive, on: undefined, offered: undefined });
  const [state, setState] = useState<{ key: string; tree: DrivePreviewNode[] } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      fetch("/api/drive?preview=1", { signal: controller.signal })
        .then((res) => res.json() as Promise<{ preview: DrivePreviewNode[] }>)
        .then((data) => setState({ key, tree: data.preview }))
        .catch(() => {});
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [key]);
  const tree = state?.tree ?? null;
  return (
    <Group title="Preview" description="How Explorer will show it, from your own files.">
      <div data-sensitive="" className="relative min-h-24 px-3 py-3">
        {tree === null ? (
          <div className="flex items-center gap-2 px-1 text-[12.5px] text-pane-muted">
            <Spinner /> Building the preview
          </div>
        ) : tree.length ? (
          <div className={cn("flex flex-col transition-opacity duration-150", state?.key !== key && "opacity-60")}>
            <div className="flex items-center gap-2 px-1 pb-1 text-[12.5px] font-medium">
              <Icon icon={FolderCloudIcon} size={15} className="text-accent" />
              Kite
            </div>
            {tree.map((node, i) => (
              <Node key={node.name} node={node} depth={1} open={i === 0} />
            ))}
          </div>
        ) : (
          <p className="px-1 text-[12.5px] text-pane-muted">Nothing to show yet: switch a folder on, or wait for mail with files.</p>
        )}
      </div>
    </Group>
  );
}

/** One folder in the preview: click to open; the first path opens by itself so the levels show. */
function Node({ node, depth, open: initial }: { node: DrivePreviewNode; depth: number; open: boolean }) {
  const [open, setOpen] = useState(initial);
  const pad = { paddingLeft: depth * 16 };
  return (
    <div className="flex flex-col">
      <button onClick={() => setOpen((o) => !o)} style={pad} className="flex h-7 min-w-0 items-center gap-2 rounded-lg pr-2 text-left text-[12.5px] hover:bg-pane-hover">
        <Icon icon={ArrowRight01Icon} size={11} className={cn("shrink-0 text-pane-muted transition-transform duration-150", open && "rotate-90")} />
        <Icon icon={Folder01Icon} size={15} className="shrink-0 text-pane-muted" />
        <span className="min-w-0 flex-1 truncate">{node.name}</span>
        <span className="shrink-0 tabular-nums text-[11.5px] text-pane-muted">{node.total}</span>
      </button>
      <AnimatePresence initial={false}>
        {open ? (
          <motion.div {...blurFade({ y: -3, blur: 3 })} className="flex flex-col">
            {node.folders.map((child, i) => (
              <Node key={child.name} node={child} depth={depth + 1} open={initial && i === 0} />
            ))}
            {node.moreFolders ? <More depth={depth + 1} text={`${node.moreFolders} more ${node.moreFolders === 1 ? "folder" : "folders"}`} /> : null}
            {node.files.map((name) => (
              <div key={name} style={{ paddingLeft: (depth + 1) * 16 + 19 }} className="flex h-6 min-w-0 items-center gap-2 pr-2 text-[12px] text-pane-muted">
                <Icon icon={File01Icon} size={13} className="shrink-0" />
                <span className="truncate">{name}</span>
              </div>
            ))}
            {node.moreFiles ? <More depth={depth + 1} text={`${node.moreFiles} more ${node.moreFiles === 1 ? "file" : "files"}`} /> : null}
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

function More({ depth, text }: { depth: number; text: string }) {
  return (
    <div style={{ paddingLeft: depth * 16 + 19 }} className="flex h-6 items-center text-[11.5px] text-pane-muted/80">
      {text}
    </div>
  );
}
