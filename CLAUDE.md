# ic10

Compiler from a small high-level language to **IC10** assembly (Stationeers'
in-game chip language). This is a modular refactor of a working 2,733-line
single-closure `compiler.ts`; the public API is unchanged, so the editor that
consumed the original can import `index.ts` instead with no other edits.

The original is kept verbatim at `tests\original.ts` — it is the reference the
differential harness compiles against, not dead code. Do not "clean it up".

## Build & test

Node is installed and the project runs through it — `npm install` once, then:

- `npm run typecheck` — `tsc --noEmit` (strict, `noUnusedLocals`,
  `noUnusedParameters`, `noFallthroughCasesInSwitch`) over every module.
  `tests\original.ts` is excluded (kept verbatim, not held to current
  strictness).
- `npm test` — runs all the vitest suites (see below).
- `npm run dev` — `vite`, serving `index.html` / `main.js`, a small page
  that runs a source string through the real parser and `compile()` for
  manual poking.
- `npm run build` — `vite build`, a sanity check that the pages and their
  imports resolve, and the thing that generates the docs page (see *The docs
  page is prerendered* below). `vite.config.js` names **both** `index.html`
  and `docs.html` as rollup inputs; with vite's default single-entry behavior
  the docs page was simply absent from `dist/`, which the dev server hides
  because it serves any root `.html` on request. A stale documented example
  now fails the build rather than the page.
- **After any change, both `npm run typecheck` and `npm test` must be
  clean.**
- Imports are explicit `.ts` (e.g. `from "./syntax.ts"`) throughout, per
  `allowImportingTsExtensions` in `tsconfig.json`. Keep new imports
  consistent with that.

### The test layers

`tests\units.ts` (122 assertions, run through `tests\units.test.ts`) covers
the leaf libraries directly — no AST, no `compile()` call. It is also the
proof that those libraries really are independent: if a unit test needs to
reach into the pipeline, the decomposition has regressed.

`tests\cases.ts` (43 programs, run through `tests\cases.test.ts`) is the
differential suite. Each case is compiled two ways — pristine original,
refactor — and asserts:

1. refactor === pristine original, **byte for byte**, *except* on cases
   flagged `expectOriginalDiff` (each such flag pins one documented fix);
2. every flagged case carries an `expected` golden pinning its full output,
   and the runner **fails if a flagged case omits it** — the oracle cannot
   ratify a deliberate divergence, so without the golden the case would
   silently decay to its substring list;
3. every substring in the case's `expect` list appears in the output.

`tests\test.mjs` (run standalone with `node tests/test.mjs`, and through
vitest via `tests\language-cases.test.mjs`) is a third, newer layer: source
*strings* run through the real parser (`getAST` in `ast.ts` → `lezer/`) and
straight through `compile()`, asserting the exact output or error message.
Prefer adding cases here when the point is end-to-end behavior of real
source text; use `tests\cases.ts` when you need to pin an exact hand-built
AST shape (e.g. reproducing one of the seven documented bugs below).

`tests\formal-ast.test.ts` (43 cases) is a fourth, independent layer: source
strings through `getAST` → `getFormalAST`, asserting the typed tree's shape.
It touches no part of the compile pipeline.

`tests\docs.test.mjs` is a fifth layer, over the *documentation*: every
`` ```icc `` fence in `docs.markdoc.md` tagged `compile` or `error` is a claim
about the compiler, and this runs each one through `runDocExample` in
`docs-examples.js` — the same function `docs-render.js` renders the page with,
which is the point. Two callers and one assertion, so the suite cannot pass
while the page fails to render.

It is a **consistency** suite, not a behavioral one, and deliberately pins no
output: a compiled fence renders whatever the compiler emits, so pinning the
IC10 here would re-litigate what the other four suites own and turn every
optimization into a docs failure. What it catches is a documented program
that stops compiling, or a documented error message that stops being an
error. Four meta-tests guard the extractor itself — floors on the number of
examples and of named modules found (so a renamed file or a changed fence
syntax cannot make the suite pass vacuously), a check that no fence claims
both `compile` and `error`, and a check that no two fences share a `name`,
where the later would silently win.

A fence tagged `` {% name="…" %} `` **is a module**: `docModules` collects
every named fence up front and `runDocExample` resolves an example's `import`
against that map, so a multi-file example is documented as its files rather
than as prose about files the reader cannot see, and the whole set of them is
held to the compiler by the importing fence's own `compile=true`. Naming a
fence says nothing about whether it compiles — a module may be a plain
listing, a compiled example, or both — and the map is whole-document, so an
example may import a module documented below it.

Every fence on the page currently carries `compile` or `error`, which is what
"Nothing here is transcribed by hand" in *How to read this page* is asserting;
keep it that way. A plain listing still renders correctly (`docs-render.js`
gives it the same `.code-group` wrapper and header as any other block,
labelled with its `name` or its language), it is just not a claim about
anything.

**A new language feature should get a documented example**, and the fence
that carries it is checked by this suite for free.

`tests\docs-render.test.mjs` is a sixth layer, over the docs page's *markup*
rather than its claims — possible only because the page is prerendered, so
its structure exists without a browser. It pins nothing about the compiler's
output (that would be the fifth suite's mistake to make); it exists for the
two invariants that broke while the prerender was being written. Heading ids:
`Markdoc.transform` resolves the tree first and `Node.resolve` returns
*copies* of every node, so ids computed against the parsed nodes landed
nowhere and the TOC linked to 43 anchors no heading carried — silently, since
a dead anchor renders fine. And the ids agreeing with the TOC, which is why
both are produced by one pass over the document.

There used to be a `tests\original-patched.ts` — the original carrying only
the documented fixes — so that flagged cases still had a byte-for-byte
oracle. It was removed: keeping a 2,800-line legacy compiler in step with
every new fix and optimization cost more than it caught (fix 8 alone needed
porting into it twice). Flagged cases now carry `expected` goldens captured
from it before deletion. **When you deliberately change behavior, flag the
case `expectOriginalDiff`, add its `expected` golden, and document the fix
below** — nothing else needs touching, and the runner enforces the golden.

## The docs page is prerendered

`docs.markdoc.md` is rendered to markup by Node and injected into `docs.html`,
rather than by a script that builds the page in the browser. **There is one
code path for this, not two**: `transformIndexHtml` is a hook vite runs per
request in the dev server and once over the bundle in `vite build`, so the
`prerenderDocs` plugin in `vite.config.js` generates the dev page on every
reload and the built page exactly once, from the same call. Nothing is
conditional on the mode.

- **`docs-render.js` is the generator** — source text in, markup out. No DOM,
  and no vite-only imports: the markdown arrives as an *argument* rather than
  through `?raw`, which is the whole reason it runs outside a browser. It
  returns the two strings the page is assembled from, one for `#docs-content`
  and one for `#docs-toc`, and `docs.html` marks both spots with a comment the
  plugin replaces. The plugin **throws if a marker is missing**, because the
  alternative is serving a blank page.
- **Nothing in the browser bundle may import `docs-render.js`.** Markdoc, the
  compiler and the Lezer grammars are reachable only from it, so one import
  from `docs.js` would pull all of it back into the page it was moved out of —
  that page's script is ~1.6 kB now. `docs.js` is behavior only: the theme
  dropdown, smooth scrolling, the scroll spy, the copy buttons.
- **It is loaded through vite, not by Node directly.** In dev that is the dev
  server's `ssrLoadModule`, so an edit to the compiler invalidates the module
  and the next request re-renders with it; `vite build` has no server and uses
  `runnerImport`, which loads a module through vite's pipeline and tears its
  environment down again (a middleware-mode server also works but leaks the
  process — the build never exits). Node could *almost* load these files
  itself, since imports are explicit `.ts`, but that would rest on Node's
  type stripping and break the day the compiler uses a construct it refuses.
- **The dev reload is driven by the ssr module graph.** Re-rendering happens on
  request, so a full reload is all the browser needs — but the generator's
  inputs are deliberately not in the *page's* module graph, so the client
  environment sees no change and says nothing. The `hotUpdate` hook therefore
  watches the **`ssr`** environment, which is exactly what `load` populated:
  any module it reports affected means the next render differs, and that covers
  `docs-render.js`, `docs-examples.js`, `highlight.js`, `theme.js`, the
  compiler and the Lezer parsers without naming one of them. Naming them was
  the bug — the watcher used to list `compiler/**` alone, so an edit to the
  generator itself re-rendered on the next request that nothing ever asked for.
  `docs.markdoc.md` stays an explicit check, being read with `readFileSync`
  rather than imported.
- **Prerendering moves the fences' claims into the build.** A `compile` fence
  that stops compiling now fails `npm run build`, not a page load.

### Themes are still one page

The rendered markup carries **class names, not colors** — `highlightSegments`
emits `tok-keyword` and friends, and every color lives in a `--theme-*` custom
property. So the HTML is theme-independent and a page per theme would be N
byte-identical copies. It also has to stay that way because `THEME_KEY` in
localStorage is shared with the editor: a theme chosen on the docs page follows
you to `index.html`, which a per-theme URL would break.

What prerendering *did* need is the colors reaching the page before it paints,
since the content now exists before any module runs:

- `theme.js` exports its `themes` map, and the plugin generates it into a
  `<style>` block — `:root` for the default plus one `:root[data-theme="…"]`
  rule per theme. Generated rather than written into `docs.css` so the colors
  keep one source, and because the `:root` block is what colors the page for a
  reader with **JS off**, who never reaches `applyTheme` at all.
- A one-line **inline blocking** script sets `data-theme` from localStorage
  before first paint. Inline and blocking is the requirement: a module script
  is deferred, so the page would paint in the default theme and snap to the
  reader's. It sets an attribute rather than the fourteen properties
  `applyTheme` writes, so the colors stay in the stylesheet; an unknown stored
  name matches no rule and falls through to `:root`, so there is nothing to
  validate. `applyTheme` still wins afterwards — an inline style beats a
  stylesheet rule — so theme switching is unchanged.
- Heading ids are part of the markup now, so an anchor resolves with no JS.
  Same reasoning put the copy button's icon url in `docs.css` instead of a
  custom property `docs.js` sets: a prerendered button that waits for a module
  would be blank in the first paint.

## Behavioral fixes vs the original (deliberate — everything else is identical)

Fixes 1–7 and 10 are bugs; 8 and 9 are added optimizations. The numbering is
the project's stable reference for them (it originally matched `// PATCH n:`
markers in the since-deleted patched original).

1. **`%` folded as division.** `foldExpression` had no `%` arm, so
   `define m = 7 % 3` emitted `2.333…`. All folding now routes through
   `applyArithmetic` in `tables.ts`.
2. **If-regions inside jal-lowered functions** — `processIf` scanned the main
   `instructions` array for its branch ids instead of the active emit buffer,
   so ifs inside multi-call-site function bodies were invisible to branch
   simplification (missed optimization, not a miscompile).
3. **Repeat-until back jump** — same buffer mix-up locating the back jump.
4. **Label resolution (`removeLabels`)** replaced *any* token matching a label
   name anywhere on any line; now only the final token of a `j`/`jal`/`b*`
   line is substituted. Silent miscompile, not cosmetic: with a function
   `scale` (label `scale:` on line 1) and a placeholder also named `scale`,
   the read `move r0 scale` became `move r0 1`. Case
   `remove-labels-name-collision`.
5. **While-condition folded with stale constants.** `let i = 0;
   while i < 10 do i += 1` compiled to an **infinite loop with no exit
   branch** — the condition was folded with `i`'s loop-entry constant even
   though the body reassigns it. The steady-state condition is now folded
   only *after* demoted variables forget their entry constants. Case
   `while-counter`.
6. **Spilling a value that one instruction both reads and writes.**
   `i += 1` lowers to `add home home 1`. The spill rewrite was an
   `if (defines) … else if (uses) …` chain, so the destination was
   redirected to scratch and stored while the *use* was never reloaded. The
   victim then had uses and no definition, and the next spill round backed
   it with a **second, never-written stack slot** — the counter read garbage
   every iteration. Case `spill-accumulator-read-write`.
7. **`break`/`continue` inside a jal-lowered function body.** The loop stack
   was global, so the body saw whatever loop enclosed the *call site that
   happened to trigger lowering* and emitted a branch across the function
   boundary into that caller's loop (with `ra` still pending) — nonsense for
   every other call site. A jal body now has no enclosing loop and such a
   break errors. Inlined bodies still see the caller's loop on purpose:
   textual inlining is macro-style and the code physically sits inside it.
   Case `error-break-inside-function`.
8. **Chained constant add/sub folded into one instruction.** The original
   had no such pass, so every link of a chain cost an instruction: `x += 2;
   x -= 3` emitted `add r0 r0 2` then `sub r0 r0 3` rather than a single
   `sub r0 r0 1`. `foldConstantOffsets` in `optimize.ts` merges them.
   Each link is read as an **affine value**, `sign * carrier + offset`, so
   all four spellings compose — including the const-first `sub dest K x`,
   which reflects the carrier rather than shifting it. That is the form
   unary minus and list address arithmetic lower to, so `-(p + 2)` becomes
   `sub r0 -2 r0` and `arr[n + 1]` folds its offset into the address.
   This is the one deliberate difference that is an *optimization* rather
   than a bug fix, so the pristine original is not wrong here, only longer
   — the cases still flag `expectOriginalDiff`. Cases
   `fold-offsets-accumulator`, `fold-offsets-through-temporaries`,
   `fold-offsets-into-a-reflection`, `fold-offsets-cancelling-to-a-copy`,
   `unary-operators`.
9. **Small function bodies are inlined at every call site.** The original
   inlined only a function with exactly one call site; anything else became
   a jal, even a one-instruction body whose call sequence (argument moves,
   `jal`, result copy, `ret`) cost more than the body itself. `bodyIsTiny`
   in `lowering.ts` measures the *lowered* body — the only honest measure —
   so the first call site lowers the function, which the jal path was going
   to do anyway, and a body under `INLINE_THRESHOLD` (3) throws that buffer
   away again so every site inlines instead. The verdict is cached on the
   `FnInfo`, because the call sites must all agree: a body that is gone
   cannot be jumped to.

   What is counted is **what the inlined copy would emit**, not what the
   lowered body contains, so `isCallOverhead` in `functions.ts` discounts
   the entry/end labels, the `ret`, the moves into the shared return vreg,
   and the `ra` save a non-leaf body needs and an inlined one does not; and
   `bodyIsTiny` further discounts a trailing return's `j endfoo` on exactly
   the condition `inlineCall` uses to emit neither that jump nor its label.
   Both discounts are load-bearing: `return inner(y) * 2` lowers to add,
   mul, a return move and that jump, so charging the copy for the two
   instructions it never emits kept a two-instruction function behind a jal.
   Since a miscount can only cost an instruction, reading the `ra` save back
   out of the emitted push/pop is a fair trade against recording it.

   A body that emits an `alias`, `define` or list reservation is never tiny
   however short it is — those name something once, and inlining the body
   twice would declare the same name twice. The rule is the
   `inlineThreshold` config knob, and **0 restores the original's
   behavior**, which is what the cases that are about the jal path itself
   pass (`function-jal-two-sites`, `non-leaf-function-push-pop-ra`,
   `remove-labels-name-collision`, `function-writes-global`, and four
   function cases in `tests\test.mjs`). Like fix 8 this is an optimization
   rather than a bug fix. Cases `function-inline-small-body`,
   `function-inline-writes-global`.

   The measure is still taken **before** optimization, so a body that only
   becomes small after DCE and branch simplification stays a call — about
   half the surviving bodies in the suites are under the threshold in the
   final output. Closing that needs inlining to run as an optimizer pass
   over the IR, which is a different and more expensive thing: the copy
   needs fresh instruction ids (the id-keyed `remove` sets in
   `simplifyBranches`/`pruneEmptyLoops` would otherwise hit both copies),
   renamed labels with rewritten targets, renumbered vregs (all call sites
   share one `paramVregs`/`retVreg` set), cloned region metadata, and a
   re-decision of the `ra` save — and, because every fold in this compiler
   happens during lowering, a copied body gets no constant propagation, so
   it would emit worse code than this path does for any function both can
   handle.

10. **An inlined argument was re-evaluated at every read.** A read-only
    parameter is bound as a lazy `alias` carrying the argument *node* and the
    caller's chain, and `compileVariableRead` re-compiled that node on each
    read. Reading the parameter twice therefore ran the argument twice:
    `clamp(d0.Temperature)` with `v` in both the condition and the
    fall-through `return v` emitted **two `l` instructions** and compared one
    sample while returning another, so a temperature crossing the bound
    between them made `clamp` return a value above its own limit. The
    per-statement placeholder cache hid this whenever both reads sat in one
    statement — which is why `return i * i` looked right and
    `let y = bar(i)` / `return i + y` did not — and the jal path never had
    it, since a real call evaluates its arguments once into `paramVregs`.
    `inlineCall` now evaluates a parameter up front, in the caller's frame,
    when the body reads it more than once (`countNameReads`), joining the
    parameters the body *reassigns*, which were already eager for a related
    reason. Evaluating in the caller's frame is also what makes the value
    safe to share: it precedes the body's control flow, so it dominates
    every read, where a value first computed inside an `if` arm would not.
    A parameter read at most once keeps the lazy alias, so an unused
    parameter still emits nothing, a constant argument still folds into its
    use instead of occupying a register, and a read inside one arm is not
    hoisted above the branch. Cases `function-inline-single-site`, and
    `an argument is sampled once…` with its two counterparts in
    `tests\test.mjs`.

    Still divergent from a strict call by value: a parameter read once
    *inside a loop* re-reads its argument each iteration, because the single
    read site sits in the loop body. Fixing that means hoisting the
    evaluation above the loop, which changes how often a device is sampled
    for every existing program, so it is left alone deliberately.

## Architecture: frames

Phase 1 (lowering) is built from **frames**. `FrameContext` is an immutable
value describing where code is being lowered: the buffer to append to, the
visible `ScopeChain`, the current statement cache, where `return` and
`break` go, and which functions are mid-lowering. Entering a function body,
a block, a loop, or an inlined parameter's caller scope constructs a **new
frame**; leaving is simply returning from the call.

**There is no save/restore anywhere in the pass.** The caller's frame is
never modified, so there is nothing to put back — the JavaScript call stack
is the only stack. The two places that still look like save/restore are the
algorithm, not context management: demotion (`entryValue`/`finalizeDemoted`)
and `globalViews` snapshot *variable knowledge* — what value a variable
holds along a control-flow path — which is the phi-avoidance analysis
modeling the program being compiled.

**Leaf libraries** — no knowledge of the pipeline; unit-tested directly:

- `ast.ts` — the real parser: `getAST(text)` runs the generated Lezer
  parser (`lezer/parser.ts`, built from `lezer/lang.grammar` — regenerate
  with `npm run generate-parser` if the grammar changes) and walks its
  `TreeCursor` into a plain `SyntaxNode` tree. `SyntaxNode` and
  `CompileError` are defined here (not in `syntax.ts`) since they're the
  parser's output shape; `syntax.ts` imports and re-exports both so every
  other module still gets them from `"./syntax.ts"` unchanged.
- `formal-ast.ts` — `getFormalAST(root)` folds the concrete tree into a
  strictly typed discriminated union: punctuation and keywords dropped,
  blocks materialized, `Parens` unwrapped, and the grammar's single
  `BinaryOp` production split by meaning into `BinaryOp` / `ComparisonOp` /
  `LogicalOp` so consumers get exhaustiveness from `tsc`. Numeric literals
  are decoded here too (`decodeNumber`): `0x`/`0b` bases with `_`
  separators, and the `c` suffix that converts a Celsius reading to the
  kelvin the chip works in. A based literal is read as a 64-bit two's
  complement word, so sixty-four 1 bits is -1 — the reading the game
  documents, and the width the bitwise instructions use. A minus *directly*
  on a literal token is folded into the literal rather than left as a
  `neg` node, because `-40c` is the temperature -40°C (233.15 K) and not
  the negation of what 40°C is in kelvin; `-(40c)` still negates, since the
  parentheses asked. The kelvin sum is rounded to the decimals the reading
  and the 273.15 offset actually carry — `-40 + 273.15` is
  `233.14999999999998` in raw doubles. **This is the
  only module that interprets the raw parse tree**; `compile()` converts
  once and everything downstream sees the typed tree. `childrenOf` is its
  `kids`: the generic descent for whole-subtree analyses (a function's or a
  call's *name* is deliberately not a child, so a walk hunting name
  references cannot mistake a callee for a value).
- `syntax.ts` — `ErrorReporter`, `SourceRange`, and the little raw-tree
  handling left (`kids`, `checkSyntax`, the node-type sets `formal-ast.ts`
  uses). The navigation helpers that used to live here (`blockOf`,
  `conditionOf`, `statementsIn`) moved into `formal-ast.ts` with the job of
  interpreting the concrete tree.
- `tables.ts` — opcode tables plus the single shared implementation of IC10
  arithmetic/bitwise/comparison semantics; folding, constexpr, and codegen
  all call these, so fold-time and run-time semantics cannot drift (that
  drift *was* fix 1). Everything is keyed by the opcode the formal AST
  resolved the operator to (`add`, `ge`, `sra`), never by source spelling —
  an arithmetic or bitwise opcode *is* its IC10 instruction, so only
  comparisons need a table, and "not a binary operator" is a type error
  rather than a runtime one. The bitwise half is computed in **BigInt**:
  the chip's word is 64 bits and JavaScript's own bitwise operators are 32,
  so `1 << 40` would otherwise fold to 256. Operands are truncated toward
  zero, shift counts run modulo 64, and an operand with no integer form
  (NaN, infinity) yields NaN — which `constOp` rejects, so the expression
  simply does not fold.
- `ir.ts` — operands, the `Inst` discriminated union, `IdAllocator`, pure
  accessors, `assertNever`, region metadata types.
- `folding.ts` — constant folding + Sethi–Ullman pressure over the formal
  AST. Pure functions; outside knowledge arrives as a one-method callback.
- `labels.ts` — every generated label name. Nothing else builds a label by
  string concatenation.
- `statement-scope.ts` — placeholder-read cache + vreg watermark, one
  invariant with deliberately different reset points.

**Shared services** — `symbols.ts` (**`ScopeChain`, an immutable value**:
`child()` / `functionFrame()` / `forModule()` derive new chains; capturing
"the caller's scopes" for an inlined parameter is just keeping the chain you
already have), `functions.ts` (user-function metadata + syntactic read/write
sets), `constexpr.ts` (`@constexpr` interpreter, typed signal classes,
200k-step budget), `modules.ts` (`ModuleScanner`: reading another saved
script, recomputing its addresses, and vetting a function copied out of it —
it knows nothing of the pipeline and never lowers anything).

**Pipeline** — `lowering.ts` (`Lowerer` owns the per-compile registries and
registration/assembly; `FrameLowerer` does the actual lowering, one instance
per lexical frame), `liveness.ts`, `optimize.ts`, `regalloc.ts`,
`render.ts`, `index.ts` (public API + orchestration — read this first).

## Hard constraints

- **r16 (sp) and r17 (ra) are reserved**; `VAR_REGISTER_ORDER` is r0–r15
  only, and `validateConfig` in `index.ts` enforces it for caller-supplied
  register orders.
- **Placeholders vs variables.** Any identifier not declared with `let` is a
  *placeholder*: it stands in for a device instruction (`l`/`s`/`lb`/`sb`/…)
  that cannot appear as an ALU operand, so it is read and written only
  through `move`. Variables are compile-time names and usually generate no
  code at all.
- **A `define` is a knob the player can edit in the chip; a `const` is a
  compile-time name.** `define X = 10` emits an IC10 `define X 10` line and
  every use substitutes the *name*, so the value can be retuned in-game
  without recompiling. That contract is why `FrameLowerer.fold` resolves
  names through `lookupVar` and not `lookup`: folding a define into its
  value would delete the operand the player edits. The define's Sym
  therefore carries `text` (the name), never the number — the folded value
  is written into the emitted line and dropped. Anything that would consume
  a define at compile time is an **error**, not a silent bake: `let arr[X]`
  ("List size must be constant") and `define Y = X + 1` ("define values must
  be constant"), since IC10 `define` takes a bare literal and neither result
  could stay editable. `const X = 10` is the compile-time counterpart —
  identical to `let` (which already constant-propagates) except that
  assigning to it errors, so it is what array sizes and derived constants
  want. Both `let` and `const` are `Declaration` nodes, split by the
  `constant` flag `formal-ast.ts` reads off the keyword token; `const` is a
  reserved word from here on, like every other `kw<…>` in the grammar.
- **Context changes are new frames, never field writes.** To lower code in
  a different context, build it with `withContext` and call through the new
  frame. If you find yourself writing `const saved = …; try … finally`,
  the design has regressed — that pattern caused two of the original's
  seven bugs and is deliberately impossible here.
- **`this.buffer` is always the right buffer.** A frame physically cannot
  reach another frame's buffer; fixes 2 and 3 were the original reaching
  for the wrong one.
- **Bitwise is not logical.** `&`/`|` lower to the same `and`/`or`
  instructions as `&&`/`||`, and the only difference is that the logical
  forms coerce each side to an exact 0/1 first (`2 && 4` is 1; `2 & 4` is
  0). They stay separate node types (`binaryop` vs `logicalop`) so that
  distinction cannot be lost. Likewise `~` is `bitnot`, IC10's `not`, and
  `!` is `not`, IC10's `seqz`. `>>` is `sra` and `>>>` is `srl`, the split
  JavaScript makes; precedence follows C. `BitwiseOpcode` lists exactly the
  six opcodes an operator can produce — `nor` and `sla` have no spelling
  and are reached, like any opcode, by calling them (`nor(a, b)`).
- **The ternary is a value, not control flow.** `c ? a : b` is IC10's
  `select`, which takes all three as operands, so **both arms are
  evaluated** — a ternary over two device reads emits both loads. The one
  exception is a condition that folds: `compileTernaryOp` then compiles only
  the arm it picks, and never compiles the other at all — the same thing a
  constant `if` condition already does to its arms, and for the same reason.
  Leaving the dead arm to dead code elimination instead would let an arm the
  program cannot reach still raise a compile error.
- **No algebraic identities for the bitwise opcodes.** Every one of them
  truncates its operands to integers, so even `x << 0` is not the identity
  on `x` and folding it away would change the result for a non-integer `x`.
- **Don't infer structure from generated names.** The IR records what the
  optimizer needs (`nextIsElse`); reading a label's spelling to decide
  control-flow shape silently stops working the moment naming changes.
- **Stack memory always names the device it is on.** `get` and `put` both
  carry a `device`, `SELF_DEVICE` (`db`) for anything this program declared
  and a pin for anything imported. `put db` renders as `poke`, which is the
  same write in one operand less, so a local list's output is unchanged.
  There is no such thing as an addressed access with no device — that was
  the shape that made an imported list indistinguishable from a local one.
- **A module is a saved script.** `compile()`'s third argument is a
  `FileHandler`, `path => source | undefined`, and the editor passes
  `scriptSource` from `save-load.js`, which reads the *saved* scripts out of
  localStorage. Saved rather than live on purpose: a module is another chip's
  program, and the addresses this compile bakes in have to be the ones that
  chip is running, not unsaved edits to it. The docs page passes a handler over
  its own named fences instead (see the docs suite above), which is what makes
  a multi-file example checkable.
- **An import of a value is a symbol, not code.** `Lowerer.registerImports`
  runs before any lowering and binds each `import` into the global scope: a
  module `const` becomes an ordinary constant `var` (so it folds and emits
  nothing), and stack memory becomes a `stackvar`/`list` Sym carrying the
  module's address and the `using` pin. Everything downstream then treats an
  imported name exactly like a local one, which is why the read, write and
  `for … of` paths needed only the device threaded through them. Nothing is
  reserved locally — the cells belong to the other chip.
- **An import of a function *is* code.** There is nothing to call across a
  device, so `registerModuleFunction` registers this program's own copy of the
  body, and of every module function that body calls. What makes a copied body
  mean the same thing here is two fields on its `FnInfo` — `moduleScope`, the
  exporting module's constants standing where this program's globals would
  (`ScopeChain.forModule`), and `selfDevice`, the pin its `db` resolves to —
  plus `checkImportedFunction` in `modules.ts` having rejected, up front,
  every name that would not survive the move. The body may mention only its
  parameters, its own variables, the module's constants and the module's stack
  memory; `db` and no other device; and calls to module functions or raw
  opcodes. Anything else — a module `let`, a `define`, a device alias, a bare
  placeholder — is an error.
  - **Stack memory crosses on the same pin `db` does**, and on the same terms:
    a cell is an address on the module's chip, so a body that reaches one is a
    body that reaches the chip, and an import that omits `using` is rejected.
    `registerModuleFunction` binds those names into `moduleScope` as the very
    `stackvar`/`list` Syms an ordinary `import … using` would produce — the
    module's address, the importer's pin — so the read, write and `for … of`
    paths need nothing new. A re-exported cell keeps the address of the chip
    that declared it, as everywhere else.
  - The checks run at **import** time, against the module's own
    `ErrorReporter`, because a diagnostic raised while lowering a copied body
    would carry the module's source offsets into this program's line
    numbering. That is exactly what still happens for anything else that goes
    wrong in a copied body (see *Known gaps*), which is why the rules that
    have a good error message are checked before lowering rather than during.
  - The body is **copied** (`copyFunction`) because registration rewrites the
    names of the module functions it calls. A callee takes its own name when
    this program is not using it — `importedNames` reserves every name an
    `import` line asks for first, so a callee never steals one — and a
    numbered one when it is. The same module function reached through two
    pins, or through two modules that re-export it, is two registrations with
    two sets of callee names, which one shared body could not carry.
  - Registration is keyed by module path, export name **and pin**, and the pin
    travels with the whole pull: a function and everything it calls are
    treated as living on the chip the `import` named.
  - `@constexpr` is deliberately not carried across: the interpreter resolves
    names through the program's own tables, which a copied body is not in.
- **The module scan recomputes addresses; it never compiles the module.**
  `ModuleScanner` in `modules.ts` walks the module's top-level statements and
  allocates through `allocateCells`, the same helper the declarations
  themselves use, because an importer computes addresses it will never see
  reserved. It folds only `const`, since a `let` lives in the module's
  registers, and it rejects a module that declares stack memory below the top
  level — such a body is lowered once per call site, so its cells are not
  where an importer could predict. One instance per compile: a module is read
  once however many names come from it, and the `scanning` set turns a cycle
  of re-exports into a diagnostic rather than a stack overflow.
- **A module offers on what it imported.** A name travels through a chain of
  modules, and a `const` that arrived that way is in the scan's `constants`,
  so the module's own `const` and list-size expressions may use it. The
  **pin does not travel**: an address, and a copied body's `db`, belong to the
  chip that first declared them, so every importer states its own `using`.
  A re-exporting module's `using` says only where *it* sees that chip.
- Recursion is rejected, not supported (the frame's `active` set).
- There is a real parser (`ast.ts` + `lezer/lang.grammar`), but the
  hand-built-AST differential suite still builds trees directly via
  `tests\ast.ts` — that's what lets a case pin one exact node shape (e.g.
  a documented bug fix) independent of what the grammar currently accepts.
  Those builders must stay **grammar-faithful** (every `Dot`, `ParenLeft`,
  `Comma`, `end` the grammar emits), because `compile()` now runs them
  through `getFormalAST`, which reads positional shapes the old loose
  `find`-based navigation tolerated omissions in.
  When adding a language feature, update `lezer\lang.grammar`, regenerate
  the parser, and add both a `tests\ast.ts` builder (for `tests\cases.ts`)
  and a source-string case in `tests\test.mjs`.

## Known gaps (deliberate, not oversights)

- `bodyFrom`/`bodyTo` on if/loop regions are global instruction-id ranges,
  but a jal-lowered function body draws ids from the same counter while
  emitting into its own buffer, so a function's ids can fall inside the
  range of the arm that first called it. Every consequence is conservative
  (a region that could be simplified is left alone).
- Instruction ids are not monotonic in the final array: the `push ra`
  splice and the `j ProgramStart` pair are created after the instructions
  they precede. Nothing sorts by id except the header collection, which
  wants exactly that order.
- `noUncheckedIndexedAccess` is off. Opcode-table lookups are typed as
  `string` when they could be `undefined`; the grammar makes a miss
  unreachable, but turning it on is the largest remaining typing win.
- The differential oracle is a legacy implementation, so behavior both
  versions share is ratified rather than checked. Nothing executes the
  emitted IC10 or validates it against chip limits.
- `lezer\ic10.grammar` (a grammar for IC10 *assembly* itself, not the
  high-level language) exists but nothing generates or consumes it yet.
  Only `lang.grammar` is wired into `ast.ts`.
- A numeric literal is carried through the formal AST as a `number`, not as
  its source spelling, so a literal with no plain IC10 form (`1e21` and up)
  is now emitted in JavaScript's exponent spelling instead of the digits the
  source wrote. Both are equally unusable on a chip; nothing rounds or
  reinterprets a literal the chip could actually hold. The same choice means
  `0xFF` is emitted as `255` rather than in the `$FF` form the chip also
  accepts, and that a based literal past 2^53 (`0x7FFFFFFFFFFFFFFF`) prints
  as the shortest decimal that round-trips to the same double — the chip
  parses its own literals into doubles too, so the value is unchanged, only
  the spelling.
- `foldConstantOffsets` is deliberately narrow. It only merges *integer*
  literals, because combining them re-associates the chip's arithmetic and
  `(x + 0.1) + 0.2` is genuinely not `x + 0.30000000000000004` in doubles.
  It only merges links whose non-literal operand is a single carrier, so
  `x + y` ends a chain. And it never scans across a label, jump, branch,
  jal, or ret, so a chain split by control flow keeps both links. Every
  limit costs an instruction and none can miscompile.
- `checkSyntax` runs twice on the raw tree: `compile()` calls the reporting
  one (so "Syntax error" carries a line number), then `getFormalAST` re-checks
  because it has no reporter. Cheap, and it keeps `getFormalAST` usable on
  its own.
- Nothing tells an importing program that its module changed. The addresses
  it baked in are only right while the module's `stack`, list and `const`
  declarations stay as they were, so inserting a `stack` line at the top of a
  module silently moves every address below it and both programs have to be
  recompiled. An imported *function* is worse in the same way: the copy is
  taken at compile time, so editing the module leaves the copy behind.
  Recording a module fingerprint would need somewhere to keep it, which is
  the editor's problem rather than the compiler's.
- An imported module is scanned for its interface but never checked. A module
  that does not compile is only rejected for the parts the scan walks (a
  syntax error, a non-constant list size, stack memory below the top level,
  and — for a function actually imported — `checkImportedFunction`); anything
  else wrong with it surfaces when that module is compiled on its own. A
  nested import naming something its module does not offer is not an error
  either: the name is simply not offered on.
- **A diagnostic raised while lowering an imported function's body carries the
  module's line numbers**, since the node's offsets index the module's source
  and the reporter is the importing program's. Everything with a good message
  is therefore checked at import time instead (see *An import of a function is
  code*); what is left is the ordinary compile errors — recursion, a nested
  `fn`, an unassigned variable — where the wrong line is misleading but the
  message still names the problem. Fixing it means threading a reporter
  through `FrameContext`.
- `checkImportedFunction` allows an undeclared identifier in a **raw opcode's**
  argument position, because that is where logic types and other bare symbols
  legitimately appear (`lb(hash, Setting, Average)`). A placeholder read there
  is therefore not caught, and would name something in the importing program.
  Every other position rejects it.
- A read of a stack variable is not cached within a statement the way a
  placeholder read is, so `idle + idle` emits two `get`s. The placeholder
  cache is keyed by name with no invalidation on write, and a stack cell can
  be written by the other chip between two reads, so sharing that cache
  would be reusing a value the program never promised was stable.
- `pressure` scores an imported or `stack` name as free (`isKnownName` is
  true for it) even though reading it occupies a register. It only picks
  evaluation order, so the cost is at most a register shuffle.
- `docs.html` is not a standalone file any more: opened straight off disk it is
  an empty shell, because the content is injected by the vite plugin. Either
  serve it (`npm run dev`) or build it. The plugin failing loudly on a missing
  marker is the guard against shipping that shell.
- `runnerImport` is marked `@experimental` in vite's own types. If it goes
  away, the fallback is a middleware-mode server closed in `closeBundle` —
  which was the first attempt, and hung the build until it was closed.
