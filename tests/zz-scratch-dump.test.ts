import { test } from "vitest";
import { parser } from "../lezer/parser.ts";
import type { TreeCursor } from "@lezer/common";

const src = `@constexpr
define MAX = 10
device pump = d0
let x = 1
let y
fn foo(a, b) do
  return a + b
end
if x < 3 then
  x = 1
elif x > 5 then
  x += 2
else
  x = -x
end
loop
  break
end
while x < MAX do
  continue
end
repeat
  yield
until x == 0
sleep 5
foo(1, 2)
pump.Setting = 1
d0.On = !true
pump[0].Setting = 3
pump["Name"].Setting = "s"
pump[nm].Setting = 4
x = (1 + 2) * 3 % 4 && 5 || 6
`;

function dump(cursor: TreeCursor, text: string, depth = 0): string {
  let out = "  ".repeat(depth) + cursor.type.name + " |" +
    text.substring(cursor.from, cursor.to).replace(/\n/g, "\\n") + "|\n";
  if (cursor.firstChild()) {
    do { out += dump(cursor, text, depth + 1); } while (cursor.nextSibling());
    cursor.parent();
  }
  return out;
}

test("dump", () => {
  console.log(dump(parser.parse(src).cursor(), src));
});
