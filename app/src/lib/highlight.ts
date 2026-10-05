// Syntax highlighting with Prism, colored like Zed's Catppuccin Latte / One Dark themes.
import Prism from "prismjs";
import "prismjs/components/prism-jsx";
import "prismjs/components/prism-typescript";
import "prismjs/components/prism-tsx";
import "prismjs/components/prism-bash";
import "prismjs/components/prism-json";
import "prismjs/components/prism-python";
import "prismjs/components/prism-markup-templating";
import "prismjs/components/prism-php";
import "prismjs/components/prism-diff";
import "prismjs/components/prism-sql";
import "prismjs/components/prism-yaml";
import "prismjs/components/prism-rust";
import "prismjs/components/prism-go";
import "prismjs/components/prism-ruby";
import "prismjs/components/prism-swift";
import "prismjs/components/prism-kotlin";
import "prismjs/components/prism-java";
import "prismjs/components/prism-toml";
import "prismjs/components/prism-docker";
import type { Theme } from "./theme";

const ALIAS: Record<string, string> = {
  js: "javascript", mjs: "javascript", cjs: "javascript", ts: "typescript", sh: "bash", shell: "bash", zsh: "bash", console: "bash",
  py: "python", rb: "ruby", rs: "rust", yml: "yaml", html: "markup", xml: "markup", vue: "markup", svg: "markup", dockerfile: "docker", kt: "kotlin",
};

export type Span = { text: string; types: string[] };

export function tokenize(code: string, lang?: string): Span[] {
  const name = lang ? ALIAS[lang.toLowerCase()] ?? lang.toLowerCase() : "";
  const grammar = name ? Prism.languages[name] : undefined;
  if (!grammar) return [{ text: code, types: [] }];
  const out: Span[] = [];
  const walk = (tokens: Array<string | Prism.Token>, types: string[]) => {
    for (const tk of tokens) {
      if (typeof tk === "string") out.push({ text: tk, types });
      else {
        const next = [...types, tk.type, ...(Array.isArray(tk.alias) ? tk.alias : tk.alias ? [tk.alias] : [])];
        if (typeof tk.content === "string") out.push({ text: tk.content, types: next });
        else walk(Array.isArray(tk.content) ? tk.content : [tk.content], next);
      }
    }
  };
  walk(Prism.tokenize(code, grammar), []);
  return out;
}

const LATTE = {
  keyword: "#8839EF", function: "#1E66F5", string: "#40A02B", number: "#FE640B", parameter: "#E64553", comment: "#9CA0B0",
  class: "#DF8E1D", operator: "#04A5E5", property: "#1E66F5", tag: "#1E66F5", attr: "#DF8E1D", inserted: "#40A02B", deleted: "#D20F39", variable: "#4C4F69",
};
const ONE_DARK = {
  keyword: "#C678DD", function: "#61AFEF", string: "#98C379", number: "#D19A66", parameter: "#E06C75", comment: "#5C6370",
  class: "#E5C07B", operator: "#56B6C2", property: "#E06C75", tag: "#E06C75", attr: "#D19A66", inserted: "#98C379", deleted: "#E06C75", variable: "#ABB2BF",
};

/** Color for a token's Prism types (most specific wins). */
export function colorFor(types: string[], t: Theme): string | undefined {
  const c = t.dark ? ONE_DARK : LATTE;
  const has = (...k: string[]) => k.some((x) => types.includes(x));
  if (has("comment", "prolog", "doctype", "cdata")) return c.comment;
  if (has("inserted")) return c.inserted;
  if (has("deleted")) return c.deleted;
  if (has("string", "char", "template-string", "regex", "url")) return c.string;
  if (has("number", "boolean", "constant")) return c.number;
  if (has("keyword", "important", "atrule", "rule")) return c.keyword;
  if (has("function", "function-variable", "method")) return c.function;
  if (has("class-name", "builtin", "maybe-class-name", "namespace", "type")) return c.class;
  if (has("parameter")) return c.parameter;
  if (has("operator", "entity")) return c.operator;
  if (has("tag")) return c.tag;
  if (has("attr-name", "attr-value", "selector")) return c.attr;
  if (has("property", "key")) return c.property;
  if (has("variable")) return c.variable;
  return undefined;
}
