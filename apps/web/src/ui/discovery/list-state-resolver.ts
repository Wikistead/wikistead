// ADR-266 §3.2: the checker resolves the IDENTIFIER an empty branch's condition reads, not the
// spelling of its i18n key. This module is the resolver; the test that walks the tree and applies
// it is `../error-is-not-empty-888.test.ts`.
import ts from "typescript";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export function walkFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) {
      // "discovery" is this checker's own tooling, not a rendered surface — walking it risks the
      // checker's own doc comments (which quote real i18n keys as examples) matching CANDIDATE_KEY.
      if (entry === "node_modules" || entry === "__fixtures__" || entry === "discovery") continue;
      walkFiles(p, out);
    } else if ((p.endsWith(".tsx") || p.endsWith(".ts")) && !p.includes(".test.")) {
      out.push(p);
    }
  }
  return out;
}

// Past #895 round 5's `[Ee]mpty`: a key spelled with a mid-word "No" (`moveNoTargets`, `noPages`,
// `noLinks`), or a bare `notFound`/`None` suffix, is exactly as much an empty-state key as one
// spelling "empty" — §1.3 measured seven such keys the old pattern could not see at all.
export const CANDIDATE_KEY = /\bt\("([\w.]*(?:[Ee]mpty\w*|noResults|[Nn]o[A-Z]\w*|notFound|None\b))"\)/g;

export interface Site {
  file: string;
  key: string;
  pos: number;
}

export function findSites(file: string, src: string): Site[] {
  const out: Site[] = [];
  for (const m of src.matchAll(CANDIDATE_KEY)) out.push({ file, key: m[1]!, pos: m.index! });
  return out;
}

export type Verdict =
  | { kind: "list-state" }
  | { kind: "ungated" }
  | { kind: "vacuous" }
  | { kind: "handled"; queries: string[] }
  | { kind: "unhandled"; query: string }
  | { kind: "give-up"; identifier: string; reason: string };

const QUERY_MODULE = /data\/queries/;

// Hooks that are never themselves a fetch, so reaching one contributes no query to guard against.
// Without this, `moveFilter.trim()` picking between two data sources would drag `moveFilter`'s own
// `useState("")` in and demand a `.isError` a plain string can never carry.
const NON_DATA_HOOKS = new Set([
  "useState", "useRef", "useReducer", "useContext", "useId", "useTransition", "useDeferredValue",
  "useSyncExternalStore", "useImperativeHandle", "useParams", "useNavigate", "useLocation",
  "useSearchParams", "useOutletContext", "useTranslation", "useSession", "useActiveSpace",
  "useCallback", "useEffect", "useLayoutEffect",
]);

function queryHookNames(sf: ts.SourceFile): Set<string> {
  const out = new Set<string>();
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier)) continue;
    if (!QUERY_MODULE.test(stmt.moduleSpecifier.text)) continue;
    const bindings = stmt.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) for (const el of bindings.elements) out.add(el.name.text);
  }
  return out;
}

function findEnclosingFunction(node: ts.Node): ts.FunctionLikeDeclaration | undefined {
  let n: ts.Node | undefined = node;
  while (n) {
    if (ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n)) return n;
    n = n.parent;
  }
  return undefined;
}

function findNodeAtPos(sf: ts.SourceFile, pos: number): ts.Node {
  let result: ts.Node = sf;
  const visit = (n: ts.Node): void => {
    if (pos >= n.getStart(sf) && pos < n.getEnd()) {
      result = n;
      n.forEachChild(visit);
    }
  };
  visit(sf);
  return result;
}

function isInsideListState(node: ts.Node): boolean {
  let n: ts.Node | undefined = node;
  while (n) {
    if ((ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) && n.tagName.getText() === "ListState") return true;
    n = n.parent;
  }
  return false;
}

// The empty branch's gate: the nearest ternary or `if` whose true/false arm contains this node.
// A ternary's condition and an `if`'s condition both sit textually BEFORE either arm, which is what
// makes "textually earlier, in the same component" a sound stand-in for "on an excluding branch"
// throughout this file — no separate control-flow model is built.
function findGate(node: ts.Node, fn: ts.FunctionLikeDeclaration): ts.Expression | undefined {
  let n: ts.Node = node;
  while (n.parent && n !== fn) {
    const parent: ts.Node = n.parent;
    if (ts.isConditionalExpression(parent) && (parent.whenTrue === n || parent.whenFalse === n)) return parent.condition;
    if (ts.isIfStatement(parent) && (parent.thenStatement === n || parent.elseStatement === n)) return parent.expression;
    // `cond && <Empty/>` gates just as much as a ternary — SpacePagesTab's own pages.empty is drawn
    // this way (`!pages.isLoading && !pages.isError && rows.length === 0 && <p>…</p>`), and without
    // this a `&&`-gated site would read as ungated (vacuously safe) rather than actually checked.
    if (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken && parent.right === n) {
      return parent.left;
    }
    n = parent;
  }
  return undefined;
}

function collectBaseIdentifiers(node: ts.Node): Set<string> {
  const out = new Set<string>();
  const visit = (n: ts.Node): void => {
    if (ts.isPropertyAccessExpression(n)) return visit(n.expression);
    if (ts.isElementAccessExpression(n)) return visit(n.expression);
    if (ts.isNonNullExpression(n) || ts.isParenthesizedExpression(n) || ts.isAsExpression(n)) return visit(n.expression);
    if (ts.isCallExpression(n)) return visit(n.expression); // arguments deliberately unwalked — see resolveExpr
    if (ts.isBinaryExpression(n)) { visit(n.left); visit(n.right); return; }
    if (ts.isConditionalExpression(n)) { visit(n.condition); visit(n.whenTrue); visit(n.whenFalse); return; }
    if (ts.isPrefixUnaryExpression(n)) return visit(n.operand);
    // #1016: an object literal reaches here now that call arguments are walked (`fn({ hasPassword:
    // set.data?.hasPassword })`). The generic fallback below would also visit each PROPERTY KEY as a
    // plain Identifier — `hasPassword` the key, not `hasPassword` a binding — producing a base
    // identifier this component never declared. Only the values (and a shorthand's own name) refer to
    // anything in scope.
    if (ts.isObjectLiteralExpression(n)) {
      for (const prop of n.properties) {
        if (ts.isPropertyAssignment(prop)) visit(prop.initializer);
        else if (ts.isShorthandPropertyAssignment(prop)) visit(prop.name);
        else if (ts.isSpreadAssignment(prop)) visit(prop.expression);
      }
      return;
    }
    if (ts.isIdentifier(n)) { out.add(n.text); return; }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return out;
}

export interface QueryRef { name: string; guardTokens: string[] }
export type Resolved = { queries: QueryRef[] } | { giveUp: string; reason: string };

type Decl =
  | { kind: "param" }
  | { kind: "simple"; init?: ts.Expression }
  | { kind: "destructure"; init?: ts.Expression; pattern: ts.ObjectBindingPattern };

function findDeclOf(fn: ts.FunctionLikeDeclaration, name: string): Decl | undefined {
  for (const p of fn.parameters) {
    if (ts.isIdentifier(p.name) && p.name.text === name) return { kind: "param" };
    if (ts.isObjectBindingPattern(p.name) && p.name.elements.some((el) => ts.isIdentifier(el.name) && el.name.text === name)) {
      return { kind: "param" };
    }
  }
  if (!fn.body) return undefined;
  let found: Decl | undefined;
  const visit = (n: ts.Node): void => {
    if (found) return;
    if (ts.isVariableDeclaration(n)) {
      if (ts.isIdentifier(n.name) && n.name.text === name) { found = { kind: "simple", init: n.initializer }; return; }
      if (ts.isObjectBindingPattern(n.name) && n.name.elements.some((el) => ts.isIdentifier(el.name) && el.name.text === name)) {
        found = { kind: "destructure", init: n.initializer, pattern: n.name };
        return;
      }
      // `const [hover, setHover] = useState(...)` — array-bound, so it can never carry `.isError`.
      // Sharing the "simple" shape lets the NON_DATA_HOOKS check in resolveExpr clear it as vacuous
      // instead of a give-up, which is what `useState` actually is here.
      if (ts.isArrayBindingPattern(n.name) && n.name.elements.some((el) => ts.isBindingElement(el) && ts.isIdentifier(el.name) && el.name.text === name)) {
        found = { kind: "simple", init: n.initializer };
        return;
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(fn.body);
  return found;
}

function isQueryCall(node: ts.Expression | undefined, hooks: Set<string>): node is ts.CallExpression {
  return !!node && ts.isCallExpression(node) && ts.isIdentifier(node.expression) && hooks.has(node.expression.text);
}

function siblingGuardTokens(pattern: ts.ObjectBindingPattern): string[] {
  const out: string[] = [];
  for (const el of pattern.elements) {
    const propName = el.propertyName && ts.isIdentifier(el.propertyName) ? el.propertyName.text
      : ts.isIdentifier(el.name) ? el.name.text : undefined;
    if ((propName === "isError" || propName === "error") && ts.isIdentifier(el.name)) out.push(el.name.text);
  }
  return out;
}

function resolveExpr(fn: ts.FunctionLikeDeclaration, expr: ts.Expression, hooks: Set<string>, visited: Set<string>): Resolved {
  if (ts.isConditionalExpression(expr)) {
    const a = resolveExpr(fn, expr.whenTrue, hooks, visited);
    if ("giveUp" in a) return a;
    const b = resolveExpr(fn, expr.whenFalse, hooks, visited);
    if ("giveUp" in b) return b;
    return { queries: [...a.queries, ...b.queries] };
  }
  if (ts.isCallExpression(expr) && ts.isIdentifier(expr.expression)) {
    const callee = expr.expression.text;
    if (hooks.has(callee) || NON_DATA_HOOKS.has(callee)) return { queries: [] };
    // #895/#500's own history is what this guards against: a hook-SHAPED call this resolver does
    // not recognise is exactly the "silent approximation" §1.2 keeps finding, so it gives up rather
    // than guessing it is safe.
    // dash-ok: developer-facing residue-table text, not UI copy
    if (/^use[A-Z]/.test(callee)) return { giveUp: callee, reason: `bound to ${callee}(...) — not imported from a queries module, so the resolver cannot tell whether it can fail` };
    // #1016: a plain helper wrapping query data (`visible(backlinks.data ?? [])`) carries the query
    // reference in its ARGUMENTS, not in the callee — walk those the same way any other expression is
    // walked, instead of dropping them on the floor. The callee's own body is never opened: whatever
    // query backs the result is already visible at the call site, in the argument expression.
    if (expr.arguments.length === 0) {
      // dash-ok: developer-facing residue-table text, not UI copy
      return { giveUp: callee, reason: `bound to ${callee}(...) — a zero-argument call the resolver cannot trace to a query` };
    }
    const argResults = expr.arguments.map((arg) => resolveExpr(fn, arg, hooks, visited));
    const argGiveUp = argResults.find((r): r is { giveUp: string; reason: string } => "giveUp" in r);
    if (argGiveUp) return argGiveUp;
    return { queries: argResults.flatMap((r) => ("queries" in r ? r.queries : [])) };
  }
  const ids = collectBaseIdentifiers(expr);
  if (ids.size === 0) return { queries: [] };
  const all: QueryRef[] = [];
  for (const id of ids) {
    const r = resolveIdentifier(fn, id, hooks, new Set(visited));
    if ("giveUp" in r) return r;
    all.push(...r.queries);
  }
  return { queries: all };
}

export function resolveIdentifier(fn: ts.FunctionLikeDeclaration, name: string, hooks: Set<string>, visited: Set<string> = new Set()): Resolved {
  if (visited.has(name)) return { giveUp: name, reason: "cyclic alias" };
  visited.add(name);
  const decl = findDeclOf(fn, name);
  if (!decl) return { giveUp: name, reason: "no declaration found in this component" };
  // dash-ok: developer-facing residue-table text, not UI copy
  if (decl.kind === "param") return { giveUp: name, reason: "bound to a prop — the fetch belongs to the caller" };

  if (decl.kind === "simple") {
    if (!decl.init) return { giveUp: name, reason: "declared with no initializer" };
    if (isQueryCall(decl.init, hooks)) return { queries: [{ name, guardTokens: [`${name}.isError`, `${name}.error`] }] };
    return resolveExpr(fn, decl.init, hooks, visited);
  }

  // destructure
  if (isQueryCall(decl.init, hooks)) return { queries: [{ name, guardTokens: siblingGuardTokens(decl.pattern) }] };
  if (!decl.init) return { giveUp: name, reason: "declared with no initializer" };
  return resolveExpr(fn, decl.init, hooks, visited);
}

interface GuardOccurrence { pos: number; condition: ts.Expression }

function collectGuardOccurrences(fn: ts.FunctionLikeDeclaration): GuardOccurrence[] {
  const out: GuardOccurrence[] = [];
  if (!fn.body) return out;
  const visit = (n: ts.Node): void => {
    if (ts.isConditionalExpression(n)) out.push({ pos: n.condition.getStart(), condition: n.condition });
    if (ts.isIfStatement(n)) out.push({ pos: n.expression.getStart(), condition: n.expression });
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
      out.push({ pos: n.left.getStart(), condition: n.left });
    }
    ts.forEachChild(n, visit);
  };
  visit(fn.body);
  return out;
}

function conditionMatchesToken(condition: ts.Node, token: string): boolean {
  let found = false;
  const dot = token.indexOf(".");
  const visit = (n: ts.Node): void => {
    if (found) return;
    if (dot === -1) {
      if (ts.isIdentifier(n) && n.text === token) found = true;
    } else {
      const ident = token.slice(0, dot);
      const prop = token.slice(dot + 1);
      if (ts.isPropertyAccessExpression(n) && n.name.text === prop && collectBaseIdentifiers(n.expression).has(ident)) found = true;
    }
    if (!found) ts.forEachChild(n, visit);
  };
  visit(condition);
  return found;
}

// SpacePagesTab's move-destination guard is `moveIsError`, a plain boolean assigned by its own
// ternary (`moveFilter.trim() ? moveSearch.isError : spaces.isError`) rather than either query's
// `.isError` written directly into the JSX condition. A direct text match cannot see through that
// one hop, so a bare identifier in the condition is chased to its own declaration and re-checked —
// same alias-one-hop-at-a-time rule §3.2 asks for on the query side, applied to the guard side too.
function guardMatches(fn: ts.FunctionLikeDeclaration, condition: ts.Node, guardTokens: string[], visited: Set<string> = new Set()): boolean {
  if (guardTokens.some((t) => conditionMatchesToken(condition, t))) return true;
  for (const id of collectBaseIdentifiers(condition)) {
    if (visited.has(id)) continue;
    const decl = findDeclOf(fn, id);
    if (!decl || decl.kind !== "simple" || !decl.init) continue;
    const nextVisited = new Set(visited);
    nextVisited.add(id);
    if (guardMatches(fn, decl.init, guardTokens, nextVisited)) return true;
  }
  return false;
}

function isGuarded(fn: ts.FunctionLikeDeclaration, targetPos: number, guardTokens: string[]): boolean {
  if (guardTokens.length === 0) return false;
  return collectGuardOccurrences(fn).some((occ) => occ.pos < targetPos && guardMatches(fn, occ.condition, guardTokens));
}

// For a DELEGATED component (the data is a prop, so the fetch belongs to whoever renders it): is a
// named query's failure drawn before the given position in whichever component that render sits in?
export function isFailureGuardedBefore(sf: ts.SourceFile, pos: number, guardTokens: string[]): boolean {
  const node = findNodeAtPos(sf, pos);
  const fn = findEnclosingFunction(node);
  if (!fn || !fn.body) return false;
  return isGuarded(fn, pos, guardTokens);
}

// routes.tsx's own page-not-found branch reads `pageId && pageQ.isError` — the gate ALSO contains
// `pageId`, a routing param the resolver cannot trace, but the branch is already self-evidently the
// failure branch (it names `.isError` directly). Requiring every identifier in a compound condition
// to resolve would give up on this one for a reason that has nothing to do with the query it draws
// on failure — the same "GuestSidebar's own error ternary" shape TERNARY_ON_FAILURE always accepted.
function containsDirectErrorCheck(node: ts.Node): boolean {
  let found = false;
  const visit = (n: ts.Node): void => {
    if (found) return;
    if (ts.isPropertyAccessExpression(n) && (n.name.text === "isError" || n.name.text === "error")) { found = true; return; }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

export function judgeSite(sf: ts.SourceFile, site: Site): Verdict {
  const node = findNodeAtPos(sf, site.pos);
  if (isInsideListState(node)) return { kind: "list-state" };
  const fn = findEnclosingFunction(node);
  if (!fn || !fn.body) return { kind: "give-up", identifier: "<no enclosing component>", reason: "not inside a function" };
  const gate = findGate(node, fn);
  if (!gate) return { kind: "ungated" };
  if (containsDirectErrorCheck(gate)) return { kind: "handled", queries: ["<direct .isError check in the condition>"] };
  const hooks = queryHookNames(sf);
  const ids = collectBaseIdentifiers(gate);
  if (ids.size === 0) return { kind: "vacuous" };
  const refs: QueryRef[] = [];
  for (const id of ids) {
    const r = resolveIdentifier(fn, id, hooks);
    if ("giveUp" in r) return { kind: "give-up", identifier: r.giveUp, reason: r.reason };
    refs.push(...r.queries);
  }
  if (refs.length === 0) return { kind: "vacuous" };
  for (const ref of refs) if (!isGuarded(fn, site.pos, ref.guardTokens)) return { kind: "unhandled", query: ref.name };
  return { kind: "handled", queries: refs.map((r) => r.name) };
}
