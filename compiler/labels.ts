/**
 * Label naming.
 *
 * Every generated label's spelling is decided here and nowhere else, so the
 * naming scheme is one screen of code rather than six counters scattered
 * through the lowering pass. Nothing outside this module should build a
 * label name by string concatenation, and nothing should infer a construct's
 * shape from a label's spelling - the IR records structure explicitly.
 */

/** The labels of one if/elif/else chain. */
export class IfLabels {
  private elifIndex = 0;
  private readonly index: number;

  constructor(index: number) {
    this.index = index;
  }

  /** Where every arm jumps once its body is done. */
  get end(): string {
    return `endif${this.index}`;
  }

  /** The label starting the next `elif` arm. */
  nextElif(): string {
    return `if${this.index}elif${this.elifIndex++}`;
  }

  /** The label starting the trailing `else` arm. */
  get otherwise(): string {
    return `else${this.index}`;
  }
}

export class LabelFactory {
  private ifCount = 0;
  private loopCount = 0;
  private whileCount = 0;
  private repeatCount = 0;
  private forCount = 0;
  private shortCircuitCount = 0;
  private inlineCount = 0;

  newIf(): IfLabels {
    return new IfLabels(this.ifCount++);
  }

  newLoop(): { head: string; end: string } {
    const i = this.loopCount++;
    return { head: `loop${i}`, end: `endloop${i}` };
  }

  newWhile(): { head: string; end: string } {
    const i = this.whileCount++;
    return { head: `while${i}`, end: `endwhile${i}` };
  }

  newRepeat(): { head: string; until: string; end: string } {
    const i = this.repeatCount++;
    return { head: `repeat${i}`, until: `until${i}`, end: `endrepeat${i}` };
  }

  newFor(): { head: string; update: string; end: string } {
    const i = this.forCount++;
    return { head: `for${i}`, update: `updatefor${i}`, end: `endfor${i}` };
  }

  newForIn(): { head: string, update: string; end: string } {
    const i = this.forCount++;
    return { head: `forin${i}`, update: `updateforin${i}`, end: `endforin${i}` };
  }

  newForOf(): { head: string, update: string; end: string } {
    const i = this.forCount++;
    return { head: `forof${i}`, update: `updateforof${i}`, end: `endforof${i}` };
  }

  /** Join point for a short-circuited `&&` / `||` in a condition. */
  newShortCircuit(): string {
    return `sc${this.shortCircuitCount++}`;
  }

  /** Where `return` inside an inlined function body jumps to. */
  newInlineEnd(): string {
    return `inline${this.inlineCount++}`;
  }

  /** Where `return` inside a jal-lowered function body jumps to. */
  functionEnd(functionName: string): string {
    return `end${functionName}`;
  }

  /** The label the main program starts at, when functions precede it. */
  get programStart(): string {
    return "ProgramStart";
  }
}
