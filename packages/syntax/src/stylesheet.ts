/**
 * Parse-only stylesheets: a tokenizer that follows CSS Syntax Level 3 and a
 * parser for rules, at-rules, and declarations, including native nesting.
 *
 * Nothing is fetched, imported, or evaluated: `@import` and `url()` are
 * recorded as data. Parsing stops at a node limit and a nesting-depth limit,
 * and a stylesheet that exceeds either is rejected whole, never half-read. A
 * declaration the syntax rules discard as invalid is recorded as unparsed
 * rather than guessed. Offsets refer to the committed text, so evidence lines
 * stay exact.
 *
 * The parser's identity is part of the detector configuration, so a change to
 * it produces a new detector release.
 */

export const STYLESHEET_PARSER = { name: "repo-facts-css", version: "1.0.0" } as const;
export const STYLESHEET_NODE_LIMIT = 200_000;
export const STYLESHEET_DEPTH_LIMIT = 64;

export interface StylesheetLimits {
  nodes: number;
  depth: number;
}

export type CssToken =
  | { type: "ident" | "function" | "at-keyword" | "string" | "url" | "delim"; value: string; start: number; end: number }
  | { type: "hash"; value: string; id: boolean; start: number; end: number }
  | { type: "number" | "percentage"; value: string; start: number; end: number }
  | { type: "dimension"; value: string; unit: string; start: number; end: number }
  | { type: "whitespace" | "bad-string" | "bad-url" | "cdo" | "cdc" | "colon" | "semicolon" | "comma" | "[" | "]" | "(" | ")" | "{" | "}"; start: number; end: number };

/** A token, a function with its arguments, or a parenthesized, bracketed, or braced block. */
export type ComponentValue =
  | { kind: "token"; token: CssToken; start: number; end: number }
  | { kind: "function"; name: string; value: ComponentValue[]; start: number; end: number }
  | { kind: "block"; open: "(" | "[" | "{"; value: ComponentValue[]; start: number; end: number };

export interface CssDeclaration {
  /** As written for custom properties; lowercased otherwise. */
  property: string;
  custom: boolean;
  value: ComponentValue[];
  /** The value as written, trimmed, without `!important`. */
  text: string;
  important: boolean;
  start: number;
  end: number;
}

export interface CssCompoundSelector {
  /** A lowercased type selector, or null. */
  type: string | null;
  universal: boolean;
  /** Contains `&`, so it is relative to the enclosing rule. */
  nesting: boolean;
  classes: string[];
  ids: string[];
  attributes: string[];
  pseudoClasses: string[];
  pseudoElements: string[];
  /** Classes named inside pseudo-class arguments, such as `:is(.a)`. */
  argumentClasses: string[];
}

export interface CssComplexSelector {
  text: string;
  compounds: CssCompoundSelector[];
  /** The combinators between compounds: " ", ">", "+", or "~". */
  combinators: string[];
}

export interface CssRule {
  kind: "rule";
  prelude: string;
  selectors: CssComplexSelector[];
  declarations: CssDeclaration[];
  rules: CssNode[];
  start: number;
  end: number;
}

export interface CssAtRule {
  kind: "at-rule";
  /** Lowercased, without `@`. */
  name: string;
  prelude: string;
  preludeValues: ComponentValue[];
  /** False for a statement at-rule, such as `@import ...;`. */
  block: boolean;
  declarations: CssDeclaration[];
  rules: CssNode[];
  start: number;
  end: number;
}

export type CssNode = CssRule | CssAtRule;

export interface CssUnparsed {
  start: number;
  end: number;
  reason: "invalid_declaration" | "bad_token";
  /** The declared property, when the declaration names one before its value went bad. */
  property: string | null;
}

export interface CssImport {
  url: string;
  start: number;
  end: number;
}

export interface Stylesheet {
  text: string;
  /** Top-level rules and at-rules; for a declaration list, the nested rules. */
  rules: CssNode[];
  /** Top-level declarations, which only a declaration list has. */
  declarations: CssDeclaration[];
  unparsed: CssUnparsed[];
  imports: CssImport[];
  nodeCount: number;
  /** The 1-based line of an offset. */
  lineOf(offset: number): number;
}

export type StylesheetFailureReason = "stylesheet_node_limit" | "stylesheet_depth_limit";

export type StylesheetResult = { ok: true; stylesheet: Stylesheet } | { ok: false; failure: { reason: StylesheetFailureReason; detail: string } };

export interface StylesheetOptions {
  /** `declarations` parses the body of a rule, as styled-components templates are written. */
  mode?: "stylesheet" | "declarations";
  limits?: StylesheetLimits;
}

class LimitExceeded extends Error {
  constructor(readonly reason: StylesheetFailureReason) {
    super(reason);
  }
}

/** Parses a stylesheet, or a declaration list in `declarations` mode. */
export function parseStylesheet(text: string, options: StylesheetOptions = {}): StylesheetResult {
  const limits = options.limits ?? { nodes: STYLESHEET_NODE_LIMIT, depth: STYLESHEET_DEPTH_LIMIT };
  try {
    const tokens = tokenize(text, limits.nodes);
    const parser = new Parser(text, tokens, limits);
    const stylesheet = parser.parse(options.mode ?? "stylesheet");
    return { ok: true, stylesheet };
  } catch (error) {
    if (error instanceof LimitExceeded) {
      const detail = error.reason === "stylesheet_node_limit" ? `The stylesheet has more than ${limits.nodes} nodes` : `The stylesheet nests more than ${limits.depth} levels deep`;
      return { ok: false, failure: { reason: error.reason, detail } };
    }
    throw error;
  }
}

// ---------------------------------------------------------------- tokenizer

const LF = 0x0a;
const isNewline = (c: number) => c === LF || c === 0x0d || c === 0x0c;
const isWhitespace = (c: number) => isNewline(c) || c === 0x09 || c === 0x20;
const isDigit = (c: number) => c >= 0x30 && c <= 0x39;
const isHex = (c: number) => isDigit(c) || (c >= 0x41 && c <= 0x46) || (c >= 0x61 && c <= 0x66);
const isLetter = (c: number) => (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);
const isIdentStart = (c: number) => isLetter(c) || c >= 0x80 || c === 0x5f;
const isIdentChar = (c: number) => isIdentStart(c) || isDigit(c) || c === 0x2d;
const isNonPrintable = (c: number) => (c >= 0 && c <= 0x08) || c === 0x0b || (c >= 0x0e && c <= 0x1f) || c === 0x7f;

/** Tokenizes CSS text (CSS Syntax Level 3, section 4). Comments are dropped. */
export function tokenize(text: string, nodeLimit = STYLESHEET_NODE_LIMIT): CssToken[] {
  const tokens: CssToken[] = [];
  const length = text.length;
  let i = 0;
  const at = (offset: number) => (offset < length ? text.charCodeAt(offset) : -1);

  const validEscape = (offset: number) => at(offset) === 0x5c && at(offset + 1) !== -1 && !isNewline(at(offset + 1));
  const startsIdent = (offset: number) => {
    const c = at(offset);
    if (c === 0x2d) return isIdentStart(at(offset + 1)) || at(offset + 1) === 0x2d || validEscape(offset + 1);
    if (isIdentStart(c)) return true;
    return validEscape(offset);
  };
  const startsNumber = (offset: number) => {
    const c = at(offset);
    if (c === 0x2b || c === 0x2d) return isDigit(at(offset + 1)) || (at(offset + 1) === 0x2e && isDigit(at(offset + 2)));
    if (c === 0x2e) return isDigit(at(offset + 1));
    return isDigit(c);
  };

  /** Consumes an escape after the backslash; returns the code point's text. */
  const consumeEscape = (): string => {
    const c = at(i);
    if (c === -1) return "�";
    if (isHex(c)) {
      let hex = "";
      while (hex.length < 6 && isHex(at(i))) hex += text[i++];
      if (isWhitespace(at(i))) i += at(i) === 0x0d && at(i + 1) === LF ? 2 : 1;
      const code = parseInt(hex, 16);
      return code === 0 || (code >= 0xd800 && code <= 0xdfff) || code > 0x10ffff ? "�" : String.fromCodePoint(code);
    }
    const point = text.codePointAt(i)!;
    i += point > 0xffff ? 2 : 1;
    return String.fromCodePoint(point);
  };

  const consumeIdentSequence = (): string => {
    let result = "";
    for (;;) {
      const c = at(i);
      if (isIdentChar(c)) {
        result += text[i++];
      } else if (validEscape(i)) {
        i++;
        result += consumeEscape();
      } else {
        return result;
      }
    }
  };

  const consumeNumber = (): string => {
    const begin = i;
    if (at(i) === 0x2b || at(i) === 0x2d) i++;
    while (isDigit(at(i))) i++;
    if (at(i) === 0x2e && isDigit(at(i + 1))) {
      i += 2;
      while (isDigit(at(i))) i++;
    }
    const e = at(i);
    if ((e === 0x45 || e === 0x65) && (isDigit(at(i + 1)) || ((at(i + 1) === 0x2b || at(i + 1) === 0x2d) && isDigit(at(i + 2))))) {
      i += 2;
      while (isDigit(at(i))) i++;
    }
    return text.slice(begin, i);
  };

  const consumeString = (quote: number, start: number): CssToken => {
    let value = "";
    for (;;) {
      const c = at(i);
      if (c === -1 || c === quote) {
        if (c === quote) i++;
        return { type: "string", value, start, end: i };
      }
      if (isNewline(c)) return { type: "bad-string", start, end: i };
      if (c === 0x5c) {
        if (at(i + 1) === -1) {
          i++;
        } else if (isNewline(at(i + 1))) {
          i += at(i + 1) === 0x0d && at(i + 2) === LF ? 3 : 2;
        } else {
          i++;
          value += consumeEscape();
        }
        continue;
      }
      value += text[i++];
    }
  };

  const consumeBadUrlRemnants = () => {
    for (;;) {
      const c = at(i);
      if (c === -1) return;
      if (c === 0x29) {
        i++;
        return;
      }
      if (validEscape(i)) {
        i++;
        consumeEscape();
      } else {
        i++;
      }
    }
  };

  const consumeUrl = (start: number): CssToken => {
    let value = "";
    while (isWhitespace(at(i))) i++;
    for (;;) {
      const c = at(i);
      if (c === -1) return { type: "url", value, start, end: i };
      if (c === 0x29) {
        i++;
        return { type: "url", value, start, end: i };
      }
      if (isWhitespace(c)) {
        while (isWhitespace(at(i))) i++;
        if (at(i) === 0x29 || at(i) === -1) {
          if (at(i) === 0x29) i++;
          return { type: "url", value, start, end: i };
        }
        consumeBadUrlRemnants();
        return { type: "bad-url", start, end: i };
      }
      if (c === 0x22 || c === 0x27 || c === 0x28 || isNonPrintable(c)) {
        consumeBadUrlRemnants();
        return { type: "bad-url", start, end: i };
      }
      if (c === 0x5c) {
        if (validEscape(i)) {
          i++;
          value += consumeEscape();
          continue;
        }
        consumeBadUrlRemnants();
        return { type: "bad-url", start, end: i };
      }
      value += text[i++];
    }
  };

  const consumeIdentLike = (start: number): CssToken => {
    const name = consumeIdentSequence();
    if (name.toLowerCase() === "url" && at(i) === 0x28) {
      i++;
      let lookahead = i;
      while (isWhitespace(at(lookahead)) && isWhitespace(at(lookahead + 1))) lookahead++;
      const next = isWhitespace(at(lookahead)) ? at(lookahead + 1) : at(lookahead);
      if (next === 0x22 || next === 0x27) return { type: "function", value: name, start, end: i };
      return consumeUrl(start);
    }
    if (at(i) === 0x28) {
      i++;
      return { type: "function", value: name, start, end: i };
    }
    return { type: "ident", value: name, start, end: i };
  };

  const consumeNumeric = (start: number): CssToken => {
    const value = consumeNumber();
    if (startsIdent(i)) {
      const unit = consumeIdentSequence();
      return { type: "dimension", value, unit, start, end: i };
    }
    if (at(i) === 0x25) {
      i++;
      return { type: "percentage", value, start, end: i };
    }
    return { type: "number", value, start, end: i };
  };

  while (i < length) {
    if (tokens.length > nodeLimit) throw new LimitExceeded("stylesheet_node_limit");
    const start = i;
    const c = at(i);
    // Comments: /* ... */ (an unterminated comment runs to the end).
    if (c === 0x2f && at(i + 1) === 0x2a) {
      const close = text.indexOf("*/", i + 2);
      i = close === -1 ? length : close + 2;
      continue;
    }
    if (isWhitespace(c)) {
      while (isWhitespace(at(i))) i++;
      tokens.push({ type: "whitespace", start, end: i });
      continue;
    }
    if (c === 0x22 || c === 0x27) {
      i++;
      tokens.push(consumeString(c, start));
      continue;
    }
    if (c === 0x23) {
      if (isIdentChar(at(i + 1)) || validEscape(i + 1)) {
        i++;
        const id = startsIdent(i);
        tokens.push({ type: "hash", value: consumeIdentSequence(), id, start, end: i });
      } else {
        i++;
        tokens.push({ type: "delim", value: "#", start, end: i });
      }
      continue;
    }
    if (c === 0x28 || c === 0x29 || c === 0x5b || c === 0x5d || c === 0x7b || c === 0x7d) {
      i++;
      tokens.push({ type: text[start] as "(" | ")" | "[" | "]" | "{" | "}", start, end: i });
      continue;
    }
    if (c === 0x2c) {
      i++;
      tokens.push({ type: "comma", start, end: i });
      continue;
    }
    if (c === 0x3a) {
      i++;
      tokens.push({ type: "colon", start, end: i });
      continue;
    }
    if (c === 0x3b) {
      i++;
      tokens.push({ type: "semicolon", start, end: i });
      continue;
    }
    if (c === 0x2b || c === 0x2e) {
      if (startsNumber(i)) {
        tokens.push(consumeNumeric(start));
      } else {
        i++;
        tokens.push({ type: "delim", value: text[start]!, start, end: i });
      }
      continue;
    }
    if (c === 0x2d) {
      if (startsNumber(i)) {
        tokens.push(consumeNumeric(start));
      } else if (at(i + 1) === 0x2d && at(i + 2) === 0x3e) {
        i += 3;
        tokens.push({ type: "cdc", start, end: i });
      } else if (startsIdent(i)) {
        tokens.push(consumeIdentLike(start));
      } else {
        i++;
        tokens.push({ type: "delim", value: "-", start, end: i });
      }
      continue;
    }
    if (c === 0x3c && at(i + 1) === 0x21 && at(i + 2) === 0x2d && at(i + 3) === 0x2d) {
      i += 4;
      tokens.push({ type: "cdo", start, end: i });
      continue;
    }
    if (c === 0x40) {
      i++;
      if (startsIdent(i)) {
        tokens.push({ type: "at-keyword", value: consumeIdentSequence(), start, end: i });
      } else {
        tokens.push({ type: "delim", value: "@", start, end: i });
      }
      continue;
    }
    if (c === 0x5c) {
      if (validEscape(i)) {
        tokens.push(consumeIdentLike(start));
      } else {
        i++;
        tokens.push({ type: "delim", value: "\\", start, end: i });
      }
      continue;
    }
    if (isDigit(c)) {
      tokens.push(consumeNumeric(start));
      continue;
    }
    if (isIdentStart(c)) {
      tokens.push(consumeIdentLike(start));
      continue;
    }
    const point = text.codePointAt(i)!;
    i += point > 0xffff ? 2 : 1;
    tokens.push({ type: "delim", value: String.fromCodePoint(point), start, end: i });
  }
  return tokens;
}

// ------------------------------------------------------------------- parser

const CLOSER: Record<"(" | "[" | "{", ")" | "]" | "}"> = { "(": ")", "[": "]", "{": "}" };

class Parser {
  private i = 0;
  private nodes = 0;
  private readonly unparsed: CssUnparsed[] = [];
  private readonly imports: CssImport[] = [];

  constructor(
    private readonly text: string,
    private readonly tokens: CssToken[],
    private readonly limits: StylesheetLimits,
  ) {}

  parse(mode: "stylesheet" | "declarations"): Stylesheet {
    let rules: CssNode[] = [];
    let declarations: CssDeclaration[] = [];
    if (mode === "declarations") {
      ({ declarations, rules } = this.blockContents(this.tokens.length, 0));
    } else {
      rules = this.ruleList(0);
    }
    const lineStarts = [0];
    for (let index = 0; index < this.text.length; index++) {
      const code = this.text.charCodeAt(index);
      if (code === LF || code === 0x0c || (code === 0x0d && this.text.charCodeAt(index + 1) !== LF)) lineStarts.push(index + 1);
    }
    return {
      text: this.text,
      rules,
      declarations,
      unparsed: this.unparsed,
      imports: this.imports,
      nodeCount: this.nodes + this.tokens.length,
      lineOf(offset: number) {
        let low = 0;
        let high = lineStarts.length - 1;
        while (low < high) {
          const middle = (low + high + 1) >> 1;
          if (lineStarts[middle]! <= offset) low = middle;
          else high = middle - 1;
        }
        return low + 1;
      },
    };
  }

  private count() {
    if (++this.nodes + this.tokens.length > this.limits.nodes) throw new LimitExceeded("stylesheet_node_limit");
  }

  private checkDepth(depth: number) {
    if (depth > this.limits.depth) throw new LimitExceeded("stylesheet_depth_limit");
  }

  /** The top level of a stylesheet: rules and at-rules. */
  private ruleList(depth: number): CssNode[] {
    const rules: CssNode[] = [];
    while (this.i < this.tokens.length) {
      const token = this.tokens[this.i]!;
      if (token.type === "whitespace" || token.type === "cdo" || token.type === "cdc" || token.type === "semicolon") {
        this.i++;
      } else if (token.type === "at-keyword") {
        rules.push(this.atRule(depth, this.tokens.length));
      } else if (token.type === "}") {
        // A stray closing brace at the top level is dropped.
        this.i++;
      } else {
        const rule = this.qualifiedRule(depth, this.tokens.length);
        if (rule) rules.push(rule);
      }
    }
    return rules;
  }

  /** The index of the token that closes the current block, scanning balanced brackets from `from`. */
  private blockEnd(from: number, end: number): number {
    let level = 0;
    for (let index = from; index < end; index++) {
      const type = this.tokens[index]!.type;
      if (type === "(" || type === "[" || type === "{" || type === "function") level++;
      else if (type === ")" || type === "]" || type === "}") {
        if (level === 0) return index;
        level--;
      }
    }
    return end;
  }

  private atRule(depth: number, end: number): CssAtRule {
    this.count();
    const keyword = this.tokens[this.i++] as CssToken & { value: string };
    const name = keyword.value.toLowerCase();
    const preludeStart = this.i;
    // The prelude runs to a semicolon, an opening brace, or the end of the enclosing block, at the top level.
    let index = this.i;
    let level = 0;
    for (; index < end; index++) {
      const type = this.tokens[index]!.type;
      if (level === 0 && (type === "semicolon" || type === "{")) break;
      if (type === "(" || type === "[" || type === "function") level++;
      else if (type === ")" || type === "]") level = Math.max(0, level - 1);
      else if (type === "}" && level === 0) break;
    }
    const preludeValues = this.componentValues(preludeStart, index, depth);
    const prelude = this.slice(preludeStart, index);
    if (name === "import") this.recordImport(preludeValues);
    const token = this.tokens[index];
    if (token?.type === "{") {
      const close = this.blockEnd(index + 1, end);
      this.checkDepth(depth + 1);
      this.i = index + 1;
      const contents = this.blockContents(close, depth + 1);
      this.i = Math.min(close + 1, end);
      return { kind: "at-rule", name, prelude, preludeValues, block: true, declarations: contents.declarations, rules: contents.rules, start: keyword.start, end: this.endOf(close, end) };
    }
    this.i = token?.type === "semicolon" ? index + 1 : index;
    return { kind: "at-rule", name, prelude, preludeValues, block: false, declarations: [], rules: [], start: keyword.start, end: this.endOf(index, end) };
  }

  private qualifiedRule(depth: number, end: number): CssRule | null {
    const preludeStart = this.i;
    let index = this.i;
    let level = 0;
    for (; index < end; index++) {
      const type = this.tokens[index]!.type;
      if (level === 0 && type === "{") break;
      if (type === "(" || type === "[" || type === "function") level++;
      else if (type === ")" || type === "]") level = Math.max(0, level - 1);
    }
    if (index >= end) {
      // A prelude with no block is a parse error; it is dropped.
      this.i = end;
      return null;
    }
    this.count();
    const preludeValues = this.componentValues(preludeStart, index, depth);
    const close = this.blockEnd(index + 1, end);
    this.checkDepth(depth + 1);
    this.i = index + 1;
    const contents = this.blockContents(close, depth + 1);
    this.i = Math.min(close + 1, end);
    return {
      kind: "rule",
      prelude: this.slice(preludeStart, index),
      selectors: parseSelectorList(preludeValues, this.text, depth, this.limits.depth),
      declarations: contents.declarations,
      rules: contents.rules,
      start: this.tokens[preludeStart]!.start,
      end: this.endOf(close, end),
    };
  }

  /** The contents of a block: declarations, nested rules, and at-rules (CSS Syntax and CSS Nesting). */
  private blockContents(end: number, depth: number): { declarations: CssDeclaration[]; rules: CssNode[] } {
    const declarations: CssDeclaration[] = [];
    const rules: CssNode[] = [];
    while (this.i < end) {
      const token = this.tokens[this.i]!;
      if (token.type === "whitespace" || token.type === "semicolon") {
        this.i++;
        continue;
      }
      if (token.type === "at-keyword") {
        rules.push(this.atRule(depth, end));
        continue;
      }
      // A declaration runs to a top-level semicolon; a nested rule's prelude runs to a top-level brace.
      let index = this.i;
      let level = 0;
      let stop: "semicolon" | "{" | "end" = "end";
      for (; index < end; index++) {
        const type = this.tokens[index]!.type;
        if (level === 0 && type === "semicolon") {
          stop = "semicolon";
          break;
        }
        if (level === 0 && type === "{") {
          stop = "{";
          break;
        }
        if (type === "(" || type === "[" || type === "function") level++;
        else if (type === ")" || type === "]") level = Math.max(0, level - 1);
      }
      const custom = token.type === "ident" && token.value.startsWith("--");
      if (stop === "{" && !custom) {
        const rule = this.qualifiedRule(depth, end);
        if (rule) rules.push(rule);
        continue;
      }
      // A custom property may hold a braced block; it ends at the next top-level semicolon.
      let declarationEnd = index;
      if (stop === "{" && custom) {
        declarationEnd = this.customPropertyEnd(this.i, end);
      }
      const declaration = this.declaration(this.i, declarationEnd, depth);
      if (declaration) declarations.push(declaration);
      this.i = Math.min(declarationEnd + 1, end);
    }
    return { declarations, rules };
  }

  private customPropertyEnd(from: number, end: number): number {
    let level = 0;
    for (let index = from; index < end; index++) {
      const type = this.tokens[index]!.type;
      if (level === 0 && type === "semicolon") return index;
      if (type === "(" || type === "[" || type === "{" || type === "function") level++;
      else if (type === ")" || type === "]" || type === "}") level = Math.max(0, level - 1);
    }
    return end;
  }

  private declaration(from: number, to: number, depth: number): CssDeclaration | null {
    const first = this.tokens[from];
    const start = first?.start ?? 0;
    const endOffset = to > from ? this.tokens[to - 1]!.end : start;
    let index = from;
    if (first?.type !== "ident") {
      this.unparsed.push({ start, end: endOffset, reason: "invalid_declaration", property: null });
      return null;
    }
    index++;
    while (this.tokens[index]?.type === "whitespace" && index < to) index++;
    if (this.tokens[index]?.type !== "colon" || index >= to) {
      this.unparsed.push({ start, end: endOffset, reason: "invalid_declaration", property: null });
      return null;
    }
    index++;
    let valueStart = index;
    while (valueStart < to && this.tokens[valueStart]!.type === "whitespace") valueStart++;
    let valueEnd = to;
    while (valueEnd > valueStart && this.tokens[valueEnd - 1]!.type === "whitespace") valueEnd--;
    // `!important`, ASCII case-insensitive, with optional whitespace between the two tokens.
    let important = false;
    const last = this.tokens[valueEnd - 1];
    if (last?.type === "ident" && last.value.toLowerCase() === "important") {
      let bang = valueEnd - 2;
      while (bang >= valueStart && this.tokens[bang]!.type === "whitespace") bang--;
      const candidate = this.tokens[bang];
      if (bang >= valueStart && candidate?.type === "delim" && candidate.value === "!") {
        important = true;
        valueEnd = bang;
        while (valueEnd > valueStart && this.tokens[valueEnd - 1]!.type === "whitespace") valueEnd--;
      }
    }
    const custom = first.value.startsWith("--");
    for (let scan = valueStart; scan < valueEnd; scan++) {
      const type = this.tokens[scan]!.type;
      if (type === "bad-string" || type === "bad-url") {
        this.unparsed.push({ start, end: endOffset, reason: "bad_token", property: custom ? first.value : first.value.toLowerCase() });
        return null;
      }
    }
    this.count();
    return {
      property: custom ? first.value : first.value.toLowerCase(),
      custom,
      value: this.componentValues(valueStart, valueEnd, depth),
      text: this.slice(valueStart, valueEnd),
      important,
      start,
      end: endOffset,
    };
  }

  /** Builds component values from tokens, nesting functions and blocks without recursion past the depth limit. */
  private componentValues(from: number, to: number, depth: number): ComponentValue[] {
    const root: ComponentValue[] = [];
    const stack: { list: ComponentValue[]; node: Extract<ComponentValue, { kind: "function" | "block" }> | null; closer: string }[] = [{ list: root, node: null, closer: "" }];
    for (let index = from; index < to; index++) {
      const token = this.tokens[index]!;
      const top = stack[stack.length - 1]!;
      if (token.type === top.closer && top.node) {
        top.node.end = token.end;
        stack.pop();
        continue;
      }
      if (token.type === "function" || token.type === "(" || token.type === "[" || token.type === "{") {
        this.checkDepth(depth + stack.length);
        this.count();
        const node: Extract<ComponentValue, { kind: "function" | "block" }> =
          token.type === "function" ? { kind: "function", name: token.value.toLowerCase(), value: [], start: token.start, end: token.end } : { kind: "block", open: token.type, value: [], start: token.start, end: token.end };
        top.list.push(node);
        stack.push({ list: node.value, node, closer: token.type === "function" ? ")" : CLOSER[token.type] });
        continue;
      }
      top.list.push({ kind: "token", token, start: token.start, end: token.end });
    }
    // Unclosed functions and blocks end with the values.
    for (const frame of stack) if (frame.node) frame.node.end = to > from ? this.tokens[to - 1]!.end : frame.node.end;
    return root;
  }

  private recordImport(values: ComponentValue[]) {
    for (const value of values) {
      if (value.kind === "token" && (value.token.type === "url" || value.token.type === "string")) {
        this.imports.push({ url: (value.token as { value: string }).value, start: value.start, end: value.end });
        return;
      }
      if (value.kind === "function" && value.name === "url") {
        const argument = value.value.find((part) => part.kind === "token" && part.token.type === "string");
        if (argument && argument.kind === "token") this.imports.push({ url: (argument.token as { value: string }).value, start: value.start, end: value.end });
        return;
      }
    }
  }

  private slice(from: number, to: number): string {
    if (to <= from) return "";
    return this.text.slice(this.tokens[from]!.start, this.tokens[to - 1]!.end).trim();
  }

  private endOf(index: number, end: number): number {
    const token = this.tokens[Math.min(index, end - 1)];
    return token ? token.end : this.text.length;
  }
}

// ---------------------------------------------------------------- selectors

const emptyCompound = (): CssCompoundSelector => ({ type: null, universal: false, nesting: false, classes: [], ids: [], attributes: [], pseudoClasses: [], pseudoElements: [], argumentClasses: [] });

const SELECTOR_ARGUMENT_PSEUDOS = new Set(["is", "where", "not", "has", "matches", "nth-child", "nth-last-child", "host", "host-context", "slotted", "global", "local"]);

/** Splits a selector list into complex selectors and their compounds. Unrecognized parts are ignored, never guessed. */
export function parseSelectorList(values: ComponentValue[], text: string, depth = 0, depthLimit = STYLESHEET_DEPTH_LIMIT): CssComplexSelector[] {
  if (depth > depthLimit) throw new LimitExceeded("stylesheet_depth_limit");
  const groups: ComponentValue[][] = [[]];
  for (const value of values) {
    if (value.kind === "token" && value.token.type === "comma") groups.push([]);
    else groups[groups.length - 1]!.push(value);
  }
  const selectors: CssComplexSelector[] = [];
  for (const group of groups) {
    const parts = trimWhitespace(group);
    if (!parts.length) continue;
    const compounds: CssCompoundSelector[] = [];
    const combinators: string[] = [];
    let current = emptyCompound();
    let pendingCombinator: string | null = null;
    let started = false;
    const flush = () => {
      if (started) {
        if (compounds.length) combinators.push(pendingCombinator ?? " ");
        compounds.push(current);
      }
      current = emptyCompound();
      pendingCombinator = null;
      started = false;
    };
    for (let index = 0; index < parts.length; index++) {
      const part = parts[index]!;
      if (part.kind === "token") {
        const token = part.token;
        if (token.type === "whitespace") {
          if (started) flush();
          continue;
        }
        if (token.type === "delim" && (token.value === ">" || token.value === "+" || token.value === "~")) {
          if (started) flush();
          pendingCombinator = token.value;
          continue;
        }
        started = true;
        if (token.type === "ident") {
          current.type = token.value.toLowerCase();
        } else if (token.type === "delim" && token.value === "*") {
          current.universal = true;
        } else if (token.type === "delim" && token.value === "&") {
          current.nesting = true;
        } else if (token.type === "delim" && token.value === "." && parts[index + 1]?.kind === "token" && (parts[index + 1] as { token: CssToken }).token.type === "ident") {
          current.classes.push(((parts[++index] as { token: CssToken }).token as { value: string }).value);
        } else if (token.type === "hash") {
          current.ids.push(token.value);
        } else if (token.type === "colon") {
          const elementPseudo = parts[index + 1]?.kind === "token" && (parts[index + 1] as { token: CssToken }).token.type === "colon";
          if (elementPseudo) index++;
          const next = parts[index + 1];
          if (next?.kind === "token" && next.token.type === "ident") {
            index++;
            (elementPseudo ? current.pseudoElements : current.pseudoClasses).push(next.token.value.toLowerCase());
          } else if (next?.kind === "function") {
            index++;
            (elementPseudo ? current.pseudoElements : current.pseudoClasses).push(next.name);
            if (SELECTOR_ARGUMENT_PSEUDOS.has(next.name)) {
              for (const inner of parseSelectorList(next.value, text, depth + 1, depthLimit)) {
                for (const compound of inner.compounds) current.argumentClasses.push(...compound.classes, ...compound.argumentClasses);
              }
            }
          }
        }
      } else if (part.kind === "block" && part.open === "[") {
        started = true;
        const name = part.value.find((value) => value.kind === "token" && value.token.type === "ident");
        if (name && name.kind === "token") current.attributes.push((name.token as { value: string }).value.toLowerCase());
      } else {
        started = true;
      }
    }
    flush();
    if (!compounds.length) continue;
    const first = parts[0]!;
    const last = parts[parts.length - 1]!;
    selectors.push({ text: text.slice(first.start, last.end), compounds, combinators });
  }
  return selectors;
}

function trimWhitespace(values: ComponentValue[]): ComponentValue[] {
  let start = 0;
  let end = values.length;
  const isSpace = (value: ComponentValue) => value.kind === "token" && value.token.type === "whitespace";
  while (start < end && isSpace(values[start]!)) start++;
  while (end > start && isSpace(values[end - 1]!)) end--;
  return values.slice(start, end);
}

/** Every rule and at-rule in a stylesheet, depth first, with the rules that enclose it. */
export function walkStylesheet(nodes: readonly CssNode[], visit: (node: CssNode, ancestors: readonly CssNode[]) => void): void {
  const stack: { node: CssNode; ancestors: readonly CssNode[] }[] = [...nodes].reverse().map((node) => ({ node, ancestors: [] }));
  while (stack.length) {
    const { node, ancestors } = stack.pop()!;
    visit(node, ancestors);
    const next = [...ancestors, node];
    for (let index = node.rules.length - 1; index >= 0; index--) stack.push({ node: node.rules[index]!, ancestors: next });
  }
}
