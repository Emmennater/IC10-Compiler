/**
 * Lexical scope analysis for editor features (completion, hover, go-to-
 * definition, rename, scope-aware highlighting). This is a *separate, lighter*
 * pass than lowering: it builds no IR, it only answers "what names are in scope
 * here", "what does this identifier refer to", and "where is it defined".
 * Both editors (the VS Code language server and CodeMirror) consume it, so name
 * resolution stays in one place.
 *
 * Scoping mirrors what the lowerer's ScopeChain does (symbols.ts): blocks nest,
 * a function body hides the caller's non-global locals, and globals are visible
 * everywhere. Visibility here is position-insensitive within a scope (a name is
 * visible in the whole scope it is declared in, not only after its line) -- that
 * suits "declared vs not" highlighting and forward references like recursion or
 * a function called above its definition.
 *
 * When a `FileHandler` is supplied, `import` names are resolved into the module
 * they come from: the imported name takes the module binding's kind, and its
 * definition site (module + range) is recorded so go-to-definition can cross
 * files. Module scanning is shallow (one level, no following the module's own
 * imports) and best-effort -- an unreadable or unparseable module just leaves
 * the name as a generic `import`.
 */

import type { SyntaxNode } from "./ast.ts";
import { getAST } from "./ast.ts";
import { getFormalAST } from "./formal-ast.ts";
import { modulePath, type FileHandler } from "./modules.ts";
import type {
  Block,
  Statement,
  Expression,
  AssignTarget,
  Identifier,
  Range,
} from "./formal-ast.ts";

/** What a name refers to. */
export type SymbolKind =
  | "var"
  | "const"
  | "define"
  | "device"
  | "function"
  | "param"
  | "list"
  | "stackvar"
  | "import";

export type SymbolInfo = { name: string; kind: SymbolKind };

/** How scope-aware highlighting should treat an identifier occurrence. */
export type HighlightHint = "readonly" | "undeclared";

/** Where an imported name is actually defined. */
export type SymbolOrigin = { modulePath: string; range: Range };

export type Sym = {
  name: string;
  kind: SymbolKind;
  /** Identifier range of the binding site in *this* file (the `import` line for imports). */
  declRange: Range;
  /**
   * A source snippet of the declaration, for hover: the whole statement for
   * most bindings, just the header (`fn add(x, y)`) for functions, and the
   * resolved module declaration for imports.
   */
  signature: string;
  /** Set for imported names: the module and the definition range within it. */
  origin?: SymbolOrigin;
};

/** One identifier occurrence and the symbol it resolves to (null = undeclared). */
export type Occurrence = { range: Range; name: string; symbol: Sym | null };

export type ScopeAnalysis = {
  /** The highlight hint for the identifier that starts at `from`, if any. */
  hintAt(from: number): HighlightHint | undefined;
  /** The names visible at a source offset, innermost shadowing outermost. */
  symbolsAt(offset: number): SymbolInfo[];
  /** The identifier occurrence covering `offset`, if any. */
  occurrenceAt(offset: number): Occurrence | undefined;
  /** Every occurrence (declaration and uses) of one symbol, for rename. */
  occurrencesOf(symbol: Sym): Occurrence[];
};

type ScopeNode = {
  range: Range;
  parent: ScopeNode | null;
  /** True for a function body: caller locals above it are hidden. */
  functionBoundary: boolean;
  symbols: Map<string, Sym>;
  children: ScopeNode[];
};

/** `const`/`define` are the read-only bindings the highlighter tints. */
function isReadonlyKind(kind: SymbolKind): boolean {
  return kind === "const" || kind === "define";
}

function rangeOf(node: Range): Range {
  return { from: node.from, to: node.to };
}

/**
 * The source snippet shown on hover: the whole statement, except a function is
 * cut at its body so only the header (`fn add(x, y)`) shows. `base` is the
 * offset the `text` starts at (0 for a freshly parsed module, the root's `from`
 * for the main file).
 */
function declSnippet(text: string, statement: Statement, base: number): string {
  const start = statement.from - base;
  const end = (statement.type === "functiondef" ? statement.body.from : statement.to) - base;
  return text.slice(start, end).trim();
}

/** What a top-level statement declares, for scanning an imported module. */
function topLevelDecl(statement: Statement): { name: string; kind: SymbolKind; range: Range }[] {
  switch (statement.type) {
    case "declaration":
      return [{ name: statement.target.name, kind: statement.constant ? "const" : "var", range: rangeOf(statement.target) }];
    case "definedef":
      return [{ name: statement.name.name, kind: "define", range: rangeOf(statement.name) }];
    case "devicedef":
      return [{ name: statement.name.name, kind: "device", range: rangeOf(statement.name) }];
    case "stackdeclaration":
      return [{ name: statement.name.name, kind: "stackvar", range: rangeOf(statement.name) }];
    case "arraydeclaration":
      return [{ name: statement.name.name, kind: "list", range: rangeOf(statement.name) }];
    case "functiondef":
      return [{ name: statement.name.name, kind: "function", range: rangeOf(statement.name) }];
    case "import":
      return statement.names.map(ident => ({ name: ident.name, kind: "import" as SymbolKind, range: rangeOf(ident) }));
    default:
      return [];
  }
}

/** The kind, definition range, and hover snippet of one exported name. */
function moduleExport(
  source: string,
  name: string,
): { kind: SymbolKind; range: Range; signature: string } | undefined {
  let module: Block;
  try {
    module = getFormalAST(getAST(source));
  } catch {
    return undefined; // module doesn't parse; leave the import generic
  }
  for (const statement of module.statements) {
    for (const decl of topLevelDecl(statement)) {
      if (decl.name === name) {
        return { kind: decl.kind, range: decl.range, signature: declSnippet(source, statement, 0) };
      }
    }
  }
  return undefined;
}

/**
 * Analyze the program's scopes. Throws whatever `getFormalAST` throws on a
 * syntax error in the *main* file, so callers doing best-effort work on
 * half-typed source should catch and fall back. (Errors in imported modules are
 * swallowed; that import just stays unresolved.)
 */
export function analyzeScopes(ast: SyntaxNode, fileHandler?: FileHandler): ScopeAnalysis {
  const module = getFormalAST(ast);
  // The root node's text is the whole file; `ast.from` is where it starts, so
  // absolute node offsets map into it as `offset - ast.from`.
  const source = ast.text;
  const snippetOf = (statement: Statement): string => declSnippet(source, statement, ast.from);

  const root: ScopeNode = {
    range: rangeOf(ast),
    parent: null,
    functionBoundary: false,
    symbols: new Map(),
    children: [],
  };
  const occurrences: Occurrence[] = [];
  const pendingRefs: { occ: Occurrence; name: string; scope: ScopeNode }[] = [];
  const hints = new Map<number, HighlightHint>();

  function childScope(parent: ScopeNode, range: Range, functionBoundary = false): ScopeNode {
    const scope: ScopeNode = { range: rangeOf(range), parent, functionBoundary, symbols: new Map(), children: [] };
    parent.children.push(scope);
    return scope;
  }

  function bind(
    scope: ScopeNode,
    ident: Identifier,
    kind: SymbolKind,
    signature: string,
    origin?: SymbolOrigin,
  ): void {
    const symbol: Sym = { name: ident.name, kind, declRange: rangeOf(ident), signature, origin };
    scope.symbols.set(ident.name, symbol);
    occurrences.push({ range: rangeOf(ident), name: ident.name, symbol });
    if (isReadonlyKind(kind)) hints.set(ident.from, "readonly");
  }

  function reference(ident: Identifier, scope: ScopeNode): void {
    const occ: Occurrence = { range: rangeOf(ident), name: ident.name, symbol: null };
    occurrences.push(occ);
    pendingRefs.push({ occ, name: ident.name, scope });
  }

  function resolveImport(statement: Extract<Statement, { type: "import" }>, ident: Identifier): {
    kind: SymbolKind;
    signature: string;
    origin?: SymbolOrigin;
  } {
    // Fallback: the import line itself, when the module can't be resolved.
    const fallback = { kind: "import" as SymbolKind, signature: snippetOf(statement) };
    if (!fileHandler) return fallback;
    const path = modulePath(statement.path);
    const moduleSource = fileHandler(path);
    if (typeof moduleSource !== "string") return fallback;
    const exported = moduleExport(moduleSource, ident.name);
    if (!exported) return fallback;
    return {
      kind: exported.kind,
      signature: exported.signature,
      origin: { modulePath: path, range: exported.range },
    };
  }

  function walkBlock(block: Block, scope: ScopeNode): void {
    for (const statement of block.statements) walkStatement(statement, scope);
  }

  function walkStatement(statement: Statement, scope: ScopeNode): void {
    switch (statement.type) {
      case "declaration":
        bind(scope, statement.target, statement.constant ? "const" : "var", snippetOf(statement));
        if (statement.value) walkExpr(statement.value, scope);
        break;
      case "assignment":
        walkTarget(statement.target, scope);
        walkExpr(statement.value, scope);
        break;
      case "compoundassignop":
        walkTarget(statement.target, scope);
        walkExpr(statement.right, scope);
        break;
      case "if":
        for (const arm of statement.ifs) {
          walkExpr(arm.condition, scope);
          walkBlock(arm.then, childScope(scope, arm.then));
        }
        if (statement.else) walkBlock(statement.else, childScope(scope, statement.else));
        break;
      case "loop":
        walkBlock(statement.body, childScope(scope, statement.body));
        break;
      case "while":
        walkExpr(statement.condition, scope);
        walkBlock(statement.body, childScope(scope, statement.body));
        break;
      case "repeat": {
        // `until` runs after the body and can read what the body declared.
        const bodyScope = childScope(scope, statement.body);
        walkBlock(statement.body, bodyScope);
        walkExpr(statement.until, bodyScope);
        break;
      }
      case "for": {
        // The loop variable(s) live in a scope spanning the whole `for`.
        const forScope = childScope(scope, statement);
        if (statement.init) walkStatement(statement.init, forScope);
        if (statement.condition) walkExpr(statement.condition, forScope);
        if (statement.update) walkStatement(statement.update, forScope);
        walkBlock(statement.body, forScope);
        break;
      }
      case "forin":
      case "forof": {
        const forScope = childScope(scope, statement);
        walkStatement(statement.decl, forScope);
        reference(statement.list, scope);
        walkBlock(statement.body, forScope);
        break;
      }
      case "sleep":
        walkExpr(statement.duration, scope);
        break;
      case "return":
        walkExpr(statement.value, scope);
        break;
      case "definedef":
        bind(scope, statement.name, "define", snippetOf(statement));
        walkExpr(statement.value, scope);
        break;
      case "devicedef":
        bind(scope, statement.name, "device", snippetOf(statement));
        break;
      case "stackdeclaration":
        bind(scope, statement.name, "stackvar", snippetOf(statement));
        if (statement.value) walkExpr(statement.value, scope);
        break;
      case "arraydeclaration":
        bind(scope, statement.name, "list", snippetOf(statement));
        walkExpr(statement.size, scope);
        if (statement.list) for (const el of statement.list.elements) walkExpr(el, scope);
        break;
      case "functiondef": {
        // The header (`fn add(x, y)`) is the snippet for the function and for
        // each of its parameters -- hovering a parameter shows it in context.
        const header = snippetOf(statement);
        bind(scope, statement.name, "function", header);
        const fnScope = childScope(scope, statement, true);
        for (const arg of statement.args) bind(fnScope, arg, "param", header);
        walkBlock(statement.body, fnScope);
        break;
      }
      case "functioncall":
        walkExpr(statement, scope);
        break;
      case "import": {
        for (const ident of statement.names) {
          const { kind, signature, origin } = resolveImport(statement, ident);
          bind(scope, ident, kind, signature, origin);
        }
        break;
      }
      // No names, no sub-expressions.
      case "break":
      case "continue":
      case "yield":
      case "preprocessordir":
        break;
    }
  }

  function walkTarget(target: AssignTarget, scope: ScopeNode): void {
    // Every assignable form is also an expression form; walkExpr already
    // references the device/list identifier and skips the property name.
    walkExpr(target, scope);
  }

  function walkExpr(expr: Expression, scope: ScopeNode): void {
    switch (expr.type) {
      case "identifier":
        reference(expr, scope);
        break;
      case "deviceprop":
        if (expr.device.type === "identifier") reference(expr.device, scope);
        break;
      case "devicechannelprop":
        if (expr.device.type === "identifier") reference(expr.device, scope);
        break;
      case "devicenameprop":
        if (expr.device.type === "identifier") reference(expr.device, scope);
        if (expr.name.type === "identifier") reference(expr.name, scope);
        break;
      case "listindexing":
        reference(expr.list, scope);
        walkExpr(expr.index, scope);
        break;
      case "functioncall":
        reference(expr.name, scope);
        for (const param of expr.params) walkExpr(param, scope);
        break;
      case "binaryop":
      case "comparisonop":
      case "logicalop":
        walkExpr(expr.left, scope);
        walkExpr(expr.right, scope);
        break;
      case "unaryop":
        walkExpr(expr.value, scope);
        break;
      case "ternaryop":
        walkExpr(expr.condition, scope);
        walkExpr(expr.then, scope);
        walkExpr(expr.else, scope);
        break;
      // Literals and bare device pins reference no declared name.
      case "constant":
      case "bool":
      case "string":
      case "device":
        break;
    }
  }

  /** Resolve a name from `scope` outward, honouring the function boundary. */
  function resolve(name: string, scope: ScopeNode): Sym | undefined {
    let crossedBoundary = false;
    for (let s: ScopeNode | null = scope; s; s = s.parent) {
      const isGlobal = s.parent === null;
      if (isGlobal) return s.symbols.get(name);
      if (!crossedBoundary) {
        const symbol = s.symbols.get(name);
        if (symbol !== undefined) return symbol;
      }
      if (s.functionBoundary) crossedBoundary = true;
    }
    return undefined;
  }

  // Phase 1: collect every declaration and reference occurrence.
  walkBlock(module, root);

  // Phase 2: every declaration is in place, so references resolve against the
  // complete tree (this is what makes forward references and recursion work).
  for (const { occ, name, scope } of pendingRefs) {
    const symbol = resolve(name, scope);
    occ.symbol = symbol ?? null;
    if (!symbol) {
      hints.set(occ.range.from, "undeclared");
    } else if (isReadonlyKind(symbol.kind) && !hints.has(occ.range.from)) {
      hints.set(occ.range.from, "readonly");
    }
  }

  function innermostScopeAt(offset: number): ScopeNode {
    let scope = root;
    outer: for (;;) {
      for (const child of scope.children) {
        if (offset >= child.range.from && offset <= child.range.to) {
          scope = child;
          continue outer;
        }
      }
      return scope;
    }
  }

  return {
    hintAt: (from) => hints.get(from),
    occurrenceAt: (offset) => occurrences.find((o) => offset >= o.range.from && offset <= o.range.to),
    occurrencesOf: (symbol) => occurrences.filter((o) => o.symbol === symbol),
    symbolsAt: (offset) => {
      const seen = new Map<string, SymbolKind>();
      let crossedBoundary = false;
      for (let s: ScopeNode | null = innermostScopeAt(offset); s; s = s.parent) {
        const isGlobal = s.parent === null;
        if (!crossedBoundary || isGlobal) {
          for (const [name, symbol] of s.symbols) if (!seen.has(name)) seen.set(name, symbol.kind);
        }
        if (s.functionBoundary) crossedBoundary = true;
      }
      return [...seen].map(([name, kind]) => ({ name, kind }));
    },
  };
}
