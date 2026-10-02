import crypto from "node:crypto";
import type { BlobContent } from "@repo-facts/contract";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { type StyledFactory, type StyledWrapper, SyntaxTree, type TagReference, resolveTag, styledWrapperOf } from "../src/index.js";

// Tag resolution within a file (design-system-usage: every JSX element is classified where it is written).

function parse(text: string, filePath = "src/view.tsx"): SyntaxTree {
  const bytes = Buffer.from(text);
  const content: BlobContent = {
    entry: { path: filePath, mode: "100644", type: "file", objectId: "0".repeat(40), size: bytes.length },
    bytes,
    text,
    binary: false,
    digest: crypto.createHash("sha256").update(bytes).digest("hex"),
  };
  const result = SyntaxTree.parse(content);
  if (!result.ok) throw new Error(`${result.failure.reason}: ${result.failure.detail}`);
  return result.tree;
}

/** Every JSX tag in the file, resolved, in source order, without the binding object. */
function tags(text: string): Omit<TagReference, "binding">[] {
  const tree = parse(text);
  const found: Omit<TagReference, "binding">[] = [];
  tree.walk((node) => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const { binding: _binding, ...rest } = resolveTag(tree, node.tagName) as TagReference & { binding?: unknown };
      found.push(rest);
    }
  });
  return found;
}

describe("resolveTag", () => {
  it("resolves named, aliased, and default imports to their module and member", () => {
    const source = `
      import { Button, Text as SaltText } from "@salt-ds/core";
      import Card from "./Card";
      export const View = () => <Card><Button /><SaltText>hi</SaltText></Card>;
    `;
    expect(tags(source)).toEqual([
      { kind: "module", module: "./Card", members: [] },
      { kind: "module", module: "@salt-ds/core", members: ["Button"] },
      { kind: "module", module: "@salt-ds/core", members: ["Text"] },
    ]);
  });

  it("resolves a namespace member, and members of a named import", () => {
    const source = `
      import * as Salt from "@salt-ds/core";
      import { Menu } from "./menu";
      export const View = () => <><Salt.Button /><Menu.Item /></>;
    `;
    expect(tags(source)).toEqual([
      { kind: "module", module: "@salt-ds/core", members: ["Button"] },
      { kind: "module", module: "./menu", members: ["Menu", "Item"] },
    ]);
  });

  it("resolves require bindings like imports", () => {
    const source = `
      const { Button: SaltButton } = require("@salt-ds/core");
      const Salt = require("@salt-ds/core");
      export const View = () => <><SaltButton /><Salt.FlexLayout /></>;
    `;
    expect(tags(source)).toEqual([
      { kind: "module", module: "@salt-ds/core", members: ["Button"] },
      { kind: "module", module: "@salt-ds/core", members: ["FlexLayout"] },
    ]);
  });

  it("treats lowercase, dashed, and namespaced tags as intrinsic, even when the name is bound", () => {
    const source = `
      import { button } from "./elements";
      export const View = () => <div><button /><my-element /><svg:path /></div>;
    `;
    expect(tags(source)).toEqual([
      { kind: "intrinsic", name: "div" },
      { kind: "intrinsic", name: "button" },
      { kind: "intrinsic", name: "my-element" },
      { kind: "intrinsic", name: "svg:path" },
    ]);
  });

  it("leaves a name bound twice unresolved", () => {
    const source = `
      import { Button } from "@salt-ds/core";
      export function View() {
        const Button = () => null;
        return <Button />;
      }
    `;
    expect(tags(source)).toEqual([{ kind: "unresolved", reason: "bound_more_than_once", text: "Button" }]);
  });

  it("reports local, unbound, and computed tags", () => {
    const source = `
      function Card() { return null; }
      export class View {
        Slot = Card;
        render() { return <><Card /><Widget.Part /><this.Slot /></>; }
      }
    `;
    expect(tags(source)).toEqual([
      { kind: "local", name: "Card", members: [] },
      { kind: "unbound", name: "Widget", members: ["Part"] },
      { kind: "unresolved", reason: "computed", text: "this.Slot" },
    ]);
  });

  it("returns the local binding, for wrapper lookups", () => {
    const tree = parse(`const Primary = makeButton(); export const View = () => <Primary />;`);
    let reference: TagReference | undefined;
    tree.walk((node) => {
      if (ts.isJsxSelfClosingElement(node)) reference = resolveTag(tree, node.tagName);
    });
    expect(reference?.kind === "local" && reference.binding.constant && tree.text(reference.binding.constant)).toBe("makeButton()");
  });
});

const FACTORIES: StyledFactory[] = [
  { module: "styled-components", members: [] },
  { module: "styled-components", members: ["styled"] },
  { module: "@emotion/styled", members: [] },
];

/** The wrapper each named binding defines, summarized. */
function wrappers(text: string, names: string[]) {
  const tree = parse(text);
  const summary = (wrapper: StyledWrapper | null) =>
    wrapper && {
      factory: wrapper.factory.module,
      target: wrapper.target.kind === "local" ? { kind: "local", name: wrapper.target.name } : wrapper.target,
      body: wrapper.body.kind === "template" ? tree.text(wrapper.body.template) : wrapper.body.arguments.map((argument) => tree.text(argument)),
    };
  return Object.fromEntries(names.map((name) => [name, summary(styledWrapperOf(tree, tree.binding(name)!, FACTORIES))]));
}

describe("styledWrapperOf", () => {
  it("recognizes tagged-template and object-call wrappers of an imported component", () => {
    const source = `
      import styled from "styled-components";
      import { Button } from "@salt-ds/core";
      const Primary = styled(Button)\`color: red;\`;
      const Quiet = styled(Button)({ color: "gray" });
    `;
    expect(wrappers(source, ["Primary", "Quiet"])).toEqual({
      Primary: { factory: "styled-components", target: { kind: "module", module: "@salt-ds/core", members: ["Button"] }, body: "`color: red;`" },
      Quiet: { factory: "styled-components", target: { kind: "module", module: "@salt-ds/core", members: ["Button"] }, body: ['{ color: "gray" }'] },
    });
  });

  it("recognizes intrinsic wrappers, by member or by string", () => {
    const source = `
      import { styled } from "styled-components";
      import emotion from "@emotion/styled";
      const Box = styled.div\`display: flex;\`;
      const Row = emotion("div")({ display: "flex" });
    `;
    expect(wrappers(source, ["Box", "Row"])).toEqual({
      Box: { factory: "styled-components", target: { kind: "intrinsic", name: "div" }, body: "`display: flex;`" },
      Row: { factory: "@emotion/styled", target: { kind: "intrinsic", name: "div" }, body: ['{ display: "flex" }'] },
    });
  });

  it("looks through attrs and withConfig, and reports a local target as local", () => {
    const source = `
      import styled from "styled-components";
      function Card() { return null; }
      const Framed = styled(Card).attrs({ role: "region" }).withConfig({ displayName: "Framed" })\`border: 0;\`;
    `;
    expect(wrappers(source, ["Framed"])).toEqual({ Framed: { factory: "styled-components", target: { kind: "local", name: "Card" }, body: "`border: 0;`" } });
  });

  it("ignores unrelated calls, factories from other modules, and bindings that are not const", () => {
    const source = `
      import styled from "./my-styled";
      import real from "styled-components";
      import { Button } from "@salt-ds/core";
      const Made = makeButton(Button)({ color: "red" });
      const Lookalike = styled(Button)\`color: red;\`;
      let Reassigned = real(Button)\`color: red;\`;
      const Bare = real(Button);
    `;
    expect(wrappers(source, ["Made", "Lookalike", "Reassigned", "Bare"])).toEqual({ Made: null, Lookalike: null, Reassigned: null, Bare: null });
  });
});
