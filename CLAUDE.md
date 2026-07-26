# ic10

Compiler from a small high-level language to **IC10** assembly (Stationeers'
in-game chip language). This is a modular refactor of a working 2,733-line
single-closure `compiler.ts`; the public API is unchanged, so the editor that
consumed the original can import `index.ts` instead with no other edits.

The original is kept verbatim at `tests\original.ts` — it is the reference the
differential harness compiles against, not dead code. Do not "clean it up".

## Build & test

There is **no Node/npm on this PC**, so verification runs in the browser:

- Serve the folder and open the runner: preview `ic10-tests` (port 8892,
  `.claude\launch.json`) → `http://localhost:8892/tests/runner.html`.
- The runner fetches the real TypeScript compiler from CDN and does four
  things: **strict type-check** of every module against an in-memory
  filesystem (`strict`, `noUnusedLocals`, `noUnusedParameters`,
  `noFallthroughCasesInSwitch`), transpile+link with a small CommonJS shim,
  run the **unit tests**, then run the **differential suite**.
- **After any change the runner must report
  `96/96 unit tests, 37/37 cases passed, 0 type errors`.**
  `window.__RESULTS__.ok` is the single boolean for scripted checks.
- **Adding a module?** Add it to `REFACTOR_FILES` in `tests\runner.html`.
  A static file server cannot enumerate the directory, so that list is
  manual; a missing entry fails loudly with `module not found`.
- Both the page and its `fetch`es are `no-store`. Without that the browser
  re-runs a cached copy and you verify code you are no longer editing —
  this cost real debugging time once already.

### The two test layers

`tests\units.ts` (96 assertions) covers the leaf libraries directly — no
AST, no `compile()` call. It is also the proof that those libraries really
are independent: if a unit test needs to reach into the pipeline, the
decomposition has regressed.

`tests\cases.ts` (37 programs) is the differential suite. Each hand-built
AST is compiled three ways — pristine original, patched original, refactor —
and the runner asserts:

1. refactor output === patched-original output, **byte for byte**, always;
2. refactor === pristine original too, *except* on cases flagged
   `expectOriginalDiff` (each such flag pins one documented bug fix);
3. every substring in the case's `expect` list appears in the output.

`tests\original-patched.ts` is the original with **only** the seven fixes
below, each marked `// PATCH n:`. It exists so the harness can prove the
refactor changed nothing else. If you fix another original bug, patch it
there too and add a case — otherwise the suite cannot tell your fix from a
regression.

## Behavioral fixes vs the original (deliberate — everything else is identical)

Numbering matches the `// PATCH n:` markers in `tests\original-patched.ts`.

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

- `syntax.ts` — `SyntaxNode`, `CompileError`, `ErrorReporter`, and **all**
  AST navigation (`kids`, `blockOf`, `conditionOf`, `statementsIn`). Bodies
  are delimited by keyword tokens, not node type, because a function call is
  both a statement and an expression.
- `tables.ts` — opcode tables plus the single shared implementation of IC10
  arithmetic/comparison semantics; folding, constexpr, and codegen all call
  these, so fold-time and run-time semantics cannot drift (that drift *was*
  fix 1).
- `ir.ts` — operands, the `Inst` discriminated union, `IdAllocator`, pure
  accessors, `assertNever`, region metadata types.
- `folding.ts` — constant folding + Sethi–Ullman pressure. Pure functions;
  outside knowledge arrives as a one-method callback.
- `labels.ts` — every generated label name. Nothing else builds a label by
  string concatenation.
- `statement-scope.ts` — placeholder-read cache + vreg watermark, one
  invariant with deliberately different reset points.

**Shared services** — `symbols.ts` (**`ScopeChain`, an immutable value**:
`child()` / `functionFrame()` derive new chains; capturing "the caller's
scopes" for an inlined parameter is just keeping the chain you already
have), `functions.ts` (user-function metadata + syntactic read/write sets),
`constexpr.ts` (`@constexpr` interpreter, typed signal classes, 200k-step
budget).

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
- **Context changes are new frames, never field writes.** To lower code in
  a different context, build it with `withContext` and call through the new
  frame. If you find yourself writing `const saved = …; try … finally`,
  the design has regressed — that pattern caused two of the original's
  seven bugs and is deliberately impossible here.
- **`this.buffer` is always the right buffer.** A frame physically cannot
  reach another frame's buffer; fixes 2 and 3 were the original reaching
  for the wrong one.
- **Don't infer structure from generated names.** The IR records what the
  optimizer needs (`nextIsElse`); reading a label's spelling to decide
  control-flow shape silently stops working the moment naming changes.
- Recursion is rejected, not supported (the frame's `active` set).
- Tests build ASTs by hand via `tests\ast.ts`; there is no parser in this
  repo. When adding a language feature, add the builder there too.

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
