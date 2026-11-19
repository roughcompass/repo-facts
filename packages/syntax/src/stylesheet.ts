/**
 * Parse-only stylesheets: a tokenizer that follows CSS Syntax Level 3 and a
 * parser for rules, at-rules, and declarations, including native nesting.
 *
 * The SCSS and Less dialects add what their stylesheets need to be read as
 * data: `//` comments, variables, interpolation, mixin uses, SCSS nested
 * properties and placeholders, and parent-selector suffixes such as
 * `&-active`, which resolve into classes when the parent rule's selector ends
 * in one. Variables are skipped, never resolved, and nothing is compiled. An
 * interpolated selector or property can't be read statically, so it is
 * recorded as unresolved or unparsed rather than guessed. Sass's indented
 * syntax is not parsed.
 *
 * Nothing is fetched, imported, or evaluated: `@import` and `url()` are
 * recorded as data. Parsing stops at a node limit and a nesting-depth limit,
 * and a stylesheet that exceeds either is rejected whole, never half-read. A
 * declaration the syntax rules discard as invalid is recorded as unparsed
 * rather than guessed. Offsets refer to the committed text, so evidence lines
 * stay exact.
 *
 * The parser's identity is part of the detector configuration, so a change to
 * it produces a new Surveyor release.
 */

export const STYLESHEET_PARSER = { name: "repo-facts-css", version: "1.1.0" } as const;
export const STYLESHEET_NODE_LIMIT = 200_000;
export const STYLESHEET_DEPTH_LIMIT = 64;

export const STYLESHEET_DIALECTS = ["css", "scss", "less"] as const;
export type StylesheetDialect = (typeof STYLESHEET_DIALECTS)[number];

const DIALECT_EXTENSIONS: ReadonlyMap<string, StylesheetDialect> = new Map([
  [".css", "css"],
  [".scss", "scss"],
  [".less", "less"],
]);

/** The dialect a path is parsed as, or null when it is not a stylesheet this parser reads. */
export function stylesheetDialectOf(path: string): StylesheetDialect | null {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? (DIALECT_EXTENSIONS.get(name.slice(dot).toLowerCase()) ?? null) : null;
}

export interface StylesheetLimits {
  nodes: number;
  depth: number;
}

export type CssToken =
  | { type: "ident" | "function" | "at-keyword" | "string" | "url" | "delim"; value: string; start: number; end: number }
  | { type: "hash"; value: string; id: boolean; start: number; end: number }
  | { type: "number" | "percentage"; value: string; start: number; end: number }
  | { type: "dimension"; value: string; unit: string; start: number; end: number }
  | { type: "whitespace" | "bad-string" | "bad-url" | "cdo" | "cdc" | "colon" | "semicolon" | "comma" | "[" | "]" | "(" | ")" | "{" | "}"; start: number; end: number }
  /** A preprocessor variable reference, `$name` in SCSS or Less, by name. */
  | { type: "variable"; value: string; start: number; end: number }
  /** SCSS `#{...}`, Less `@{...}`, or a Less `~"..."` escape, with its contents as written. Never evaluated. */
  | { type: "interpolation"; value: string; start: number; end: number };

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
  /** SCSS placeholder selectors, such as `%button`. */
  placeholders: string[];
  /** A parent-selector suffix, such as `-active` in `&-active`; resolved into classes when the parent's selector ends in one. */
  suffix: string | null;
  /** Part of the compound is interpolated, or its suffix can't be resolved, so what it selects isn't known. */
  unresolved: boolean;
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
  /** Mixins and extends the block applies, as written: SCSS `@include` and `@extend`, Less mixin calls and `:extend`. Their declarations aren't known here. */
  includes: string[];
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
  includes: string[];
  start: number;
  end: number;
}

export type CssNode = CssRule | CssAtRule;

export interface CssUnparsed {
  start: number;
  end: number;
  reason: "invalid_declaration" | "bad_token" | "interpolated_property";
  /** The declared property, when the declaration names one before its value went bad. */
  property: string | null;
}

/** A selector that can't be read statically: interpolated, or a parent suffix whose parent doesn't end in a class. */
export interface CssUnresolved {
  start: number;
  end: number;
  reason: "interpolated_selector" | "parent_suffix";
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
  /** Selectors the preprocessor dialects can't resolve statically. */
  unresolved: CssUnresolved[];
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
  /** CSS by default; SCSS and Less add their own syntax. */
  dialect?: StylesheetDialect;
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
    const dialect = options.dialect ?? "css";
    const tokens = tokenize(text, limits.nodes, dialect);
    const parser = new Parser(text, tokens, limits, dialect);
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

/** Tokenizes CSS text (CSS Syntax Level 3, section 4), with the SCSS or Less additions for those dialects. Comments are dropped. */
export function tokenize(text: string, nodeLimit = STYLESHEET_NODE_LIMIT, dialect: StylesheetDialect = "css"): CssToken[] {
  const tokens: CssToken[] = [];
  const length = text.length;
  const preprocessed = dialect !== "css";
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

  /** Whether the `url(` contents from +from+ hold a variable, interpolation, or quote before the closing parenthesis. */
  const urlExpression = (from: number): boolean => {
    for (let index = from; index < length && at(index) !== 0x29 && !isNewline(at(index)); index++) {
      const c = at(index);
      if (c === 0x24 || c === 0x22 || c === 0x27 || (c === 0x23 && at(index + 1) === 0x7b) || (c === 0x40 && dialect === "less")) return true;
    }
    return false;
  };

  const consumeIdentLike = (start: number): CssToken => {
    const name = consumeIdentSequence();
    if (name.toLowerCase() === "url" && at(i) === 0x28) {
      i++;
      let lookahead = i;
      while (isWhitespace(at(lookahead)) && isWhitespace(at(lookahead + 1))) lookahead++;
      const next = isWhitespace(at(lookahead)) ? at(lookahead + 1) : at(lookahead);
      if (next === 0x22 || next === 0x27) return { type: "function", value: name, start, end: i };
      // In SCSS and Less, `url($base + "/a.png")` is a function of an expression, not an unquoted URL.
      if (preprocessed && urlExpression(i)) return { type: "function", value: name, start, end: i };
      return consumeUrl(start);
    }
    if (at(i) === 0x28) {
      i++;
      return { type: "function", value: name, start, end: i };
    }
    return { type: "ident", value: name, start, end: i };
  };

  /** Consumes an interpolation's balanced braces from just after its opening brace; strings inside are skipped whole. */
  const consumeInterpolation = (start: number): CssToken => {
    const inner = i;
    let level = 1;
    while (i < length && level > 0) {
      const c = at(i);
      if (c === 0x22 || c === 0x27) {
        i++;
        consumeString(c, i - 1);
        continue;
      }
      if (c === 0x7b) level++;
      else if (c === 0x7d) level--;
      i++;
    }
    return { type: "interpolation", value: text.slice(inner, level === 0 ? i - 1 : i), start, end: i };
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
    // SCSS and Less line comments.
    if (preprocessed && c === 0x2f && at(i + 1) === 0x2f) {
      while (i < length && !isNewline(at(i))) i++;
      continue;
    }
    if (preprocessed && c === 0x24 && startsIdent(i + 1)) {
      i++;
      tokens.push({ type: "variable", value: consumeIdentSequence(), start, end: i });
      continue;
    }
    if ((dialect === "scss" && c === 0x23 && at(i + 1) === 0x7b) || (dialect === "less" && c === 0x40 && at(i + 1) === 0x7b)) {
      i += 2;
      tokens.push(consumeInterpolation(start));
      continue;
    }
    if (dialect === "less" && c === 0x7e && (at(i + 1) === 0x22 || at(i + 1) === 0x27)) {
      i += 2;
      const escaped = consumeString(at(start + 1), start + 1);
      tokens.push({ type: "interpolation", value: escaped.type === "string" ? escaped.value : text.slice(start + 2, i), start, end: i });
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

/** At-rules whose prelude names a stylesheet the rule loads, by dialect. */
const IMPORT_AT_RULES: Record<StylesheetDialect, ReadonlySet<string>> = { css: new Set(["import"]), scss: new Set(["import", "use", "forward"]), less: new Set(["import"]) };
/** SCSS at-rules that apply declarations defined elsewhere. */
const SCSS_INCLUDES = new Set(["include", "extend"]);

class Parser {
  private i = 0;
  private nodes = 0;
  private readonly unparsed: CssUnparsed[] = [];
  private readonly unresolved: CssUnresolved[] = [];
  private readonly imports: CssImport[] = [];
  private readonly preprocessed: boolean;

  constructor(
    private readonly text: string,
    private readonly tokens: CssToken[],
    private readonly limits: StylesheetLimits,
    private readonly dialect: StylesheetDialect,
  ) {
    this.preprocessed = dialect !== "css";
  }

  parse(mode: "stylesheet" | "declarations"): Stylesheet {
    let rules: CssNode[] = [];
    let declarations: CssDeclaration[] = [];
    if (mode === "declarations") {
      ({ declarations, rules } = this.blockContents(this.tokens.length, 0));
    } else {
      rules = this.ruleList(0);
    }
    if (this.preprocessed) this.resolveSuffixes(rules);
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
      unresolved: this.unresolved.sort((a, b) => a.start - b.start),
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
      } else if (this.preprocessed && this.preprocessorStatement(this.tokens.length) !== null) {
        continue;
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
    if (IMPORT_AT_RULES[this.dialect].has(name)) this.recordImport(preludeValues);
    const token = this.tokens[index];
    if (token?.type === "{") {
      const close = this.blockEnd(index + 1, end);
      this.checkDepth(depth + 1);
      this.i = index + 1;
      const contents = this.blockContents(close, depth + 1);
      this.i = Math.min(close + 1, end);
      return { kind: "at-rule", name, prelude, preludeValues, block: true, declarations: contents.declarations, rules: contents.rules, includes: contents.includes, start: keyword.start, end: this.endOf(close, end) };
    }
    this.i = token?.type === "semicolon" ? index + 1 : index;
    return { kind: "at-rule", name, prelude, preludeValues, block: false, declarations: [], rules: [], includes: [], start: keyword.start, end: this.endOf(index, end) };
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
    const selectors = parseSelectorList(preludeValues, this.text, depth, this.limits.depth, this.dialect);
    const start = this.tokens[preludeStart]!.start;
    if (selectors.some((selector) => selector.compounds.some((compound) => compound.unresolved))) this.unresolved.push({ start, end: this.tokens[index - 1]?.end ?? start, reason: "interpolated_selector" });
    const close = this.blockEnd(index + 1, end);
    this.checkDepth(depth + 1);
    this.i = index + 1;
    const contents = this.blockContents(close, depth + 1);
    this.i = Math.min(close + 1, end);
    // A Less selector's :extend() applies another rule's declarations too.
    const extend = this.dialect === "less" && selectors.some((selector) => selector.compounds.some((compound) => compound.pseudoClasses.includes("extend")));
    return {
      kind: "rule",
      prelude: this.slice(preludeStart, index),
      selectors,
      declarations: contents.declarations,
      rules: contents.rules,
      includes: extend ? [...contents.includes, this.slice(preludeStart, index)] : contents.includes,
      start,
      end: this.endOf(close, end),
    };
  }

  /** The contents of a block: declarations, nested rules, and at-rules (CSS Syntax and CSS Nesting). */
  private blockContents(end: number, depth: number): { declarations: CssDeclaration[]; rules: CssNode[]; includes: string[] } {
    const declarations: CssDeclaration[] = [];
    const rules: CssNode[] = [];
    const includes: string[] = [];
    while (this.i < end) {
      const token = this.tokens[this.i]!;
      if (token.type === "whitespace" || token.type === "semicolon") {
        this.i++;
        continue;
      }
      if (this.preprocessed) {
        const statement = this.preprocessorStatement(end);
        if (statement !== null) {
          if (statement.include) includes.push(statement.include);
          continue;
        }
      }
      if (token.type === "at-keyword") {
        const rule = this.atRule(depth, end) as CssAtRule;
        if (this.dialect === "scss" && SCSS_INCLUDES.has(rule.name)) includes.push(rule.prelude);
        rules.push(rule);
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
      if (stop === "{" && !custom && this.dialect === "scss" && this.nestedProperty(index, end, depth, declarations, rules, includes)) continue;
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
    return { declarations, rules, includes };
  }

  /**
   * Skips a preprocessor statement at the current token, returning the mixin
   * or extend it applies, if any: an SCSS or Less variable definition, a Less
   * detached ruleset, or a Less mixin call such as `.button();` or
   * `&:extend(.base);`. Returns null when the statement is something else.
   */
  private preprocessorStatement(end: number): { include: string | null } | null {
    const token = this.tokens[this.i]!;
    const next = this.nextSignificant(this.i + 1, end);
    const variable = token.type === "variable" || (this.dialect === "less" && token.type === "at-keyword" && this.tokens[next]?.type === "colon");
    const { index, stop } = this.statementEnd(this.i, end);
    if (variable) {
      // A Less detached ruleset, `@name: { ... }`, ends with its block.
      this.i = stop === "{" ? Math.min(this.blockEnd(index + 1, end) + 1, end) : Math.min(index + 1, end);
      return { include: null };
    }
    const mixinStart = token.type === "hash" || (token.type === "delim" && (token.value === "." || token.value === "#" || token.value === "&"));
    if (this.dialect === "less" && mixinStart && stop !== "{") {
      const include = this.slice(this.i, index);
      this.i = Math.min(index + 1, end);
      return { include };
    }
    return null;
  }

  /** The first top-level semicolon or opening brace from +from+, or the end. */
  private statementEnd(from: number, end: number): { index: number; stop: "semicolon" | "{" | "end" } {
    let level = 0;
    for (let index = from; index < end; index++) {
      const type = this.tokens[index]!.type;
      if (level === 0 && type === "semicolon") return { index, stop: "semicolon" };
      if (level === 0 && type === "{") return { index, stop: "{" };
      if (type === "(" || type === "[" || type === "function") level++;
      else if (type === ")" || type === "]") level = Math.max(0, level - 1);
      else if (type === "}" && level === 0) return { index, stop: "end" };
    }
    return { index: end, stop: "end" };
  }

  private nextSignificant(from: number, end: number): number {
    let index = from;
    while (index < end && this.tokens[index]!.type === "whitespace") index++;
    return index;
  }

  /** An SCSS nested property, `font: { family: serif; }`, read as `font-family: serif`. The brace is at +brace+. */
  private nestedProperty(brace: number, end: number, depth: number, declarations: CssDeclaration[], rules: CssNode[], includes: string[]): boolean {
    const first = this.tokens[this.i]!;
    let last = brace - 1;
    while (last > this.i && this.tokens[last]!.type === "whitespace") last--;
    if (first.type !== "ident" || this.tokens[last]?.type !== "colon" || this.nextSignificant(this.i + 1, brace) !== last) return false;
    const close = this.blockEnd(brace + 1, end);
    this.checkDepth(depth + 1);
    this.i = brace + 1;
    const contents = this.blockContents(close, depth + 1);
    for (const declaration of contents.declarations) declarations.push({ ...declaration, property: declaration.custom ? declaration.property : `${first.value.toLowerCase()}-${declaration.property}` });
    rules.push(...contents.rules);
    includes.push(...contents.includes);
    this.i = Math.min(close + 1, end);
    return true;
  }

  /**
   * Resolves parent-selector suffixes, such as `&-active` inside `.button`,
   * into classes, from the enclosing rule's selectors. A suffix whose parent
   * selector doesn't end in a class is unresolved.
   */
  private resolveSuffixes(rules: readonly CssNode[]) {
    const stack: { node: CssNode; parent: CssRule | null }[] = [...rules].reverse().map((node) => ({ node, parent: null }));
    while (stack.length) {
      const { node, parent } = stack.pop()!;
      if (node.kind === "rule") {
        for (const selector of node.selectors) {
          for (const compound of selector.compounds) {
            if (compound.suffix === null) continue;
            const bases = parent ? parent.selectors.map((candidate) => trailingClasses(candidate.compounds[candidate.compounds.length - 1])) : [];
            if (!bases.length || bases.some((names) => !names.length)) {
              compound.unresolved = true;
              this.unresolved.push({ start: node.start, end: node.start + node.prelude.length, reason: "parent_suffix" });
              continue;
            }
            const names = [...new Set(bases.flat().map((base) => `${base}${compound.suffix}`))];
            compound.classes.push(...names);
            if (TRAILING.get(compound) === PENDING) TRAILING.set(compound, names);
          }
        }
      }
      const next = node.kind === "rule" ? node : parent;
      for (let index = node.rules.length - 1; index >= 0; index--) stack.push({ node: node.rules[index]!, parent: next });
    }
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
    const interpolated = (upTo: number) => this.tokens.slice(from, upTo).some((token) => token.type === "interpolation" || token.type === "variable");
    if (first?.type !== "ident") {
      this.unparsed.push({ start, end: endOffset, reason: interpolated(to) ? "interpolated_property" : "invalid_declaration", property: null });
      return null;
    }
    index++;
    while (this.tokens[index]?.type === "whitespace" && index < to) index++;
    if (this.tokens[index]?.type !== "colon" || index >= to) {
      this.unparsed.push({ start, end: endOffset, reason: interpolated(index + 1) ? "interpolated_property" : "invalid_declaration", property: null });
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

const emptyCompound = (): CssCompoundSelector => ({ type: null, universal: false, nesting: false, classes: [], ids: [], attributes: [], pseudoClasses: [], pseudoElements: [], argumentClasses: [], placeholders: [], suffix: null, unresolved: false });

/** The class each compound ends with, for resolving a nested parent suffix; PENDING until its own suffix resolves. */
const PENDING = "pending";
const TRAILING = new WeakMap<CssCompoundSelector, readonly string[] | typeof PENDING>();
const trailingClasses = (compound: CssCompoundSelector | undefined): readonly string[] => {
  const trailing = compound ? TRAILING.get(compound) : undefined;
  return Array.isArray(trailing) ? trailing : [];
};
const SUFFIX_TOKENS = new Set(["ident", "number", "dimension", "percentage"]);
const isInterpolated = (value: ComponentValue | undefined) => value?.kind === "token" && (value.token.type === "interpolation" || value.token.type === "variable");

const SELECTOR_ARGUMENT_PSEUDOS = new Set(["is", "where", "not", "has", "matches", "nth-child", "nth-last-child", "host", "host-context", "slotted", "global", "local"]);

/** Splits a selector list into complex selectors and their compounds. Unrecognized parts are ignored, never guessed. */
export function parseSelectorList(values: ComponentValue[], text: string, depth = 0, depthLimit = STYLESHEET_DEPTH_LIMIT, dialect: StylesheetDialect = "css"): CssComplexSelector[] {
  const preprocessed = dialect !== "css";
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
    // What the compound ends with: a class, a parent suffix, or anything else.
    let trailing: string | typeof PENDING | null = null;
    const flush = () => {
      if (started) {
        if (compounds.length) combinators.push(pendingCombinator ?? " ");
        compounds.push(current);
        TRAILING.set(current, trailing === PENDING ? PENDING : trailing === null ? [] : [trailing]);
      }
      current = emptyCompound();
      pendingCombinator = null;
      started = false;
      trailing = null;
    };
    // An adjacent interpolation makes a name partial: `.icon-#{$name}` or `#{$tag}-item`.
    const touchesInterpolation = (index: number) => {
      const part = parts[index]!;
      const before = parts[index - 1];
      const after = parts[index + 1];
      return (isInterpolated(before) && before!.end === part.start) || (isInterpolated(after) && after!.start === part.end);
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
        trailing = null;
        if (token.type === "interpolation" || token.type === "variable") {
          current.unresolved = true;
        } else if (token.type === "ident") {
          if (preprocessed && touchesInterpolation(index)) current.unresolved = true;
          else current.type = token.value.toLowerCase();
        } else if (token.type === "delim" && token.value === "*") {
          current.universal = true;
        } else if (token.type === "delim" && token.value === "&") {
          current.nesting = true;
          // A parent suffix, `&-active` or `&__label`, continues the parent's last name.
          let suffix = "";
          let end = part.end;
          while (preprocessed && parts[index + 1]?.kind === "token" && SUFFIX_TOKENS.has((parts[index + 1] as { token: CssToken }).token.type) && parts[index + 1]!.start === end) {
            end = parts[++index]!.end;
            suffix = text.slice(part.end, end);
          }
          if (suffix) {
            if (isInterpolated(parts[index + 1]) && parts[index + 1]!.start === end) current.unresolved = true;
            else {
              current.suffix = suffix;
              trailing = PENDING;
            }
          }
        } else if (token.type === "delim" && token.value === "%" && preprocessed && parts[index + 1]?.kind === "token" && (parts[index + 1] as { token: CssToken }).token.type === "ident") {
          current.placeholders.push(((parts[++index] as { token: CssToken }).token as { value: string }).value);
        } else if (token.type === "delim" && token.value === "." && isInterpolated(parts[index + 1])) {
          current.unresolved = true;
        } else if (token.type === "delim" && token.value === "." && parts[index + 1]?.kind === "token" && (parts[index + 1] as { token: CssToken }).token.type === "ident") {
          if (preprocessed && touchesInterpolation(index + 1)) {
            current.unresolved = true;
            index++;
          } else {
            const name = ((parts[++index] as { token: CssToken }).token as { value: string }).value;
            current.classes.push(name);
            trailing = name;
          }
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
              for (const inner of parseSelectorList(next.value, text, depth + 1, depthLimit, dialect)) {
                for (const compound of inner.compounds) current.argumentClasses.push(...compound.classes, ...compound.argumentClasses);
              }
            }
          }
        }
      } else if (part.kind === "block" && part.open === "[") {
        started = true;
        trailing = null;
        const name = part.value.find((value) => value.kind === "token" && value.token.type === "ident");
        if (name && name.kind === "token") current.attributes.push((name.token as { value: string }).value.toLowerCase());
      } else {
        started = true;
        trailing = null;
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
