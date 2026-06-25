import { useRef, useState, type MutableRefObject } from "react";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import { Button } from "../ui/Button";
import { useEscClose } from "../ui/useEscClose";
import { useSession } from "../session/SessionProvider";
import { useComments, useCommentMutations, fetchMentionable } from "../data/comments";
import type { Mentionable } from "../data/commentsApi";
import type { AnchorGetter } from "../editor/Editor";

// Tailwind class groups (migrated off CSS Modules). wks-slide-right = the global slide-in
// keyframe; the panel chrome matches History/Attachments.
const panel = "wks-slide-right flex min-h-0 w-[320px] flex-none flex-col gap-3 overflow-y-auto border-l border-border bg-panel p-3";
const closeBtn = "inline-flex items-center justify-center rounded-md p-1 text-fg-dim hover:bg-panel-2 hover:text-foreground";
const hint = "m-0 text-sm text-fg-dim";
const textareaCls = "box-border min-h-[56px] w-full resize-y rounded-md border border-border bg-background p-2 text-[0.92em] text-foreground focus-visible:border-[var(--accent)] focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-[var(--accent)]";
const suggestCls = "absolute bottom-full left-0 right-0 z-20 m-0 mb-1 list-none rounded-md border border-border bg-panel p-1 shadow-[0_6px_20px_rgba(0,0,0,0.25)]";
const suggestBtn = "block w-full rounded px-2 py-[5px] text-left text-[0.9em] text-foreground hover:bg-panel-2";
const tabCls = "rounded-[5px] px-2.5 py-[3px] text-xs text-fg-dim aria-[pressed=true]:bg-background aria-[pressed=true]:text-foreground aria-[pressed=true]:shadow-[0_1px_2px_rgba(0,0,0,0.15)]";

// Composer with @mention autocomplete. Suggestions come from the page-scoped
// mentionable directory (server limits it to members who can VIEW this page), so a
// member who can't see the page never appears as a suggestion.
function Composer({ pageId, onSubmit, placeholder }: { pageId: string; onSubmit: (body: string, mentions: string[]) => void; placeholder: string }) {
  const { t } = useTranslation();
  const { token } = useSession();
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

export function CommentsPanel({ pageId, canComment, anchorGetterRef, onClose }: { pageId: string; canComment: boolean; anchorGetterRef: MutableRefObject<AnchorGetter | null>; onClose: () => void }) {
  const { t: tr } = useTranslation(); // `t` is used as the thread loop var below
  const { sub: me } = useSession();
  useEscClose(onClose);
  const { data: threads } = useComments(pageId);
  const { createThread, reply, setStatus, remove } = useCommentMutations(pageId);
  const [tab, setTab] = useState<"open" | "resolved">("open");
  const [inlineHint, setInlineHint] = useState<string | null>(null);

  // Page not viewable (server returned null) → render nothing (no-leak).
  if (threads === null || threads === undefined) return null;

  const shown = threads.filter((t) => t.status === tab);

  const addInline = () => {
    const anchor = anchorGetterRef.current?.();
    if (!anchor) { setInlineHint(tr("commentsPanel.selectFirst")); return; }
    setInlineHint(null);
    const body = window.prompt(tr("commentsPanel.promptInline", { quote: anchor.quotedText.slice(0, 40) }));
    if (!body?.trim()) return;
    createThread.mutate({ body: body.trim(), kind: "inline", anchorStart: anchor.anchorStart, anchorEnd: anchor.anchorEnd, quotedText: anchor.quotedText });
  };

  return (
    <aside className={panel} data-testid="comments-panel">
      <header className="flex items-center justify-between">
        <span className="text-[14px] font-semibold">{tr("page.comments")}</span>
        <div className="inline-flex items-center gap-2">
          <div className="inline-flex gap-0.5 rounded-[7px] bg-panel-2 p-0.5">
            <button type="button" className={tabCls} data-testid="tab-open" aria-pressed={tab === "open"} onClick={() => setTab("open")}>{tr("commentsPanel.open")}</button>
            <button type="button" className={tabCls} data-testid="tab-resolved" aria-pressed={tab === "resolved"} onClick={() => setTab("resolved")}>{tr("commentsPanel.resolved")}</button>
          </div>
          <button type="button" className={closeBtn} data-testid="comments-close" aria-label={tr("common.close")} onClick={onClose}>
            <X size={16} aria-hidden />
          </button>
        </div>
      </header>

      {canComment && (
        <div className="flex flex-col gap-2">
          <Button size="sm" data-testid="add-inline" onClick={addInline}>{tr("commentsPanel.addInline")}</Button>
          {inlineHint && <p className={hint}>{inlineHint}</p>}
        </div>
      )}

      <div className="flex flex-col gap-2">
        {shown.length === 0 && <p className={hint}>{tab === "open" ? tr("commentsPanel.emptyOpen") : tr("commentsPanel.emptyResolved")}</p>}
        {shown.map((t) => (
          <div key={t.id} className="flex flex-col gap-2 rounded-lg border border-border bg-background px-3 py-2" data-testid="comment-thread">
            {t.kind === "inline" && (
              <blockquote className="m-0 border-l-[3px] border-[var(--accent)] py-0.5 pl-2 text-[0.85em] text-fg-dim">{t.quotedText || tr("commentsPanel.anchoredDeleted")}</blockquote>
            )}
            {t.comments.map((c) => (
              <div key={c.id} className="flex flex-col gap-0.5" data-testid="comment-item">
                <div className="flex items-baseline gap-1.5">
                  <span className="text-[0.8em] font-semibold text-fg-dim">{c.authorSub}</span>
                  {c.authorSub === me && (
                    <button type="button" className="cursor-pointer border-0 bg-transparent p-0 text-[0.8em] text-[var(--danger)] opacity-80 hover:underline hover:opacity-100" data-testid="comment-delete" onClick={() => remove.mutate(c.id)}>{tr("commentsPanel.delete")}</button>
                  )}
                </div>
                <span className="whitespace-pre-wrap text-[0.92em] [overflow-wrap:anywhere]">{c.body}</span>
              </div>
            ))}
            {canComment && (
              <>
                <Composer pageId={pageId} placeholder={tr("commentsPanel.reply")} onSubmit={(body, mentions) => reply.mutate({ threadId: t.id, body, mentions })} />
                <div className="flex items-center gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    data-testid="thread-toggle"
                    onClick={() => setStatus.mutate({ threadId: t.id, action: t.status === "open" ? "resolve" : "reopen" })}
                  >
                    {t.status === "open" ? tr("commentsPanel.resolve") : tr("commentsPanel.reopen")}
                  </Button>
                </div>
              </>
            )}
          </div>
        ))}
      </div>

      {canComment && tab === "open" && (
        <div className="flex flex-col gap-2">
          <Composer pageId={pageId} placeholder={tr("commentsPanel.pagePlaceholder")} onSubmit={(body, mentions) => createThread.mutate({ body, kind: "page", mentions })} />
        </div>
      )}
    </aside>
  );
}
