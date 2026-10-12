// v1.19: the local calculator tool. A small recursive-descent parser: never eval, never Function, no network.
// Numbers, + - * / % ^, parentheses, unary minus, pi, e, and a few functions.

export const MAX_EXPR_CHARS = 200;

export const CALCULATOR_TOOL = {
  type: 'function',
  function: {
    name: 'calculator',
    description: 'Do arithmetic exactly, on this computer. Supports + - * / % ^, parentheses, pi, e, sqrt, abs, round, floor, ceil, ln, log10, sin, cos, tan, min, max.',
    parameters: {
      type: 'object',
      properties: { expression: { type: 'string', description: 'e.g. (12.5 * 4) / 3 + sqrt(16)' } },
      required: ['expression'],
    },
  },
} as const;

const FUNCS: Record<string, (...a: number[]) => number> = {
  sqrt: Math.sqrt, abs: Math.abs, round: Math.round, floor: Math.floor, ceil: Math.ceil,
  ln: Math.log, log10: Math.log10, sin: Math.sin, cos: Math.cos, tan: Math.tan,
  min: (...a) => Math.min(...a), max: (...a) => Math.max(...a),
};
const CONSTS: Record<string, number> = { pi: Math.PI, e: Math.E };

type Tok = { t: 'num'; v: number } | { t: 'id'; v: string } | { t: 'op'; v: string };

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    const num = /^(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?/.exec(src.slice(i));
    if (num) { out.push({ t: 'num', v: Number(num[0]) }); i += num[0].length; continue; }
    const id = /^[a-zA-Z_][a-zA-Z0-9_]*/.exec(src.slice(i));
    if (id) { out.push({ t: 'id', v: id[0].toLowerCase() }); i += id[0].length; continue; }
    if ('+-*/%^(),×÷'.includes(c)) { out.push({ t: 'op', v: c === '×' ? '*' : c === '÷' ? '/' : c }); i++; continue; }
    throw new Error(`Unexpected character "${c}".`);
  }
  return out;
}

/** Evaluate an arithmetic expression. Throws a plain-language Error on anything else. */
export function calculate(expression: unknown): number {
  if (typeof expression !== 'string') throw new Error('The expression must be text.');
  const src = expression.trim();
  if (!src) throw new Error('The expression is empty.');
  if (src.length > MAX_EXPR_CHARS) throw new Error(`The expression is longer than ${MAX_EXPR_CHARS} characters.`);
  const toks = tokenize(src);
  let p = 0;
  let depth = 0;
  const peek = () => toks[p];
  const isOp = (v: string) => peek()?.t === 'op' && peek()!.v === v;
  const expect = (v: string) => { if (!isOp(v)) throw new Error(`Expected "${v}".`); p++; };

  function expr(): number {
    let v = term();
    while (isOp('+') || isOp('-')) { const o = toks[p++].v; const r = term(); v = o === '+' ? v + r : v - r; }
    return v;
  }
  function term(): number {
    let v = unary();
    while (isOp('*') || isOp('/') || isOp('%')) {
      const o = toks[p++].v; const r = unary();
      if ((o === '/' || o === '%') && r === 0) throw new Error('Division by zero.');
      v = o === '*' ? v * r : o === '/' ? v / r : v % r;
    }
    return v;
  }
  function unary(): number {
    if (isOp('-')) { p++; return -unary(); }
    if (isOp('+')) { p++; return unary(); }
    return power();
  }
  function power(): number {
    const b = primary();
    if (isOp('^')) { p++; return Math.pow(b, unary()); } // right-associative
    return b;
  }
  function primary(): number {
    const tk = peek();
    if (!tk) throw new Error('The expression ends too early.');
    if (tk.t === 'num') { p++; return tk.v; }
    if (tk.t === 'op' && tk.v === '(') {
      if (++depth > 50) throw new Error('Too many parentheses.');
      p++; const v = expr(); expect(')'); depth--; return v;
    }
    if (tk.t === 'id') {
      p++;
      if (Object.prototype.hasOwnProperty.call(CONSTS, tk.v)) return CONSTS[tk.v];
      if (!Object.prototype.hasOwnProperty.call(FUNCS, tk.v)) throw new Error(`Unknown name "${tk.v}".`);
      expect('(');
      const args = [expr()];
      while (isOp(',')) { p++; args.push(expr()); }
      expect(')');
      return FUNCS[tk.v](...args);
    }
    throw new Error(`Unexpected "${tk.v}".`);
  }
  const v = expr();
  if (p !== toks.length) throw new Error(`Unexpected "${String(toks[p].v)}".`);
  if (!Number.isFinite(v)) throw new Error('The result is not a finite number.');
  return v;
}

/** The tool result text for the model. */
export function runCalculator(args: unknown): { ok: boolean; content: string } {
  let a: unknown = args;
  if (typeof a === 'string') { try { a = JSON.parse(a); } catch { a = {}; } }
  const expression = (a as { expression?: unknown } | null)?.expression;
  try {
    const v = calculate(expression);
    return { ok: true, content: `${String(expression).trim()} = ${Number(v.toPrecision(15))}` };
  } catch (e) {
    return { ok: false, content: `Error: ${e instanceof Error ? e.message : 'could not calculate'}` };
  }
}
