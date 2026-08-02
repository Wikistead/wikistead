import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type MutableRefObject } from "react";
import { useTranslation } from "react-i18next";
import { classifyMentionKey, nextMentionIndex, classifyComposerKey } from "./mention-nav";
import { relTime } from "../ui/relative-time";
import { Button } from "../ui/Button";
import { RightPanel } from "../ui/RightPanel";
import { PanelRowsSkeleton, useDelayedFlag } from "../ui/Skeleton"; // #457 loading ≠ empty
import { ConfirmDialog } from "../ui/dialogs"; // #504: deleting a comment is irreversible
import { AuthorChip } from "./AuthorChip";
import { useSession } from "../session/SessionProvider";
import { useComments, useCommentMutations, fetchMentionable } from "../data/comments";
import type { Mentionable } from "../data/commentsApi";
import type { AnchorGetter } from "../editor/Editor";

// #206: the right-panel chrome (width / bg / slide-in / header / close / Esc) is the shared RightPanel.
const hint = "m-0 text-sm text-fg-dim";
const textareaCls = "box-border min-h-[56px] w-full resize-y rounded-md border border-border bg-background p-2 text-[0.92em] text-foreground focus-visible:border-[var(--accent)] focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-[var(--accent)]";
const suggestCls = "absolute bottom-full left-0 right-0 z-20 m-0 mb-1 list-none rounded-md border border-border bg-panel p-1 shadow-[0_6px_20px_rgba(0,0,0,0.25)]";
const suggestBtn = "block w-full rounded px-2 py-[5px] text-left text-[0.9em] text-foreground hover:bg-panel-2";
// #588: the selected row. Same treatment as the other pickers (a panel-2 fill), so the list reads the
// same whether the pointer or the keyboard put the highlight there.
const suggestBtnActive = `${suggestBtn} bg-panel-2`;

// Composer with @mention autocomplete. Suggestions come from the page-scoped
// mentionable directory (server limits it to members who can VIEW this page), so a
// member who can't see the page never appears as a suggestion.
function Composer({ pageId, token, onSubmit, placeholder }: { pageId: string; token: string; onSubmit: (body: string, mentions: string[]) => void; placeholder: string }) {
  const { t } = useTranslation();
  const [text, setText] = useState("");
  const [suggest, setSuggest] = useState<Mentionable[]>([]);
  // #588: the highlighted row. The list had NO keyboard handling at all — you could open it by typing
  // and then had to reach for the mouse. The convention is the app's, not a new one: Ctrl-j / Ctrl-k
  // plus the arrows (Ctrl-n / Ctrl-p are browser-reserved, which is why the palette chose j/k), Enter
  // confirms, Esc closes.
  const [active, setActive] = useState(0);
  const dir = useRef<Mentionable[] | null>(null);
  const picked = useRef<Map<string, string>>(new Map()); // "@name" → sub

  const onChange = async (v: string) => {
    setText(v);
    // #584: `\w` is ASCII-only, so an @mention of a Japanese (or accented) display name never opened
    // the suggestion list at all — the same names the server now matches out of the text.
    const m = /@([\p{L}\p{N}._-]*)$/u.exec(v);
    if (!m) return setSuggest([]);
    if (!dir.current) dir.current = await fetchMentionable(token, pageId);
    const q = m[1]!.toLowerCase();
    setSuggest(dir.current.filter((x) => (x.displayName ?? x.sub).toLowerCase().includes(q)).slice(0, 5));
    setActive(0); // a new query starts at the top (the same rule the embed picker follows)
  };

  const pick = (mn: Mentionable) => {
    const name = (mn.displayName ?? mn.sub).replace(/\s/g, "");
    setText((t) => t.replace(/@([\p{L}\p{N}._-]*)$/u, `@${name} `));
    picked.current.set(`@${name}`, mn.sub);
    setSuggest([]);
    setActive(0);
  };

  // #588 / #412: pointer movement over the list is as manual as an arrow key — it moves the highlight
  // and the highlight stays where the user left it. Nothing yanks it back while the query is unchanged.
  // The DECISION lives in mention-nav.ts (a value); this only executes it.
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (suggest.length > 0) {
      // #588: while the list is open it owns Enter — confirming a suggestion is a different intent from
      // posting, and the list closes on confirm so the NEXT Enter posts.
      const k = classifyMentionKey(e);
      if (k.action !== "pass") {
        e.preventDefault();
        if (k.action === "move") setActive((i) => nextMentionIndex(i, suggest.length, k.delta));
        else if (k.action === "confirm") pick(suggest[Math.min(active, suggest.length - 1)]!);
        else setSuggest([]);
        return;
      }
    }
    // #594: Enter posts, Shift-Enter breaks the line — and an Enter that is confirming an IME
    // conversion does neither. See classifyComposerKey for why that branch is the load-bearing one.
    if (classifyComposerKey(e).action !== "submit") return;
    e.preventDefault();
    submit();
  };

  const submit = () => {
    const body = text.trim();
    if (!body) return;
    const mentions = [...picked.current.entries()].filter(([tag]) => body.includes(tag)).map(([, sub]) => sub);
    onSubmit(body, mentions);
    setText("");
    picked.current = new Map();
    setSuggest([]);
  };

  return (
    <div className="relative flex flex-col gap-2">
      <textarea
        className={textareaCls}
        data-testid="comment-input"
        value={text}
        placeholder={placeholder}
        onChange={(e) => void onChange(e.target.value)}
        onKeyDown={onKeyDown}
        aria-controls={suggest.length > 0 ? "mention-suggest" : undefined}
        aria-activedescendant={suggest.length > 0 ? `mention-option-${active}` : undefined}
      />
      {suggest.length > 0 && (
        <ul className={suggestCls} id="mention-suggest" data-testid="mention-suggest" role="listbox">
          {suggest.map((s, i) => (
            <li key={s.sub}>
              <button
                type="button"
                id={`mention-option-${i}`}
                role="option"
                aria-selected={i === active}
                className={i === active ? suggestBtnActive : suggestBtn}
                data-testid="mention-option"
                data-active={i === active ? "true" : "false"}
                onMouseMove={() => setActive(i)}
                onMouseDown={(e) => { e.preventDefault(); pick(s); }}
              >
                {s.displayName ?? s.sub}
              </button>
            </li>
          ))}
        </ul>
      )}
      <Button variant="primary" size="sm" style={{ alignSelf: "flex-start" }} data-testid="comment-submit" disabled={!text.trim()} onClick={submit}>
        {t("commentsPanel.submit")}
      </Button>
    </div>
  );
}

// ADR-102 (comment 805): the tuning values live HERE, named, so they adjust in one place.
const THREAD_COLLAPSE_THRESHOLD = 5; // collapse a thread with MORE than this many comments
const THREAD_COLLAPSE_KEEP = 3; // ...keeping the parent + this many latest replies
const LOAD_OLDER_SCROLL_PX = 48; // fetch the next-older page when the list is scrolled within this of the top

export function CommentsPanel({ pageId, canComment, anchorGetterRef, onClose, token }: { pageId: string; canComment: boolean; anchorGetterRef: MutableRefObject<AnchorGetter | null>; onClose: () => void; token?: string }) {
  const { t: tr, i18n } = useTranslation();
  const { token: sessionToken } = useSession();
  void anchorGetterRef; // #214 part 1: inline/selection comments removed — the anchor ref is now unused here
  // #100 (authz): in a GUEST view `token` is the guest share token, so comment read/write runs as the
  // guest — not the app SessionProvider's member/dev token (which in dev is the dev-user bypass, the
  // path that let a "guest" delete a member's comment). Members pass no token → the session is used.
  const authToken = token ?? sessionToken;
  const { data, fetchNextPage, hasNextPage, isFetchingNextPage } = useComments(pageId, authToken);
  const { createThread, reply, remove } = useCommentMutations(pageId, authToken);

  // #214 part 2 (comment 738): a comment's "reply" button retargets the SINGLE bottom composer to that
  // thread (no always-expanded per-comment reply box). Null = the composer posts a new page comment.
  // #214 comment 751 (1): carry the target comment's body so the reply banner previews WHICH comment.
  const [replyTo, setReplyTo] = useState<{ threadId: string; sub: string; body: string } | null>(null);
  // #504: a deleted comment is unrecoverable — hold the id while the ConfirmDialog is up.
  const [deletingComment, setDeletingComment] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set()); // ADR-102 §2: threads the user expanded
  const listRef = useRef<HTMLDivElement | null>(null);
  const anchorHeight = useRef<number | null>(null); // ADR-102 §3: scrollHeight snapshot for prepend anchoring

  // ADR-102 §3: pages are newest-first (page 0 = newest activity); a thread within a page is also
  // newest-first. Flatten to chat order (oldest at top, newest just above the composer) by reversing both.
  const pages = data?.pages;
  // #457 while the FIRST page is in flight the list used to fall through to the "no comments"
  // wording — loading and empty are different truths. Row skeletons (delay-gated) until it settles.
  const commentsLoading = pages === undefined;
  const showSkeleton = useDelayedFlag(commentsLoading);
  const notViewable = !!pages && pages[0] === null; // first page 404/403 → not viewable (no-leak)
  const threads = pages ? [...pages].reverse().flatMap((p) => (p ? [...p.threads].reverse() : [])) : [];
  // #214 comment 751 (2): never render an EMPTY thread frame (deleting a thread's last comment).
  const visibleThreads = threads.filter((t) => t.comments.length > 0);
  const count = visibleThreads.reduce((n, t) => n + t.comments.length, 0);

  // ADR-102 §3 (the crux): after an OLDER page prepends, keep the viewport on the same comment —
  // scrollTop += (newHeight − snapshot). Otherwise (initial load / a new comment at the bottom) pin to
  // the newest. `anchorHeight` is set ONLY when we fetch older (onScroll below), so the two never conflict.
  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el) return;
    if (anchorHeight.current != null) { el.scrollTop += el.scrollHeight - anchorHeight.current; anchorHeight.current = null; }
    else el.scrollTop = el.scrollHeight;
  }, [count, visibleThreads.length]);
  // A retargeted reply whose thread vanished (deleted) falls back to a new page comment.
  useEffect(() => { if (replyTo && !threads.some((t) => t.id === replyTo.threadId)) setReplyTo(null); }, [threads, replyTo]);

  const loadOlder = () => {
    const el = listRef.current;
    if (!el || !hasNextPage || isFetchingNextPage) return;
    anchorHeight.current = el.scrollHeight; // snapshot BEFORE the prepend, for the layout-effect compensation
    void fetchNextPage();
  };
  const onScroll = () => { const el = listRef.current; if (el && el.scrollTop <= LOAD_OLDER_SCROLL_PX) loadOlder(); };

  // Page not viewable (server returned null) → render nothing (no-leak). While the first page loads
  // (pages undefined) the panel shell still renders with an empty list.
  if (notViewable) return null;

  const Stamp = ({ iso }: { iso: string }) => {
    const { rel, abs } = relTime(iso, i18n.language);
    return <time className="text-[0.75em] text-fg-dim" dateTime={iso} data-tip={abs} data-testid="comment-time">{rel}</time>;
  };
  const CommentRow = ({ c }: { c: (typeof visibleThreads)[number]["comments"][number] }) => (
    <div className="flex flex-col gap-0.5" data-testid="comment-item">
      <div className="flex items-center gap-1.5">
        <AuthorChip sub={c.authorSub} name={c.authorName} hasAvatar={c.authorHasAvatar} />
        <Stamp iso={c.createdAt} />
        {c.canModify && (
          // #504: irreversible — confirm before removing (the trigger was already red at rest).
          <button type="button" className="ml-auto cursor-pointer border-0 bg-transparent p-0 text-[0.8em] text-[var(--danger)] opacity-80 hover:underline hover:opacity-100" data-testid="comment-delete" onClick={() => setDeletingComment(c.id)}>{tr("commentsPanel.delete")}</button>
        )}
      </div>
      <span className="whitespace-pre-wrap text-[0.92em] [overflow-wrap:anywhere]">{c.body}</span>
    </div>
  );

  return (
    <RightPanel testId="comments-panel" title={tr("page.comments")} onClose={onClose}>
      {/* #214 part 1: NO selection/inline comment affordance — page comments only. part 4/5: a scrolling
          thread list above a composer pinned FLUSH to the panel bottom (no gap / see-through). */}
      <div className="flex min-h-0 flex-1 flex-col gap-2">
        <div ref={listRef} onScroll={onScroll} className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto" data-testid="comment-list">
          {/* ADR-102 §4: load-older affordance at the TOP — visible while an older page exists, gone at the
              beginning. It is both the indicator and a click target (the scroll handler also triggers it). */}
          {hasNextPage && (
            <button type="button" className="shrink-0 cursor-pointer rounded border-0 bg-transparent py-1 text-center text-[0.8em] text-fg-dim hover:text-foreground hover:underline disabled:opacity-60" data-testid="comment-load-older" disabled={isFetchingNextPage} onClick={loadOlder}>
              {tr("commentsPanel.loadOlder")}
            </button>
          )}
          {commentsLoading && showSkeleton && <PanelRowsSkeleton testid="comments-skeleton" />}
          {!commentsLoading && !hasNextPage && visibleThreads.length === 0 && <p className={hint}>{tr("commentsPanel.empty")}</p>}
          {visibleThreads.map((t) => {
            // ADR-102 §2: a long thread (> threshold) shows the parent + the latest KEEP replies, folding
            // the middle behind a "n replies" button until the user expands it.
            const cs = t.comments;
            const collapsed = cs.length > THREAD_COLLAPSE_THRESHOLD && !expanded.has(t.id);
            const tail = collapsed ? cs.slice(cs.length - THREAD_COLLAPSE_KEEP) : cs.slice(1);
            const hidden = collapsed ? cs.length - 1 - THREAD_COLLAPSE_KEEP : 0;
            return (
              <div key={t.id} className="flex flex-col gap-2 rounded-lg border border-border bg-background px-3 py-2" data-testid="comment-thread">
                <CommentRow c={cs[0]!} />
                {collapsed && (
                  <button type="button" className="self-start cursor-pointer border-0 bg-transparent p-0 text-[0.8em] text-fg-dim hover:text-foreground hover:underline" data-testid="show-replies" onClick={() => setExpanded((s) => new Set(s).add(t.id))}>
                    {tr("commentsPanel.showReplies", { count: hidden })}
                  </button>
                )}
                {tail.map((c) => <CommentRow key={c.id} c={c} />)}
                {canComment && (
                  <button type="button" className="self-start cursor-pointer border-0 bg-transparent p-0 text-[0.8em] text-[var(--accent)] opacity-90 hover:underline hover:opacity-100" data-testid="comment-reply" onClick={() => setReplyTo({ threadId: t.id, sub: cs[0]?.authorSub ?? "", body: cs[0]?.body ?? "" })}>
                    {tr("commentsPanel.reply")}
                  </button>
                )}
              </div>
            );
          })}
        </div>

        {!canComment && (
          // #553 / ADR-199 §4: "can view (or even edit) but cannot comment" is a REACHABLE state now —
          // a hidden composer read as a bug, so the slot says why in one line. The server stays the
          // fortress (view floor + comment check); this is display only.
          <div className="flex-none -mx-3 -mb-3 border-t border-border bg-panel px-3 pb-3 pt-2 text-[0.8em] text-fg-dim" data-testid="comment-composer-readonly">
            {tr("commentsPanel.readOnlyReason")}
          </div>
        )}
        {canComment && (
          // Composer pinned flush to the panel bottom: the negative margins cancel the RightPanel p-3 so the
          // opaque bar reaches the panel's true bottom edge (no gap / see-through — comment 738 part 4).
          <div className="flex-none -mx-3 -mb-3 flex flex-col gap-2 border-t border-border bg-panel px-3 pb-3 pt-2" data-testid="comment-composer">
            {replyTo && (
              <div className="flex items-center gap-1.5 text-[0.8em] text-fg-dim" data-testid="reply-banner">
                <span>{tr("commentsPanel.replyingTo")}</span>
                <AuthorChip sub={replyTo.sub} />
                {/* #214 comment 751 (1): preview the target comment's content so it's clear WHICH comment.
                    Locale-neutral (italic, no language-specific quote glyphs); truncated to one line. */}
                {replyTo.body && <span className="min-w-0 flex-1 truncate italic opacity-80" data-testid="reply-preview">{replyTo.body}</span>}
                <button type="button" className="ml-auto cursor-pointer border-0 bg-transparent p-0 text-[0.8em] text-fg-dim hover:text-foreground hover:underline" data-testid="reply-cancel" onClick={() => setReplyTo(null)}>{tr("common.cancel")}</button>
              </div>
            )}
            <Composer
              key={replyTo?.threadId ?? "new"}
              pageId={pageId}
              token={authToken}
              placeholder={replyTo ? tr("commentsPanel.reply") : tr("commentsPanel.pagePlaceholder")}
              onSubmit={(body, mentions) => {
                if (replyTo) { reply.mutate({ threadId: replyTo.threadId, body, mentions }); setReplyTo(null); }
                else createThread.mutate({ body, kind: "page", mentions });
              }}
            />
          </div>
        )}
      </div>
      {/* #504: the comment-delete confirm (danger tone). */}
      <ConfirmDialog
        open={deletingComment !== null}
        message={tr("commentsPanel.deleteConfirm")}
        confirmTestId="comment-delete-confirm"
        onClose={() => setDeletingComment(null)}
        onConfirm={() => { if (deletingComment) remove.mutate(deletingComment); setDeletingComment(null); }}
      />
    </RightPanel>
  );
}
