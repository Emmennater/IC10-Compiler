---
title: Stationeers-ICC Documentation!
---

# Stationeers-ICC

ICC is a custom programming language that compiles to [IC10](https://stationeers-wiki.com/IC10), the in-game scripting language for [Stationeers](https://store.steampowered.com/app/544550/Stationeers/).

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

## Example

```icc {% compile=true %}
let x = a + b
let y = x * 2
c = y - x
```
