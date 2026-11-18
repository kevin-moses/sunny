import ts from "typescript";

export interface CommentFinding {
  line: number;
  text: string;
}

const SHOWN_CHARS = 80;

function scriptKind(fileName: string): ts.ScriptKind {
  if (fileName.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (/\.[mc]?ts$/.test(fileName)) return ts.ScriptKind.TS;
  return ts.ScriptKind.JSX;
}

function isJSDocNode(node: ts.Node): boolean {
  return node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode;
}

function triviaComments(source: ts.SourceFile, token: ts.Node): ts.CommentRange[] {
  const fullStart = token.getFullStart();
  const start = token.getStart(source);
  if (start === fullStart) return [];
  const text = source.text;
  return [
    ...(ts.getTrailingCommentRanges(text, fullStart) ?? []),
    ...(ts.getLeadingCommentRanges(text, fullStart) ?? []),
  ].filter((range) => range.end <= start);
}

export function findComments(fileName: string, text: string): CommentFinding[] {
  const source = ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.Latest,
    false,
    scriptKind(fileName),
  );
  const byStart = new Map<number, ts.CommentRange>();
  const visit = (node: ts.Node): void => {
    if (ts.isJsxText(node) || isJSDocNode(node)) return;
    const children = node.getChildren(source);
    if (children.length === 0) {
      for (const range of triviaComments(source, node)) byStart.set(range.pos, range);
      return;
    }
    children.forEach(visit);
  };
  visit(source);
  return [...byStart.values()]
    .sort((a, b) => a.pos - b.pos)
    .map((range) => ({
      line: source.getLineAndCharacterOfPosition(range.pos).line + 1,
      text: text.slice(range.pos, range.end).replace(/\s+/g, " ").slice(0, SHOWN_CHARS),
    }));
}
