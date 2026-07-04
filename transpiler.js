
/*
Temporary registers (r0 - r8)
Return value (r9)
Saved registers (r10 - r15)
Stack pointer (sp or r16)
Return address (ra or r17)
*/

/*
Input:
let x0 = 0
let x1 = 1
let x2 = 2
let x3 = 3
let x4 = 4
let x5 = 5
let x6 = 6

Output:
move r10 0
move r11 1
move r12 2
move r13 3
move r14 4
move r15 5

# LRU replacement
put db 0 r10
move r10 6
*/

const OP_INSTRUCTIONS = {
  "+": "add",
  "-": "sub",
  "*": "mul",
  "/": "div"
};

class Cache {
  static TEMP = new Set(["r0", "r1", "r2", "r3", "r4", "r5", "r6", "r7", "r8"]);

  constructor() {
    this.stackSize = 512;
    this.recentRegisters = ["r15", "r14", "r13", "r12", "r11", "r10"];
    this.var2reg = new Map();
    this.reg2var = new Map();
    this.var2stack = new Map();
    this.stackPointer = -1;
    this.tempRegisters = Array(9).fill(true); // r0 - r8
  }

  used(register) {
    // Update recent registers
    const index = this.recentRegisters.indexOf(register);

    if (index == -1) {
      throw "Register not found";
    }

    // Move to front
    this.recentRegisters.splice(index, 1);
    this.recentRegisters.unshift(register);
  }

  lru() {
    // Return least recently used
    return this.recentRegisters[this.recentRegisters.length - 1];
  }

  get(variableName) {
    let device = "db";
    let register = this.var2reg.get(variableName);
    let cacheInstructions = [];

    // Cache hit
    if (register) {
      this.used(register);

      return { register, cacheInstructions };
    }

    // Cache miss
    register = this.lru();

    const oldVariable = this.reg2var.get(register);

    // Update the stack if needed
    if (this.var2reg.has(oldVariable)) {
      let oldStackOffset = this.var2stack.get(oldVariable);

      // Assign a stack address if not already assigned
      if (oldStackOffset === undefined) {
        this.stackPointer++;
        this.var2stack.set(oldVariable, this.stackPointer);
        oldStackOffset = this.stackPointer;
      }

      cacheInstructions.push(`put ${device} ${oldStackOffset} ${register}`);
      this.var2reg.delete(oldVariable);
    }

    this.var2reg.set(variableName, register);
    this.reg2var.set(register, variableName);

    // Variable already in cache
    if (this.var2stack.has(variableName)) {
      let stackOffset = this.var2stack.get(variableName);
      cacheInstructions.push(`get ${register} ${device} ${stackOffset}`);
    }

    this.used(register);

    return { register, cacheInstructions };
  }

  getTemp() {
    const index = this.tempRegisters.indexOf(true);
    this.tempRegisters[index] = false;
    return `r${index}`;
  }

  freeTemp(register) {
    if (!Cache.TEMP.has(register)) return;
    const prefix = register[0];
    const index = Number(register.slice(1));
    this.tempRegisters[index] = true;
  }

  clearTemp() {
    this.tempRegisters = Array(9).fill(true);
  }
}

export function transpile(ast) {
  let gen = "";
  let statements = ast.children;
  let cache = new Cache();

  // Helpers

  function addInstruction(instruction) {
    gen += instruction + "\n";
  }

  function addInstructions(instructions) {
    for (let instruction of instructions) {
      addInstruction(instruction);
    }
  }

  // Expressions

  function free(expr) {
    if (expr.type !== "Register") return;
    if (!Cache.TEMP.has(expr.text)) return;
    cache.freeTemp(expr.text);
  }

  function binaryOp(expr, outRegister) {
    let left = expr.children[0];
    let op = expr.children[1];
    let right = expr.children[2];

    // Compute left and right expressions if needed
    if (left.type !== "Number" && left.type !== "Register") {
      left = processExpression(left);
    }

    if (right.type !== "Number" && right.type !== "Register") {
      right = processExpression(right);
    }

    // If left or right were temporary registers, free them
    free(left);
    free(right);
    
    let opInstruction = OP_INSTRUCTIONS[op.text];
    
    if (outRegister === "none") outRegister = cache.getTemp();

    addInstruction(`${opInstruction} ${outRegister} ${left.text} ${right.text}`);

    return { type: "Register", text: outRegister };
  }

  function property(expr, outRegister) {
    const variableName = expr.children[0].text;
    const { register, cacheInstructions } = cache.get(variableName, outRegister);

    addInstructions(cacheInstructions);

    if (outRegister !== "none") {
      addInstruction(`move ${outRegister} ${register}`);
    }

    return { type: "Register", text: register };
  }

  function number(expr, outRegister) {
    if (outRegister !== "none") {
      addInstruction(`move ${outRegister} ${expr.text}`);
    }
    
    return expr;
  }

  function bool(expr, outRegister) {
    let value = {
      type: "Number",
      text: expr.text === "true" ? "1" : "0"
    };
    
    if (outRegister !== "none") {
      addInstruction(`move ${outRegister} ${value.text}`);
    }
    
    return value;
  }

  function processExpression(expr, outRegister = "none") {
    if (expr.type === "Number") {
      return number(expr, outRegister);
    }

    if (expr.type === "Bool") {
      return number(expr, outRegister);
    }

    if (expr.type === "Property") {
      return property(expr, outRegister);
    }

    if (expr.type === "Parens") {
      return processExpression(expr.children[1], outRegister);
    }

    if (expr.type === "BinaryOp") {
      return binaryOp(expr, outRegister);
    }
  }

  // Statements

  function declaration(statement) {
    const variableName = statement.children[1].text;
    const { register, cacheInstructions } = cache.get(variableName);
    
    addInstructions(cacheInstructions);
    
    const value = processExpression(statement.children[3], register);

    free(value);
  }

  function assignment(statement) {
    const target = processExpression(statement.children[0]);
    const value = processExpression(statement.children[2], target.text);

    free(target); // Just in case the target happened to be a temporary register
    free(value);
  }

  function processStatement(statement) {
    if (statement.type === "Declaration") {
      return declaration(statement);
    }

    if (statement.type === "Assignment") {
      return assignment(statement);
    }

    // Not found: add raw instructions
    gen += statement.text;
  }

  function processStatements(statements) {
    for (let statement of statements) {
      processStatement(statement);
    }
  }

  processStatements(statements);

  return gen.trim();
}
