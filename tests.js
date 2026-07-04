import { transpile } from "./transpiler.js";
import { getAST } from "./helper.js";

const cases = `
input:
let y = 3 + 3
let x = (2 * 2) + (4 * y)
let z = 2 + 2 + 1

output:
add r10 3 3
mul r0 2 2
mul r1 4 r10
add r11 r0 r1
add r0 2 2
add r12 r0 1

input:
let a = 1
let b = 2
let c = 3
let d = 4
let e = 5
let f = 6
let g = 7

output:
move r10 1
move r11 2
move r12 3
move r13 4
move r14 5
move r15 6
put db 0 r10
move r10 7
`;

export function runTests() {
  let parsedCases = [];
  
  cases.split("input:").map(c => {
    if (c.trim() === "") return;
    let [input, output] = c.split("output:");
    input = input.trim();
    output = output.trim();
    parsedCases.push([input, output]);
  });

  for (let i = 0; i < parsedCases.length; i++) {
    let [input, output] = parsedCases[i];
    const ast = getAST(input);
    const ic10 = transpile(ast);

    // Assert match
    let passed = true;
    let error = "";

    for (let i = 0; i < ic10.length; i++) {
      if (ic10[i] !== output[i]) {
        error = `Expected ${output[i]}, got ${ic10[i]}`;
        passed = false;
        break;
      }
    }

    if (passed) {
      console.log(`%cTest ${i + 1} passed!`, "color: limegreen");
    } else {
      console.log(`%cTest ${i + 1} failed: ${error}`, "color: red");
    }
  }
}
