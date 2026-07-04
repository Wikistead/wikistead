import { useRef, useState, type MutableRefObject } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../ui/Button";
import { RightPanel } from "../ui/RightPanel";
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

// Composer with @mention autocomplete. Suggestions come from the page-scoped
// mentionable directory (server limits it to members who can VIEW this page), so a
// member who can't see the page never appears as a suggestion.
function Composer({ pageId, token, onSubmit, placeholder }: { pageId: string; token: string; onSubmit: (body: string, mentions: string[]) => void; placeholder: string }) {
  const { t } = useTranslation();
  const [text, setText] = useState("");
  const [suggest, setSuggest] = useState<Mentionable[]>([]);
  const dir = useRef<Mentionable[] | null>(null);
  const picked = useRef<Map<string, string>>(new Map()); // "@name" → sub

  const onChange = async (v: string) => {
    setText(v);
    const m = /@(\w*)$/.exec(v);
    if (!m) return setSuggest([]);
    if (!dir.current) dir.current = await fetchMentionable(token, pageId);
    const q = m[1]!.toLowerCase();
    setSuggest(dir.current.filter((x) => (x.displayName ?? x.sub).toLowerCase().includes(q)).slice(0, 5));
  };
  const pick = (mn: Mentionable) => {
    const name = (mn.displayName ?? mn.sub).replace(/\s/g, "");
    setText((t) => t.replace(/@(\w*)$/, `@${name} `));
    picked.current.set(`@${name}`, mn.sub);
    setSuggest([]);
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
      />
      {suggest.length > 0 && (
        <ul className={suggestCls} data-testid="mention-suggest">
          {suggest.map((s) => (
            <li key={s.sub}>
              <button type="button" className={suggestBtn} data-testid="mention-option" onMouseDown={(e) => { e.preventDefault(); pick(s); }}>
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

export function CommentsPanel({ pageId, canComment, anchorGetterRef, onClose, token }: { pageId: string; canComment: boolean; anchorGetterRef: MutableRefObject<AnchorGetter | null>; onClose: () => void; token?: string }) {
  const { t: tr } = useTranslation(); // `t` is used as the thread loop var below
  const { token: sessionToken } = useSession();
  // #100 (authz): in a GUEST view `token` is the guest share token, so comment read/write runs as the
  // guest — not the app SessionProvider's member/dev token (which in dev is the dev-user bypass, the
  // path that let a "guest" delete a member's comment). Members pass no token → the session is used.
  const authToken = token ?? sessionToken;
  const { data: threads } = useComments(pageId, authToken);
  const { createThread, reply, remove } = useCommentMutations(pageId, authToken);
  const [inlineHint, setInlineHint] = useState<string | null>(null);

  // Page not viewable (server returned null) → render nothing (no-leak).
  if (threads === null || threads === undefined) return null;

  // #214 part 2: the resolve/open-tabs split is removed — ONE list of all threads. part 4: newest first
  // (source is oldest-first creation order; the `[…]` copy keeps the query cache immutable).
  const shown = [...threads].reverse();

  const addInline = () => {
    const anchor = anchorGetterRef.current?.();
    if (!anchor) { setInlineHint(tr("commentsPanel.selectFirst")); return; }
    setInlineHint(null);
    const body = window.prompt(tr("commentsPanel.promptInline", { quote: anchor.quotedText.slice(0, 40) }));
    if (!body?.trim()) return;
    createThread.mutate({ body: body.trim(), kind: "inline", anchorStart: anchor.anchorStart, anchorEnd: anchor.anchorEnd, quotedText: anchor.quotedText });
  };

  return (
    <RightPanel
      testId="comments-panel"
      title={tr("page.comments")}
      onClose={onClose}
    >
      {canComment && (
        <div className="flex flex-col gap-2">
          <Button size="sm" data-testid="add-inline" onClick={addInline}>{tr("commentsPanel.addInline")}</Button>
          {inlineHint && <p className={hint}>{inlineHint}</p>}
        </div>
      )}

      <div className="flex flex-col gap-2">
        {shown.length === 0 && <p className={hint}>{tr("commentsPanel.emptyOpen")}</p>}
        {shown.map((t) => (
          <div key={t.id} className="flex flex-col gap-2 rounded-lg border border-border bg-background px-3 py-2" data-testid="comment-thread">
            {t.kind === "inline" && (
              <blockquote className="m-0 border-l-[3px] border-[var(--accent)] py-0.5 pl-2 text-[0.85em] text-fg-dim">{t.quotedText || tr("commentsPanel.anchoredDeleted")}</blockquote>
            )}
            {t.comments.map((c) => (
              <div key={c.id} className="flex flex-col gap-0.5" data-testid="comment-item">
                <div className="flex items-center gap-1.5">
                  <AuthorChip sub={c.authorSub} />
                  {c.canModify && (
                    <button type="button" className="cursor-pointer border-0 bg-transparent p-0 text-[0.8em] text-[var(--danger)] opacity-80 hover:underline hover:opacity-100" data-testid="comment-delete" onClick={() => remove.mutate(c.id)}>{tr("commentsPanel.delete")}</button>
                  )}
                </div>
                <span className="whitespace-pre-wrap text-[0.92em] [overflow-wrap:anywhere]">{c.body}</span>
              </div>
            ))}
            {canComment && (
              <Composer pageId={pageId} token={authToken} placeholder={tr("commentsPanel.reply")} onSubmit={(body, mentions) => reply.mutate({ threadId: t.id, body, mentions })} />
            )}
          </div>
        ))}
      </div>

      {canComment && (
        // #214 part 3: the composer stays PINNED to the panel bottom (sticky) while the thread list
        // scrolls above it, so it never gets buried by a long history. The negative margins + panel bg
        // extend the sticky bar to the panel edges and cover the threads scrolling under it (RightPanel is
        // the `overflow-y-auto` scroll container; RightPanel itself is unchanged — comments-panel only).
        <div className="sticky bottom-0 z-10 -mx-3 -mb-3 mt-auto flex flex-col gap-2 border-t border-border bg-panel px-3 pb-3 pt-2">
          <Composer pageId={pageId} token={authToken} placeholder={tr("commentsPanel.pagePlaceholder")} onSubmit={(body, mentions) => createThread.mutate({ body, kind: "page", mentions })} />
        </div>
      )}
    </RightPanel>
  );
}
