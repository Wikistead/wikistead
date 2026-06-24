import { useRef, useState, type MutableRefObject } from "react";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import { Button } from "../ui/Button";
import { useEscClose } from "../ui/useEscClose";
import { useSession } from "../session/SessionProvider";
import { useComments, useCommentMutations, fetchMentionable } from "../data/comments";
import type { Mentionable } from "../data/commentsApi";
import type { AnchorGetter } from "../editor/Editor";
import styles from "./CommentsPanel.module.css";

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
    <div className={styles.composer}>
      <textarea
        className={styles.textarea}
        data-testid="comment-input"
        value={text}
        placeholder={placeholder}
        onChange={(e) => void onChange(e.target.value)}
      />
      {suggest.length > 0 && (
        <ul className={styles.suggest} data-testid="mention-suggest">
          {suggest.map((s) => (
            <li key={s.sub}>
              <button type="button" data-testid="mention-option" onMouseDown={(e) => { e.preventDefault(); pick(s); }}>
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
    <aside className={styles.panel} data-testid="comments-panel">
      <header className={styles.header}>
        <span className={styles.title}>{tr("page.comments")}</span>
        <div className={styles.headerRight}>
          <div className={styles.tabs}>
            <button type="button" className={styles.tab} data-testid="tab-open" aria-pressed={tab === "open"} onClick={() => setTab("open")}>{tr("commentsPanel.open")}</button>
            <button type="button" className={styles.tab} data-testid="tab-resolved" aria-pressed={tab === "resolved"} onClick={() => setTab("resolved")}>{tr("commentsPanel.resolved")}</button>
          </div>
          <button type="button" className={styles.close} data-testid="comments-close" aria-label={tr("common.close")} onClick={onClose}>
            <X size={16} aria-hidden />
          </button>
        </div>
      </header>

      {canComment && (
        <div className={styles.section}>
          <Button size="sm" data-testid="add-inline" onClick={addInline}>{tr("commentsPanel.addInline")}</Button>
          {inlineHint && <p className={styles.hint}>{inlineHint}</p>}
        </div>
      )}

      <div className={styles.threads}>
        {shown.length === 0 && <p className={styles.hint}>{tab === "open" ? tr("commentsPanel.emptyOpen") : tr("commentsPanel.emptyResolved")}</p>}
        {shown.map((t) => (
          <div key={t.id} className={styles.thread} data-testid="comment-thread">
            {t.kind === "inline" && (
              <blockquote className={styles.quote}>{t.quotedText || tr("commentsPanel.anchoredDeleted")}</blockquote>
            )}
            {t.comments.map((c) => (
              <div key={c.id} className={styles.comment} data-testid="comment-item">
                <div className={styles.commentHead}>
                  <span className={styles.author}>{c.authorSub}</span>
                  {c.authorSub === me && (
                    <button type="button" className={styles.link} data-testid="comment-delete" onClick={() => remove.mutate(c.id)}>{tr("commentsPanel.delete")}</button>
                  )}
                </div>
                <span className={styles.body}>{c.body}</span>
              </div>
            ))}
            {canComment && (
              <>
                <Composer pageId={pageId} placeholder={tr("commentsPanel.reply")} onSubmit={(body, mentions) => reply.mutate({ threadId: t.id, body, mentions })} />
                <div className={styles.threadActions}>
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
        <div className={styles.section}>
          <Composer pageId={pageId} placeholder={tr("commentsPanel.pagePlaceholder")} onSubmit={(body, mentions) => createThread.mutate({ body, kind: "page", mentions })} />
        </div>
      )}
    </aside>
  );
}
