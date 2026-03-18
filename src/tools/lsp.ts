import fs from "node:fs/promises";
import ts from "typescript";

export interface LspDiagnostic {
  message: string;
  line: number;
  column: number;
  category: string;
}

export interface LspSymbol {
  name: string;
  kind: string;
  line: number;
}

export async function getTypeScriptDiagnostics(filePath: string): Promise<LspDiagnostic[]> {
  const content = await fs.readFile(filePath, "utf8");
  const sourceFile = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true);
  const program = ts.createProgram([filePath], {
    allowJs: true,
    noEmit: true
  }, {
    fileExists: (target) => target === filePath,
    readFile: (target) => (target === filePath ? content : undefined),
    getSourceFile: (target, languageVersion) => {
      if (target !== filePath) {
        return undefined;
      }
      return ts.createSourceFile(target, content, languageVersion, true);
    },
    getDefaultLibFileName: ts.getDefaultLibFilePath,
    writeFile: () => undefined,
    getCurrentDirectory: () => process.cwd(),
    getDirectories: () => [],
    getCanonicalFileName: (value) => value,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n"
  });
  const diagnostics = [
    ...program.getSyntacticDiagnostics(sourceFile),
    ...program.getSemanticDiagnostics(sourceFile)
  ];
  return diagnostics.map((diagnostic) => {
    const location = diagnostic.start ? sourceFile.getLineAndCharacterOfPosition(diagnostic.start) : { line: 0, character: 0 };
    return {
      message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
      line: location.line + 1,
      column: location.character + 1,
      category: ts.DiagnosticCategory[diagnostic.category].toLowerCase()
    };
  });
}

export async function listTypeScriptSymbols(filePath: string): Promise<LspSymbol[]> {
  const content = await fs.readFile(filePath, "utf8");
  const sourceFile = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true);
  const symbols: LspSymbol[] = [];

  function visit(node: ts.Node): void {
    if (
      ts.isFunctionDeclaration(node) ||
      ts.isClassDeclaration(node) ||
      ts.isInterfaceDeclaration(node) ||
      ts.isTypeAliasDeclaration(node)
    ) {
      const name = node.name?.getText(sourceFile) ?? "anonymous";
      const location = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      symbols.push({
        name,
        kind: ts.SyntaxKind[node.kind],
        line: location.line + 1
      });
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return symbols;
}
