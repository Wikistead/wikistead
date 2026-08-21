import { useTranslation } from "react-i18next";
import { useEntitlements } from "../data/queries";
import { SELF_HOSTING_GUIDE } from "./product-name";

/**
 * What a member with no space at all is told (#864).
 *
 * Its own module because of the line this ticket added: the guide is offered on a SELF-HOSTED install
 * and nowhere else, and a condition that decides what an operator sees is worth being able to drive
 * from a test without standing up the whole router.
 */
export function HomeEmpty() {
  const { t } = useTranslation();
  const entitlements = useEntitlements();
  return (
    <div className="max-w-[560px] p-6 text-fg-dim" data-testid="home-no-spaces">
      <h2 className="mt-0 text-foreground">{t("home.emptyTitle")}</h2>
      <p>{t("home.emptyBody")}</p>
      {/* #864 (#806): on a self-hosted install the person meeting this screen is usually the one
          who stood the server up minutes ago, so "ask an administrator" is advice to ask themselves,
          and there is no way from here to the setup guide. On the managed deployment the sentence is
          correct and there is no server of theirs to configure — so the offer is made in one case only.

          The condition is a DEPLOYMENT fact, not a lever: every lever is UNLIMITED both self-hosted and
          on a top Cloud plan. `selfHosted` comes from the resolver registration the edition performs at
          composition time (ADR-015). Undefined (the query has not answered, or an older server does not
          send it) offers nothing — guessing would put an operator's link in front of a paying tenant. */}
      {entitlements.data?.selfHosted === true && (
        <p>
          <a href={SELF_HOSTING_GUIDE} target="_blank" rel="noreferrer" data-testid="home-self-hosting-guide">
            {t("home.emptySelfHostGuide")}
          </a>
        </p>
      )}
    </div>
  );
}
