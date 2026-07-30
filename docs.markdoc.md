---
title: Stationeers-ICC Documentation!
---

# Stationeers-ICC

ICC is a custom programming language that compiles to [IC10](https://stationeers-wiki.com/IC10), the in-game scripting language for [Stationeers](https://store.steampowered.com/app/544550/Stationeers/).

IC10 is an assembly language: no expressions, no scopes, eighteen registers, and a hard limit on how much you can fit on one chip. ICC gives you variables, real expressions, `if`/`while`/`for`, functions and lists, then compiles them down to IC10 that is usually shorter than what you would have written by hand — constants fold, dead code disappears, comparisons fuse into branches, and small functions inline.

## How to read this page

Every example below is compiled by the real compiler when this page loads. Click the **IC10** header under any example to expand the assembly it produces; blocks labelled **Error** are programs that are *rejected*, shown with the exact message you get. Nothing here is transcribed by hand, so nothing here can drift from the compiler.

```icc {% compile=true %}
device sensor = d0
device vent = d1

if sensor.Temperature > 20c then
  vent.On = 1
end
```

## Legend

{% table %}
* Token
* Description
---
* {% tok kind="keyword" %}Keyword{% /tok %}
* `if`, `while`, `fn`, `return`, …
---
* {% tok kind="declaration" %}Declaration{% /tok %}
* `let`, `const`, `define`, `device`
---
* {% tok kind="variable" %}Variable{% /tok %}
* A variable name
---
* {% tok kind="function" %}Function{% /tok %}
* A function or instruction name
---
* {% tok kind="number" %}Number{% /tok %}
* A numeric literal
---
* {% tok kind="string" %}String{% /tok %}
* A string literal
---
* {% tok kind="comment" %}Comment{% /tok %}
* A `#` comment
---
* {% tok kind="operator" %}Operator{% /tok %}
* `+`, `-`, `==`, …
---
* {% tok kind="special" %}Special{% /tok %}
* A device (`d0`) or register (`r0`)
{% /table %}

## A first program

A thermostat: read a temperature off one device, switch another on or off, and do it again forever.

```icc {% compile=true %}
device sensor = d0
device vent = d1
define TargetTemp = 20c

loop
  if sensor.Temperature > TargetTemp then
    vent.On = 1
  else
    vent.On = 0
  end
  yield
end
```

Four things in that program are worth naming up front, because they cover most of what makes ICC different from the assembly it produces:

- `device sensor = d0` gives the pin a name. It costs one `alias` line and nothing at runtime.
- `define TargetTemp = 20c` emits an IC10 `define`, so the number stays **editable on the chip in-game**. The `c` suffix converts 20 °C to the kelvin the chip actually compares against.
- The `if` never materializes a true/false value. `>` fused straight into a `ble` branch.
- `yield` hands the tick back to the game. A `loop` without one runs until the chip trips its instruction limit.

## Program structure

A program is a list of statements, which don't need to be on separate lines. There are no semicolons and no braces — blocks are opened by a keyword and closed by `end`. Indentation is for you, not the compiler.

Comments start with `#` and run to the end of the line.

```icc {% compile=true %}
# A comment runs to the end of the line
device pump = d0   # trailing comments work too
pump.On = 1
```

## Names

ICC has four ways to introduce a name, and they compile to very different things. Picking the right one is most of the skill in writing good ICC.

| | Exists at | Costs | Editable in-game |
| --- | --- | --- | --- |
| `let x = 1` | compile time, until it needs a register | usually nothing | no |
| `const X = 1` | compile time only | nothing | no |
| `define X = 1` | runtime, as an IC10 `define` | one line | **yes** |
| `device p = d0` | runtime, as an IC10 `alias` | one line | **yes** (change device pin) |

### `let` — variables

A variable is a compile-time name for a value. It is not a register, and most of the time it never becomes one: the compiler tracks what a variable holds and substitutes it.

```icc {% compile=true %}
let x = 10
let y = x * 2
d0.Setting = y
```

Both statements vanished — `y` was known to be 20, so the whole program is one store. A variable only takes a register when its value genuinely isn't known until runtime.

A variable can be declared without a value and assigned later, but reading it before it has one is an error.

```icc {% error=true %}
let x
d0.Setting = x
```

The same check runs across branches. If a variable is assigned on only *some* paths, reading it afterwards is rejected rather than silently reading garbage.

```icc {% error=true %}
let x
if d0.On then
  x = 1
end
d1.Setting = x
```

Names cannot be reused, in either direction — this catches a typo that would otherwise quietly shadow something.

```icc {% error=true %}
let x = 1
let x = 2
```

### `const` — compile-time constants

`const` is `let` with the assignment closed off. It behaves identically otherwise, including constant propagation.

```icc {% compile=true %}
const MAX = 100
d0.Setting = MAX / 2
```

```icc {% error=true %}
const X = 1
X = 2
```

Use `const` for anything derived at compile time — array sizes, thresholds you compute from other thresholds, magic numbers you want named. A `const` must be given a value when it is declared.

### `define` — knobs you can edit on the chip

A `define` is a declaration that survives into the emitted program *as a name*. It emits an IC10 `define` line, and every use refers to the name rather than the number, so you can retune it in-game with the chip's editor and never recompile.

```icc {% compile=true %}
define Pressure = 50
d0.Setting = Pressure
```

Compare that with `const`, which is folded away entirely:

```icc {% compile=true %}
define X = 10
const Y = 10
d0.Setting = X + 1
d1.Setting = Y + 1
```

`X + 1` had to become a real `add` against the name, because folding it would delete the operand you wanted to edit. `Y + 1` was just 11.

For the same reason, a `define` cannot be consumed at compile time. Anything that would bake the value into the program instead of leaving it editable is an error rather than a silent bake:

```icc {% error=true %}
define Size = 4
let arr[Size]
```

A `define` is also how you name a **prefab hash** — see [Device groups](#device-groups) below.

{% callout type="note" %}
Rule of thumb: `define` if a player should be able to tune it on the chip, `const` if it is an internal constant. `define` costs a line and blocks folding; `const` costs nothing.
{% /callout %}

### `device` — naming a pin

```icc {% compile=true %}
device pump = d0
pump.On = 1
```

The right-hand side must be a physical device pin: `d0` through `d5`, or `db` (the chip's own housing). An unused `device` declaration emits nothing, so there is no cost to naming pins you end up not using. It is safe to change these after the script has been compiled.

### Placeholders

Any identifier that was **never declared** is a *placeholder*. It compiles straight through to the emitted program as a bare name.

```icc {% compile=true %}
Sensor = 1
d0.Setting = Sensor
```

Placeholders exist because a value may be held somewhere that can't be an operand of an arithmetic instruction. So a placeholder is always read into a register with a `move` first, and written back with a `move` after — never used directly in an `add` or a comparison.

This also means the compiler will not catch a misspelled variable name: it becomes a placeholder instead. Watch for a stray `move` of a name you don't recognize in the output.

{% callout type="warn" %}
A variable that has gone out of scope becomes a placeholder again, silently. A `let` declared inside an `if` or a loop body does not exist after the `end`.
{% /callout %}

## Numbers and literals

| Spelling | Value | |
| --- | --- | --- |
| `42` `1.5` | 42, 1.5 | decimal |
| `0x1F` `0XfF` | 31, 255 | hexadecimal |
| `0b1011` | 11 | binary |
| `0xDEAD_BEEF` `0b0110_1000` | 3735928559, 104 | `_` separates digits, as the game's `%0110_1000` does |
| `23c` `100C` | 296.15, 373.15 | a Celsius reading, converted to kelvin |
| `true` `false` | 1, 0 | |
| `"StructureWallLight"` | `HASH("StructureWallLight")` | a string is its prefab hash |

```icc {% compile=true %}
d0.Setting = 0x1F
d1.Setting = 0b1011
d2.Setting = 0xDEAD_BEEF
d3.Setting = 23c
d4.Setting = true
d5.Setting = "StructureWallLight"
```

A based literal is read as a **64-bit two's complement word**, so `0b1111…1111` (sixty-four ones) is `-1`, not 2⁶⁴−1 — the reading the game documents, and the same width the bitwise instructions work in.

The `c` suffix is a *reading*, not a conversion applied afterwards, so a minus sign attached directly to the literal stays inside it: `-40c` is −40 °C, which is 233.15 K. Write `-(40c)` if you really meant to negate what 40 °C comes to.

Literals are carried through the compiler as numbers rather than as the text you typed, so `0x1F` is emitted as `31`. The chip reads both identically.

## Operators

| Operator | IC10 | Notes |
| --- | --- | --- |
| `+` `-` `*` `/` `%` | `add` `sub` `mul` `div` `mod` | `%` is a true modulo — the result takes the divisor's sign, so `-5 % 3` is `1` |
| `==` `!=` `<` `<=` `>` `>=` | `seq` `sne` `slt` `sle` `sgt` `sge` | fuse into a branch when used as a condition |
| `&&` `\|\|` `!` | `and` `or` `seqz` | **logical** — each side is coerced to an exact 0/1 first |
| `&` `\|` `^` `~` | `and` `or` `xor` `not` | **bitwise**, over the 64-bit word |
| `<<` `>>` `>>>` | `sll` `sra` `srl` | `>>` keeps the sign bit, `>>>` shifts zeroes into it |

```icc {% compile=true %}
let x = d0.Setting
d1.Setting = x + 1
d1.Setting = x % 3
d1.Setting = x == 5
d1.Setting = !x
d1.Setting = ~x
d1.Setting = x & 0xFF
d1.Setting = x << 2
```

### Logical is not bitwise

`&&` and `&` both emit an `and`. The difference is that the logical form squashes each side to 0 or 1 first, so `2 && 4` is 1 while `2 & 4` is 0. Likewise `!` is `seqz` (an exact 0/1) and `~` is `not` (every bit flipped).

```icc {% compile=true %}
d1.Setting = 2 && 4
d2.Setting = 2 & 4
```

### Precedence

Tightest first. Precedence follows C, which means the comparisons bind **tighter** than the bitwise operators — `a & 1 == 1` parses as `a & (1 == 1)`. Parenthesize when that isn't what you meant.

| Operator | Definition |
| --- | --- |
| `f(…)` `x[…]` `x.y` | call, index, property |
| `-` `!` `~` | unary |
| `*` `/` `%` | multiplicative |
| `+` `-` | additive |
| `<<` `>>` `>>>` | shift |
| `==` `!=` `<` `<=` `>` `>=` | comparison |
| `&` | and |
| `^` | exclusive or |
| `\|` | or |
| `&&` | logical and |
| `\|\|` | logical or |

### Compound assignment

Every binary operator has a compound form: `+=` `-=` `*=` `/=` `%=` `&=` `|=` `^=` `<<=` `>>=` `>>>=`.

```icc {% compile=true %}
let x = d0.Setting
x += 2
x *= 3
x &= 0xFF
d1.Setting = x
```

Compound assignment works on device properties too, where it becomes an explicit read-modify-write:

```icc {% compile=true %}
device pump = d0
pump.Setting += 1
```

## Control flow

### `if` / `elif` / `else`

```icc {% compile=true %}
device sensor = d0
if sensor.Pressure > 100 then
  d1.On = 1
elif sensor.Pressure > 50 then
  d1.On = 0
else
  d1.Setting = 0
end
```

`elif` may repeat; `else` is optional. Note that the comparison never produced a value — each arm's condition compiled directly into a branch.

### `loop`

An unconditional loop. Leave it with `break`.

```icc {% compile=true %}
loop
  d0.Setting = d1.Temperature
  yield
end
```

### `while`

Tests before each iteration, so the body may run zero times.

```icc {% compile=true %}
device tank = d0
while tank.Pressure < 100 do
  d1.On = 1
  yield
end
d1.On = 0
```

### `repeat` / `until`

Tests *after* each iteration, so the body always runs at least once. Note there is no `end` — `until` closes the block.

```icc {% compile=true %}
device tank = d0
repeat
  d1.On = 1
  yield
until tank.Pressure >= 100
```

### `for`

The header is three comma-separated slots — initializer, condition, update — and **every one of them is optional**, though both commas are always required.

```icc {% compile=true %}
for let i = 0, i < 6, i += 1 do
  d0.Setting = i
  yield
end
```

`for , , do … end` is therefore a bare infinite loop, exactly like `loop`.

{% callout type="note" %}
The loop variable is scoped to the loop. After the `end` it is out of scope, and a mention of it becomes a placeholder rather than an error — see [Placeholders](#placeholders).
{% /callout %}

### `break` and `continue`

`break` leaves the innermost loop; `continue` jumps to its next iteration (for a `for` loop, to the update slot).

```icc {% compile=true %}
loop
  yield
  if d0.Temperature < 300 then
    continue
  end
  if d0.Pressure > 200 then
    break
  end
  d1.On = 1
end
```

Both fuse into the surrounding structure where they can. Neither `if` above survives as an `if` — the condition branches straight to the loop's start or end.

### `yield` and `sleep`

`yield` ends the chip's turn for this tick. `sleep n` pauses for `n` seconds.

```icc {% compile=true %}
loop
  sleep 2
  d0.On = 1
end
```

{% callout type="warn" %}
An IC10 chip has a fixed instruction budget per tick, and a loop that never yields will burn through it and halt with an error. Any `loop`, `while` or `repeat` that is meant to run for the life of the chip needs a `yield` or a `sleep` in it.
{% /callout %}

## Devices

### Reading and writing properties

Use `d0` through `d5` and `db` directly, or give them names with `device`. Properties are read and written with a dot.

```icc {% compile=true %}
device pump = d0
pump.Setting = 1
let x = pump.On
d1.Setting = x
```

A read becomes `l` and a write becomes `s`. The property name is passed straight through to the game, so any logic type the device supports works.

### Slots

Index a device with a number to reach one of its slots, then take a property of that.

```icc {% compile=true %}
device sorter = d0
let count = sorter[0].Quantity
d1.Setting = count
sorter[1].Occupied = 0
```

These become `ls` and `ss`.

### Device groups

A `define` bound to a **string** names a prefab hash, and that name then stands for *every device of that type on the network* rather than for one pin. Writing to it broadcasts.

Reading is the interesting half: a group has many values, so a read has to say how to combine them. The four aggregators are `Sum`, `Average`, `Minimum` and `Maximum`.

```icc {% compile=true %}
define Light = "StructureWallLight"
let lit = Sum(Light.On)
d0.Setting = lit
Light.On = 1
```

Reading a group without one is an error rather than a guess:

```icc {% error=true %}
define Light = "StructureWallLight"
d0.Setting = Light.On
```

Index a group with a **string** to narrow it to devices with that name label, which compiles to `lbn`/`sbn`:

```icc {% compile=true %}
define Light = "StructureWallLight"
let lit = Maximum(Light["Hallway"].On)
Light["Hallway"].On = 1
d0.Setting = lit
```

{% callout type="note" %}
Indexing a *device* with a number means a slot; indexing a *group* with a string means a name filter. The compiler knows which is which from how the base was declared.
{% /callout %}

## Lists

A list is a fixed-size block of the chip's stack memory. The size must be a compile-time constant.

```icc {% compile=true %}
let arr[4] = [10, 20, 30, 40]
arr[2] = 99
d0.Setting = arr[2]
```

Elements are stored with `poke` and read with `get`, at addresses counting down from the top of the stack. The initializer is optional (`let arr[4]` just reserves the space), and a list declared inside a function is scoped to that function.

Indexing takes any expression, and a constant offset in the index folds into the address arithmetic rather than costing an instruction of its own.

### Iterating

`for … in` gives you each **index**; `for … of` gives you each **value**.

```icc {% compile=true %}
let arr[3] = [5, 6, 7]
for let i in arr do
  d0.Setting = i
  yield
end
```

```icc {% compile=true %}
let arr[3] = [5, 6, 7]
for let v of arr do
  d0.Setting = v
  yield
end
```

Neither form needs the length written out — it comes from the declaration.

## Stack variables

`stack` declares a single cell of stack memory instead of a whole block — the one-element case of a list, read and written by name rather than by index.

```icc {% compile=true %}
stack idle = 0
idle = idle + 1
d0.Setting = idle
```

A `let` is a compile-time name that usually costs no instructions at all, so prefer it. What `stack` buys you is an address: a cell another chip can read, which is what `import` is for.

## Imports

Chips can share values. `import` names something another program declared and lets you use it as if it were yours.

A module is just another saved script, imported by the name it is saved under. Say one chip runs this one, `sensor-hub`:

```icc {% name="sensor-hub" compile=true %}
stack idle = false
const size = 2
let arr[size] = [1, 2]
```

Its three declarations took the top three cells of that chip's stack, which is what the `poke`s above say. Another chip, with `sensor-hub`'s chip wired to its `d0` pin, can reach all three:

```icc {% compile=true %}
import idle from "sensor-hub" using d0
import arr from "sensor-hub" using d0
import size from "sensor-hub"

d1.Setting = idle
d2.Setting = arr[0]
d3.Setting = size
```

The two forms differ in what they need, and which one applies follows from what the module declared:

- **Stack memory** — a `stack` variable or a list — lives on the chip running that module, so reading it takes a device. `using d0` says which pin this chip sees that chip on. Its addresses are the module's; nothing is reserved locally, so the importing program's own lists and spills are unaffected.
- **A `const`** is a compile-time value. Importing one substitutes the value, reads no device, and emits nothing — `size` above became the literal `2`.

Imported stack memory is writable, and a write goes to the other chip:

```icc {% compile=true %}
import idle from "sensor-hub" using d0
import arr from "sensor-hub" using d0
idle = 1
arr[1] = d1.Setting
```

{% callout type="warn" %}
Addresses are worked out by reading the module's declarations, in order, so the two programs must agree about them: **recompile the importing program whenever the module's `stack`, list, or `const` declarations change.** Inserting a `stack` line at the top of a module moves everything below it.
{% /callout %}

Writing `using` on the wrong kind of import is an error rather than something the compiler quietly ignores, since the two forms compile to entirely different things:

```icc {% error=true %}
import size from "sensor-hub" using d0
```

Some things deliberately cannot cross a module boundary:

- **A `let`** is not importable. It lives in the module's registers, not at an address.
- **Stack memory declared outside the top level** makes the whole module unimportable. A list inside a function body is allocated once per lowering of that body, which depends on where the module calls it, so the address is not something an importer can predict — it is rejected rather than guessed at.
- **A module's own imports are not re-exported.** Only what a module declares itself can be imported from it.

## Functions

### Defining and calling

Functions are declared with `fn`, take positional parameters, and return a value with `return`. They must be defined at the top level of the program, but may be used before the line that defines them.

```icc {% compile=true %}
fn hypot(a, b)
  return sqrt(a * a + b * b)
end

d0.Setting = hypot(d1.Setting, d2.Setting)
d3.Setting = hypot(3, 4)
```

Functions can read and write the program's variables, not just their parameters.

### How a call is compiled

There are two lowerings, and the compiler picks per function:

- **Inlined** — the body is pasted at the call site. This happens when a function has a single call site, or when its body is *shorter than the call sequence would be*.
- **Called** — a real `jal`, with parameters passed in registers and the program's own code jumped over by a `j ProgramStart` at the top.

A one-instruction body inlines at both sites, leaving nothing to jump to:

```icc {% compile=true %}
fn double(v)
  return v * 2
end
d0.Setting = double(d0.Temperature)
d1.Setting = double(d1.Temperature)
```

A bigger body stays a real function, and is emitted once no matter how many times it is called:

```icc {% compile=true %}
fn clamp(v, lo, hi)
  if v < lo then return lo end
  if v > hi then return hi end
  return v
end

d0.Setting = clamp(d1.Temperature, 273, 373)
d2.Setting = clamp(d3.Temperature, 273, 373)
```

You never have to choose between them, and the choice does not change what the program means.

### Recursion is not supported

A recursive call needs a stack frame per call, which would collide with the fixed addresses lists and spilled values use. It is rejected rather than miscompiled.

```icc {% error=true %}
fn fact(n)
  if n < 2 then return 1 end
  return n * fact(n - 1)
end
d0.Setting = fact(5)
```

### `@constexpr`

Mark a function `@constexpr` and, whenever every argument is a compile-time constant, the compiler *runs* it and emits the answer. Recursion is fine here — it never reaches the chip.

```icc {% compile=true %}
@constexpr
fn fib(n)
  if n < 2 then
    return n
  else
    return fib(n - 1) + fib(n - 2)
  end
end

d0.Setting = fib(10)
```

The whole call became `55`. If an argument turns out not to be constant, or the body touches something that only exists at runtime (a device, a placeholder, `yield`), the call quietly falls back to being compiled normally. There is a step budget, so a runaway loop fails fast instead of hanging the compiler.

## Calling IC10 instructions directly

Any name that isn't a variable, a device, or one of your functions is treated as an IC10 opcode. Arguments pass through as written; if the result is assigned, the destination becomes the instruction's first operand.

```icc {% compile=true %}
let x = d0.Setting
d1.Setting = max(x, 10)
d2.Setting = round(x)
d3.Setting = log(x)
```

This is the escape hatch for everything the language has no syntax for — including the two bitwise opcodes with no operator spelling, `nor` and `sla`:

```icc {% compile=true %}
let x = d0.Setting
d1.Setting = nor(x, 3)
```

Instructions with side effects are written as bare statements:

```icc {% compile=true %}
device sorter = d0
let hash = d1.Setting
put(sorter, 0, hash << 8 | 1)
```

`loadSlot` and `setSlot` are friendlier spellings of `ls` and `ss`:

```icc {% compile=true %}
let y = loadSlot(d0, 0, Quantity)
setSlot(d1, 0, Occupied, y)
```

## What the compiler does for you

Worth knowing about, because it explains output that looks nothing like the input.

**Constants propagate.** A variable whose value is known is not a register.

```icc {% compile=true %}
let x = 5
x = x + 1
d0.Setting = x
```

**Dead code is removed.** Anything that cannot affect a device, a placeholder, or the chip's state is deleted — including unused `device` and `define` declarations. A program with no observable effect compiles to nothing at all.

```icc {% compile=true %}
let unused = d0.Setting + 1
```

**Comparisons fuse into branches.** A condition never becomes a 0/1 that is then tested; it becomes the branch.

**Constant offsets merge.** A chain of constant adds and subtracts on the same value collapses into one instruction, in any mix of spellings.

**Registers are allocated and reused,** across loop bodies and function calls. When a program needs more values live at once than there are registers, the least useful ones spill to stack addresses automatically — you never manage `r0`–`r15` yourself.

{% callout type="note" %}
`r16` (`sp`) and `r17` (`ra`) are reserved for the stack pointer and return address, so the allocator only ever uses `r0`–`r15`.
{% /callout %}

## Errors

Every diagnostic carries the line it came from (starting at 0). The common ones:

| Message | Cause |
| --- | --- |
| `Syntax error` | the parser could not read the line |
| `x was already defined` | a name declared twice |
| `x is used before being assigned` | reading a `let` with no value yet |
| `x may be undefined` | reading a variable assigned on only some paths |
| `Cannot assign to constant X` | writing to a `const` |
| `Constant X must be assigned a value` | a `const` with no initializer |
| `Reading from a device group needs an aggregator (…)` | a group read with no `Sum`/`Average`/`Minimum`/`Maximum` |
| `Unknown device or define x` | writing a property of a name that is neither |
| `x is a variable, not a device or define` | using a `let` name as a device |
| `List size must be constant` | a list sized by a `define` or a runtime value |
| `List x is not defined` | indexing something that isn't a list |
| `x is a list; read one element (x[0])` | using a list name as a value |
| `Cannot find module "p"` | an `import` whose file the editor could not read |
| `x is not declared in "p"` | importing a name the module does not declare itself |
| `x lives in "p"'s stack memory; …` | an `import` of stack memory with no `using` |
| `x is a constant in "p"; …` | an `import` of a `const` with a `using` |
| `stack memory declared outside the top level cannot be imported` | the module allocates cells inside a function or block |
| `Recursive functions are not supported: f` | direct or mutual recursion |
| `f expects N arguments` | wrong argument count |
| `Functions must be defined at the top level` | an `fn` nested inside a block |
| `break outside of a loop` | also fires for `break` in a called function's body |
| `Expression too complex: not enough registers` | more live values than registers, unspillable |
| `Too many variables: out of stack memory` | lists and spills exhausted the 512-word stack |

## Reference

### Keywords

`let` `const` `define` `device` `stack` `import` `from` `using` `fn` `return` `if` `then` `elif` `else` `end` `loop` `while` `do` `repeat` `until` `for` `in` `of` `break` `continue` `yield` `sleep` `true` `false` `d0`–`d5` `db` `@constexpr`

These are reserved and cannot be used as names.

### Statement forms

| Form | |
| --- | --- |
| `let x` / `let x = e` | variable |
| `const X = e` | compile-time constant |
| `let a[n]` / `let a[n] = [e, …]` | list |
| `stack x` / `stack x = e` | one cell of stack memory |
| `import x from "p"` | another module's `const` |
| `import x from "p" using d0` | another module's stack memory |
| `define X = e` | in-chip define |
| `device p = d0` | device alias |
| `x = e` / `x op= e` | assignment |
| `if e then … elif e then … else … end` | |
| `loop … end` | |
| `while e do … end` | |
| `repeat … until e` | |
| `for init, cond, update do … end` | |
| `for let i in list do … end` | index iteration |
| `for let v of list do … end` | value iteration |
| `break` / `continue` | |
| `fn f(a, b) … end` | function |
| `return e` | |
| `@constexpr` | directive, on the line before an `fn` |
| `yield` / `sleep e` | |
| `name(args)` | instruction or call as a statement |

### Assignment targets

`x`, `arr[i]`, `d0.Setting`, `pump[0].Occupied`, `Light["Inside"].On`, and any undeclared name (as a placeholder).
