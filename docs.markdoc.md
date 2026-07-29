---
title: Stationeers-ICC Documentation!
---

# ICC

ICC compiles to **IC10**, the assembly language Stationeers' in-game chips
run. The source and compiled output below are colored by the same Lezer
grammars that drive the live [editor](index.html) — `lang.grammar` for ICC,
`ic10.grammar` for IC10.

## Legend

- {% tok kind="keyword" %}keyword{% /tok %} — `if`, `while`, `fn`, `return`, …
- {% tok kind="declaration" %}declaration{% /tok %} — `let`, `const`, `define`, `device`
- {% tok kind="variable" %}variable{% /tok %} — a variable name
- {% tok kind="function" %}function{% /tok %} — a function or instruction name
- {% tok kind="number" %}number{% /tok %} — a numeric literal
- {% tok kind="string" %}string{% /tok %} — a string literal
- {% tok kind="comment" %}comment{% /tok %} — a `#` comment
- {% tok kind="operator" %}operator{% /tok %} — `+`, `-`, `==`, …
- {% tok kind="special" %}special{% /tok %} — a device (`d0`) or register (`r0`)

## Example

ICC source:

```icc
let x = a + b
let y = x * 2
c = y - x
```

compiles to:

```ic10
move r0 a
move r1 b
add r0 r0 r1
mul r1 r0 2
sub r0 r1 r0
move c r0
```
