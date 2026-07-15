import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { NodeApi } from "react-arborist";
import { ChevronDown, ChevronUp, FileText, PinOff, Settings } from "lucide-react";
import { PageTree, type PageTreeNode } from "./PageTree";
import { SpaceSwitcher } from "./SpaceSwitcher";
import { SpaceIcon } from "../ui/SpaceIcon"; // #284show a page pin's owning space
import {
  useSpaces,
  useCreateSpace,
  useRenameSpace,
  useCreatePage,
  useRenamePage,
  useDeletePage,
  useMovePage,
  usePins,
  useCreatePin,
  useDeletePin,
  useReorderPins,
  type Page,
  type PinResourceType,
} from "../data/queries";
import { apiFetch } from "../data/apiClient";
import { useSession } from "../session/SessionProvider";
import { useActiveSpace } from "../app/ActiveSpace";
import { RenameDialog, ConfirmDialog } from "../ui/dialogs";
import { notify } from "../ui/toast";
import { DeleteBacklinkWarning } from "../app/DeleteBacklinkWarning";
import { ShareDialog } from "../ui/ShareDialog";
import { TemplatePickerDialog } from "./TemplatePickerDialog";
import { NewPageButton } from "./NewPageButton";
import { downloadSpaceExport, importSpaceArchive } from "../data/exportApi"; // #309 export / #308 import

import { buildPageNodes } from "./page-nodes";

export function Sidebar() {
  const { t } = useTranslation();
  const { token } = useSession();
  const navigate = useNavigate();
  const { pageId } = useParams<{ pageId: string }>();
  const { activeSpaceId, setActiveSpaceId } = useActiveSpace();

  const spacesQ = useSpaces();
  const spaces = useMemo(() => spacesQ.data ?? [], [spacesQ.data]);

  // Active space: the stored choice if it still exists, else the first space.
  const current = useMemo(
    () => (activeSpaceId && spaces.find((s) => s.id === activeSpaceId) ? activeSpaceId : spaces[0]?.id),
    [activeSpaceId, spaces],
  );
  // Seed/repair the stored active space (first load, or the stored one was deleted).
  useEffect(() => {
    if (current && current !== activeSpaceId) setActiveSpaceId(current);
  }, [current, activeSpaceId, setActiveSpaceId]);

  const pagesQ = useQuery({
    queryKey: ["pages", current],
    queryFn: () => apiFetch<Page[]>(`/spaces/${current}/pages`, token).then((r) => r ?? []),
    enabled: !!current,
    staleTime: 30_000,
  });
  const pages = useMemo(() => pagesQ.data ?? [], [pagesQ.data]);
  const pageById = useMemo(() => new Map(pages.map((p) => [p.id, p])), [pages]);

  // #284 / ADR-119: the member's pins. The server list is view-confirmed (double gate
  // live resource row + FGA view), so rendering it verbatim can never leak a stale title.
  const pinsQ = usePins();
  const pins = useMemo(() => pinsQ.data ?? [], [pinsQ.data]);
  const pagePins = useMemo(() => pins.filter((p) => p.resourceType === "page"), [pins]);
  const spacePins = useMemo(() => pins.filter((p) => p.resourceType === "space"), [pins]);
  const pinnedPageIds = useMemo(() => new Set(pagePins.map((p) => p.resourceId)), [pagePins]);
  const createPin = useCreatePin();
  const deletePin = useDeletePin();
  const reorderPins = useReorderPins();

  const togglePin = useCallback((resourceType: PinResourceType, resourceId: string) => {
    const existing = pins.find((p) => p.resourceType === resourceType && p.resourceId === resourceId);
    if (existing) deletePin.mutate(existing.id);
    else createPin.mutate({ resourceType, resourceId });
  }, [pins, createPin, deletePin]);

  // v1 reorder = up/down (ADR-119 review decision): swap with the neighbour and persist
  // the full ordered id list for that type.
  const movePin = useCallback((resourceType: PinResourceType, pinId: string, dir: -1 | 1) => {
    const list = resourceType === "page" ? pagePins : spacePins;
    const i = list.findIndex((p) => p.id === pinId);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= list.length) return;
    const ids = list.map((p) => p.id);
    [ids[i], ids[j]] = [ids[j]!, ids[i]!];
    reorderPins.mutate({ resourceType, orderedIds: ids });
  }, [pagePins, spacePins, reorderPins]);

  const data = useMemo(() => buildPageNodes(pages, null, pinnedPageIds), [pages, pinnedPageIds]);

  // Active space capability gates management actions (UI only; the server is the
  // fortress). Space-level: a per-page edit override inside a view-only space would
  // widen beyond this. Per-page grants now exist (#163 / PermissionsDialog), but the
  // sidebar still gates on the SPACE capability; reflecting per-page capability here is
  // a separate enhancement (the server re-checks per page regardless).
  const currentSpace = spaces.find((s) => s.id === current);
  const canEdit = currentSpace?.capability === "edit" || currentSpace?.capability === "manage";
  const canManage = currentSpace?.capability === "manage";

  const createSpace = useCreateSpace();
  const renameSpace = useRenameSpace();
  const createPage = useCreatePage();
  const renamePage = useRenamePage();
  const deletePage = useDeletePage();
  const movePage = useMovePage();

  const [renaming, setRenaming] = useState<{ pageId: string; spaceId: string; title: string } | null>(null);
  const [renamingSpace, setRenamingSpace] = useState<{ id: string; name: string } | null>(null);
  const [creatingSpace, setCreatingSpace] = useState(false);
  // Page deletion only — space deletion lives in Space settings (avoids accidental
  // destruction from the sidebar; #1).
  const [deleting, setDeleting] = useState<{ id: string; name: string } | null>(null);
  const [sharing, setSharing] = useState<string | null>(null);
  const [pickingTemplate, setPickingTemplate] = useState(false);
  // #309: space Markdown-ZIP export — available to EVERY member (the server archive is view-filtered;
  // this is an Open-formats exit, not a management action). Generating a big space takes a while, so
  // the switcher item stays disabled + spinning until the download starts; 413 (over the server's
  // size budget) gets its dedicated message rather than the generic failure toast.
  const [exportingSpace, setExportingSpace] = useState(false);
  const exportSpace = useCallback(() => {
    if (!current || exportingSpace) return;
    setExportingSpace(true);
    void downloadSpaceExport(token, current).then((status) => {
      setExportingSpace(false);
      if (status >= 200 && status < 300) notify.success(t("export.done"));
      else notify.error(t(status === 413 ? "export.tooLarge" : "toast.actionFailed"));
    });
  }, [current, exportingSpace, token, t]);

  // #308 / ADR-132: import an export ZIP into the current space as DRAFT pages. Member-gated on the server
  // (edit); the switcher item is manage-gated as a conservative UI proxy. On success the page tree is refetched
  // so the imported drafts appear, and the report drives a summary toast (413 = too large, 403 = not permitted).
  const qc = useQueryClient();
  const [importingSpace, setImportingSpace] = useState(false);
  const importSpace = useCallback((file: File) => {
    if (!current || importingSpace) return;
    setImportingSpace(true);
    void importSpaceArchive(token, current, file).then(({ status, report }) => {
      setImportingSpace(false);
      if (report) {
        void qc.invalidateQueries({ queryKey: ["pages", current] });
        notify.success(t("import.done", { pages: report.pagesCreated, attachments: report.attachmentsImported }));
      } else {
        notify.error(t(status === 413 ? "import.tooLarge" : status === 403 ? "import.forbidden" : status === 400 ? "import.invalid" : "toast.actionFailed"));
      }
    });
  }, [current, importingSpace, token, qc, t]);

  const newPage = (parentId: string | null) => {
    if (!current) return;
    // A new page is created as a DRAFT and opens straight in the editor (?edit=1)
    // it has no published content yet, so view mode would just be empty.
    createPage.mutate({ spaceId: current, parentId, title: "Untitled" }, { onSuccess: (p) => p && navigate(`/p/${p.id}?edit=1`) });
  };

  // #250: create from a template — seed a new draft from a template snapshot, then open it in edit. The
  // server re-checks template view + destination edit; title defaults to the template name server-side.
  const newPageFromTemplate = (templateId: string) => {
    if (!current) return;
    setPickingTemplate(false);
    createPage.mutate({ spaceId: current, templateId }, { onSuccess: (p) => p && navigate(`/p/${p.id}?edit=1`) });
  };

  // DnD within the active space: reparent (drop onto a page) or reorder (drop at root).
  const onMove = ({ dragIds, parentId, index }: { dragIds: string[]; parentId: string | null; index: number }) => {
    const dragId = dragIds[0];
    if (!dragId?.startsWith("page:") || !current) return;
    const moved = pageById.get(dragId.slice(5));
    if (!moved) return;
    const parentPageId = parentId == null ? null : parentId.startsWith("page:") ? parentId.slice(5) : undefined;
    if (parentPageId === undefined) return;
    const siblings = pages.filter((p) => p.parentId === parentPageId && p.id !== moved.id).sort((a, b) => a.position - b.position);
    const afterId = index > 0 ? siblings[index - 1]?.id ?? null : null;
    movePage.mutate({ pageId: moved.id, fromSpaceId: moved.spaceId, toSpaceId: current, parentId: parentPageId, afterId });
  };

  // Page-row actions, consolidated into one "…" menu. Shown only when the active
  // space is editable (view-only ⇒ no edit actions; the server rejects regardless).
  const onRowAction = (value: string, d: PageTreeNode) => {
    if (value === "subpage") newPage(d.pageId);
    else if (value === "share") setSharing(d.pageId);
    else if (value === "rename") setRenaming({ pageId: d.pageId, spaceId: d.spaceId, title: d.name });
    // #242: "Duplicate page" from the tree row — same shape as routes.tsx onDuplicate (seed a new
    // page from this one, open in edit). No new hook/API; the row menu is canEdit-only and the server
    // still view-gates the source + edit-gates the destination (two-layer defence).
    else if (value === "duplicate") createPage.mutate(
      { spaceId: d.spaceId, title: `${d.name || "Untitled"} (copy)`, fromPageId: d.pageId },
      { onSuccess: (p) => p && navigate(`/p/${p.id}?edit=1`) },
    );
    else if (value === "delete") setDeleting({ id: d.pageId, name: d.name });
  };

  // DnD guard: block dropping a page onto itself or a descendant (cycle). Root drops and page parents
  // within the active space are fine. (Member-only — the public tree is read-only, no DnD.)
  const disableDrop = ({ parentNode, dragNodes }: { parentNode: NodeApi<PageTreeNode> | null; dragNodes: NodeApi<PageTreeNode>[] }) => {
    const drag = dragNodes[0]?.data;
    if (!drag) return true;
    if (parentNode && parentNode.data.pageId) {
      let cur: Page | undefined = pageById.get(parentNode.data.pageId);
      while (cur) {
        if (cur.id === drag.pageId) return true;
        cur = cur.parentId ? pageById.get(cur.parentId) : undefined;
      }
    }
    return false;
  };

  const headerBtn = "flex cursor-pointer rounded-sm p-1 text-fg-dim transition-colors duration-[120ms] hover:bg-panel-2 hover:text-foreground disabled:pointer-events-none disabled:opacity-40";

  // #193: drag the right edge to resize the sidebar. Width is the grid column --sidebar-w (AppShell),
  // clamped 180–480px and persisted to localStorage so it survives reloads. Restore on mount.
  useEffect(() => {
    const saved = localStorage.getItem("wks.sidebarW");
    if (saved) document.documentElement.style.setProperty("--sidebar-w", saved);
  }, []);
  const onResizeStart = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = parseInt(getComputedStyle(document.documentElement).getPropertyValue("--sidebar-w"), 10) || 260;
    const onMove = (ev: PointerEvent) => {
      const w = Math.max(180, Math.min(480, startW + (ev.clientX - startX)));
      document.documentElement.style.setProperty("--sidebar-w", `${w}px`);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      localStorage.setItem("wks.sidebarW", getComputedStyle(document.documentElement).getPropertyValue("--sidebar-w").trim());
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }, []);

  return (
    <div className="relative flex h-full min-w-0 flex-col overflow-hidden text-[length:var(--text-ui)]" data-testid="sidebar">
      {/* Space switcher — the space is a separate layer, not a tree root. */}
      <div className="flex items-center justify-between border-b border-border px-2 py-1.5">
        <SpaceSwitcher
          spaces={spaces}
          currentId={current}
          currentSpace={currentSpace}
          canManage={canManage}
          onSelect={setActiveSpaceId}
          onRename={() => { if (currentSpace) setRenamingSpace({ id: currentSpace.id, name: currentSpace.name }); }}
          onNewSpace={() => setCreatingSpace(true)}
          onExportSpace={exportSpace}
          exportingSpace={exportingSpace}
          onImportSpace={importSpace}
          importingSpace={importingSpace}
          pinnedSpaceIds={spacePins.map((p) => p.resourceId)}
          onTogglePin={(spaceId) => togglePin("space", spaceId)}
          onMovePin={(spaceId, dir) => { const pin = spacePins.find((p) => p.resourceId === spaceId); if (pin) movePin("space", pin.id, dir); }}
        />
        {current && (canEdit || canManage) && (
          <div className="flex flex-none gap-0.5">
            {/* #250: split — the button creates a blank page immediately; the adjacent ▾ opens the
                template picker (blank stays the fast default, templates are one extra click). */}
            {canEdit && <NewPageButton onClick={() => newPage(null)} />}
            {canEdit && <button type="button" className={headerBtn} title={t("templatePicker.title")} aria-label={t("templatePicker.title")} data-testid="new-page-from-template" onClick={() => setPickingTemplate(true)}><ChevronDown size={13} /></button>}
            {canManage && <button type="button" className={headerBtn} title={t("sidebar.spaceSettings")} aria-label={t("sidebar.spaceSettings")} data-testid="space-settings-open" onClick={() => current && navigate(`/spaces/${current}/settings`)}><Settings size={15} /></button>}
          </div>
        )}
      </div>

      {/* #284: the "Pinned" section — the member's pinned PAGES (any space), above the tree so a deep
          page is reachable without expanding. Rendered strictly from the server's view-confirmed list. */}
      {pagePins.length > 0 && (
        <div className="border-b border-border px-1 py-1" data-testid="pinned-section">
          <div className="px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide text-fg-dim">{t("sidebar.pinned")}</div>
          {pagePins.map((pin, i) => (
            <div
              key={pin.id}
              className={`group flex h-7 min-w-0 cursor-pointer items-center gap-1.5 rounded-lg px-2 transition-colors duration-[120ms] ${pin.resourceId === pageId ? "bg-[color-mix(in_srgb,var(--accent)_12%,var(--panel-3))] font-medium" : "hover:bg-panel-2"}`}
              data-testid="pinned-page"
              onClick={() => navigate(`/p/${pin.resourceId}`)}
            >
              {/* #284which space this pinned page lives in — a space icon (hover = space name) left of
                  the file icon, so a deep page's pin isn't ambiguous. Only page pins carry `space`. */}
              {pin.space && (
                <span className="flex-none inline-flex" title={pin.space.name} data-testid="pinned-page-space">
                  <SpaceIcon id={pin.space.id} name={pin.space.name} image={pin.space.iconImageUrl} size={14} />
                </span>
              )}
              <FileText size={14} className="flex-none text-fg-dim" />
              {/* #284/ #219: native tooltip ONLY when the title is truncated (checked at hover). */}
              <span
                className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap"
                onMouseEnter={(e) => { const el = e.currentTarget; el.title = el.scrollWidth > el.clientWidth ? (pin.title || t("common.untitled")) : ""; }}
              >{pin.title || t("common.untitled")}</span>
              <span
                className="flex flex-none gap-0.5 opacity-0 pointer-events-none transition-opacity duration-[120ms] group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100"
                onClick={(e) => e.stopPropagation()}
              >
                <button type="button" className={headerBtn} disabled={i === 0} title={t("sidebar.movePinUp")} aria-label={t("sidebar.movePinUp")} data-testid="pin-up" onClick={() => movePin("page", pin.id, -1)}><ChevronUp size={13} /></button>
                <button type="button" className={headerBtn} disabled={i === pagePins.length - 1} title={t("sidebar.movePinDown")} aria-label={t("sidebar.movePinDown")} data-testid="pin-down" onClick={() => movePin("page", pin.id, 1)}><ChevronDown size={13} /></button>
                <button type="button" className={headerBtn} title={t("sidebar.unpin")} aria-label={t("sidebar.unpin")} data-testid="pin-remove" onClick={() => deletePin.mutate(pin.id)}><PinOff size={13} /></button>
              </span>
            </div>
          ))}
        </div>
      )}

      {spacesQ.isLoading ? (
        <div className="p-3 text-fg-dim">{t("common.loading")}</div>
      ) : spacesQ.isError ? (
        <div className="p-3 text-fg-dim">{t("sidebar.loadFailed")} <button type="button" className="cursor-pointer text-[var(--accent)]" onClick={() => spacesQ.refetch()}>{t("sidebar.retry")}</button></div>
      ) : spaces.length === 0 ? (
        <div className="p-3 text-fg-dim">{t("sidebar.noSpaces")}</div>
      ) : pages.length === 0 ? (
        <div className="p-3 text-fg-dim">{t("sidebar.noPages")}</div>
      ) : (
        <PageTree
          nodes={data}
          selectedId={pageId ?? null}
          onOpen={(id) => navigate(`/p/${id}`)}
          canEdit={canEdit}
          onRowAction={onRowAction}
          onTogglePin={(d) => togglePin("page", d.pageId)}
          onMove={onMove}
          disableDrop={disableDrop}
        />
      )}

      <RenameDialog
        open={renaming !== null}
        initial={renaming?.title ?? ""}
        onClose={() => setRenaming(null)}
        onSubmit={(title) => { if (renaming) renamePage.mutate({ ...renaming, title }); setRenaming(null); }}
      />
      <ConfirmDialog
        open={deleting !== null}
        message={t("sidebar.deletePageConfirm", { name: deleting?.name ?? "" })}
        warning={<DeleteBacklinkWarning pageId={deleting?.id ?? null} onNavigate={() => setDeleting(null)} />}
        onClose={() => setDeleting(null)}
        onConfirm={() => {
          if (deleting) {
            // #275: match the page-⋯ delete path (routes.tsx) — a success/error toast, and if the deleted
            // page is the one currently OPEN, navigate home so its (now-404) body doesn't linger as a ghost.
            const wasOpen = deleting.id === pageId;
            deletePage.mutate({ pageId: deleting.id, spaceId: current! }, {
              onSuccess: () => { notify.success(t("toast.pageTrashed")); if (wasOpen) navigate("/", { replace: true }); },
              onError: () => notify.error(t("toast.actionFailed")),
            });
          }
          setDeleting(null);
        }}
      />
      <RenameDialog
        open={renamingSpace !== null}
        initial={renamingSpace?.name ?? ""}
        title={t("sidebar.renameSpace")}
        label={t("sidebar.spaceName")}
        onClose={() => setRenamingSpace(null)}
        onSubmit={(name) => { if (renamingSpace) renameSpace.mutate({ spaceId: renamingSpace.id, name }); setRenamingSpace(null); }}
      />
      <RenameDialog
        open={creatingSpace}
        initial=""
        title={t("sidebar.newSpace")}
        label={t("sidebar.spaceName")}
        submitLabel={t("sidebar.createSpace")}
        onClose={() => setCreatingSpace(false)}
        onSubmit={(name) => { createSpace.mutate(name, { onSuccess: (s) => s && setActiveSpaceId(s.id) }); setCreatingSpace(false); }}
      />
      <ShareDialog pageId={sharing} onClose={() => setSharing(null)} />
      <TemplatePickerDialog open={pickingTemplate} spaceId={current} onClose={() => setPickingTemplate(false)} onPick={newPageFromTemplate} />
      {/* #193: drag-to-resize handle on the sidebar's right edge. */}
      <div
        onPointerDown={onResizeStart}
        data-testid="sidebar-resizer"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize sidebar"
        className="absolute inset-y-0 right-0 z-10 w-1 cursor-col-resize transition-colors duration-[120ms] hover:bg-[color-mix(in_srgb,var(--accent)_50%,transparent)]"
      />
    </div>
  );
}
