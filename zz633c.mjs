import { chromium } from "@playwright/test";
import { readFileSync } from "node:fs";
const SID = readFileSync("/tmp/claude-1000/-home-owner-tmp-knowledge-saas-wikistead/f1fbed15-88b6-4e11-9db2-01fced44ed62/scratchpad/admin-sid.txt","utf8").trim();
const b = await chromium.launch();
const c = await b.newContext({ viewportSize:{width:1200,height:1000} });
await c.addCookies([{name:"wks_sess",value:SID,domain:"dev.localhost",path:"/",httpOnly:true,sameSite:"Lax"}]);
await c.addInitScript(()=>{try{localStorage.setItem("wks.lang","ja")}catch{}});
const p = await c.newPage();
for (const path of ["/settings/account","/account"]) {
  await p.goto(`http://dev.localhost:5173${path}`,{waitUntil:"domcontentloaded"});
  await p.waitForTimeout(4000);
  const r = await p.evaluate(() => {
    const t = document.body.innerText;
    return { url: location.pathname, len: t.length,
      hasVimMono: t.includes("vim のときは等幅"),
      fontNameChoices: (t.match(/UDEV|Wikistead Mono|Noto Sans|Inter/g)||[]),
      switches: document.querySelectorAll("[role=switch]").length,
      selects: document.querySelectorAll("select").length };
  });
  console.log(path, JSON.stringify(r));
  if (r.hasVimMono) break;
}
await b.close();
