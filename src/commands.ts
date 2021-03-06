import { spawnSync } from 'child_process';
import { commands, Terminal, TerminalOptions, Uri, workspace } from 'coc.nvim';
import { Location, Position, Range, TextDocumentEdit, TextDocumentPositionParams, TextEdit, WorkspaceEdit } from 'vscode-languageserver-protocol';
import { Cmd, Ctx, isRustDocument } from './ctx';
import * as ra from './lsp_ext';

class RunnableQuickPick {
  label: string;

  constructor(public runnable: ra.Runnable) {
    this.label = runnable.label;
  }
}

function codeFormat(expanded: ra.ExpandedMacro): string {
  let result = `// Recursive expansion of ${expanded.name}! macro\n`;
  result += '// ' + '='.repeat(result.length - 3);
  result += '\n\n';
  result += expanded.expansion;

  return result;
}

function parseSnippet(snip: string): [string, [number, number]] | undefined {
  const m = snip.match(/\$(0|\{0:([^}]*)\})/);
  if (!m) return undefined;
  const placeholder = m[2] ?? '';
  const range: [number, number] = [m.index!, placeholder.length];
  const insert = snip.replace(m[0], placeholder);
  return [insert, range];
}

function countLines(text: string): number {
  return (text.match(/\n/g) || []).length;
}

export function analyzerStatus(ctx: Ctx): Cmd {
  return async () => {
    const ret = await ctx.client.sendRequest(ra.analyzerStatus, null);
    workspace.echoLines(ret.split('\n'));
  };
}

export function matchingBrace(ctx: Ctx): Cmd {
  return async () => {
    const { document, position } = await workspace.getCurrentState();
    if (!isRustDocument(document)) return;

    const params: ra.MatchingBraceParams = {
      textDocument: { uri: document.uri },
      positions: [position],
    };

    const response = await ctx.client.sendRequest(ra.matchingBrace, params);
    if (response.length > 0) {
      workspace.jumpTo(document.uri, response[0]);
    }
  };
}

export function joinLines(ctx: Ctx): Cmd {
  return async () => {
    const doc = await workspace.document;
    if (!isRustDocument(doc.textDocument)) return;

    const mode = await workspace.nvim.call('visualmode');
    const range = await workspace.getSelectedRange(mode, doc);
    if (!range) {
      return;
    }
    const param: ra.JoinLinesParams = {
      textDocument: { uri: doc.uri },
      ranges: [range],
    };
    const items = await ctx.client.sendRequest(ra.joinLines, param);
    await doc.applyEdits(items);
  };
}

export function parentModule(ctx: Ctx): Cmd {
  return async () => {
    const { document, position } = await workspace.getCurrentState();
    if (!isRustDocument(document)) return;

    const param: TextDocumentPositionParams = {
      textDocument: { uri: document.uri },
      position,
    };

    const response = await ctx.client.sendRequest(ra.parentModule, param);
    if (response.length > 0) {
      const uri = response[0].targetUri;
      const range = response[0].targetRange;

      workspace.jumpTo(uri, range.start);
    }
  };
}

export function ssr(ctx: Ctx): Cmd {
  return async () => {
    const input = await workspace.callAsync<string>('input', ['Enter request like this: foo($a:expr, $b:expr) ==>> bar($a, foo($b)): ']);
    workspace.nvim.command('normal! :<C-u>', true);
    if (!input) {
      return;
    }

    if (!input.includes('==>>')) {
      return;
    }

    const param: ra.SsrParams = {
      query: input,
      parseOnly: false,
    };

    const edit = await ctx.client.sendRequest(ra.ssr, param);
    await workspace.applyEdit(edit);
  };
}

export function serverVersion(ctx: Ctx): Cmd {
  return async () => {
    const bin = ctx.resolveBin();
    if (!bin) {
      const msg = `Rust Analyzer is not found`;
      workspace.showMessage(msg, 'error');
      return;
    }

    const version = spawnSync(bin, ['--version'], { encoding: 'utf-8' }).stdout;
    workspace.showMessage(version);
  };
}

export function run(ctx: Ctx): Cmd {
  return async () => {
    const { document, position } = await workspace.getCurrentState();
    if (!isRustDocument(document)) return;

    workspace.showMessage(`Fetching runnable...`);

    const params: ra.RunnablesParams = {
      textDocument: { uri: document.uri },
      position,
    };
    const runnables = await ctx.client.sendRequest(ra.runnables, params);

    const items: RunnableQuickPick[] = [];
    for (const r of runnables) {
      items.push(new RunnableQuickPick(r));
    }

    const idx = await workspace.showQuickpick(items.map((o) => o.label));
    if (idx === -1) {
      return;
    }

    const runnable = items[idx].runnable;
    const cmd = `${runnable.bin} ${runnable.args.join(' ')}`;
    const opt: TerminalOptions = {
      name: runnable.label,
      cwd: runnable.cwd!,
      env: runnable.env,
    };
    workspace.createTerminal(opt).then((t: Terminal) => {
      t.sendText(cmd);
    });
  };
}

export function runSingle(): Cmd {
  return async (runnable: ra.Runnable) => {
    const { document } = await workspace.getCurrentState();
    if (!runnable || !isRustDocument(document)) return;

    const cmd = `${runnable.bin} ${runnable.args.join(' ')}`;
    const opt: TerminalOptions = {
      name: runnable.label,
      cwd: runnable.cwd!,
      env: runnable.env,
    };
    workspace.createTerminal(opt).then((t: Terminal) => {
      t.sendText(cmd);
    });
  };
}

export function syntaxTree(ctx: Ctx): Cmd {
  return async () => {
    const doc = await workspace.document;
    if (!isRustDocument(doc.textDocument)) return;

    const mode = await workspace.nvim.call('visualmode');
    let range: Range | null = null;
    if (mode) {
      range = await workspace.getSelectedRange(mode, doc);
    }
    const param: ra.SyntaxTreeParams = {
      textDocument: { uri: doc.uri },
      range,
    };

    const ret = await ctx.client.sendRequest(ra.syntaxTree, param);
    await workspace.nvim.command('tabnew').then(async () => {
      const buf = await workspace.nvim.buffer;
      buf.setLines(ret.split('\n'), { start: 0, end: -1 });
    });
  };
}

export function expandMacro(ctx: Ctx): Cmd {
  return async () => {
    const { document, position } = await workspace.getCurrentState();
    if (!isRustDocument(document)) return;

    const param: TextDocumentPositionParams = {
      textDocument: { uri: document.uri },
      position,
    };

    const expanded = await ctx.client.sendRequest(ra.expandMacro, param);
    if (!expanded) {
      return;
    }

    await workspace.nvim.command('tabnew').then(async () => {
      const buf = await workspace.nvim.buffer;
      buf.setLines(codeFormat(expanded).split('\n'), { start: 0, end: -1 });
    });
  };
}

export function collectGarbage(ctx: Ctx): Cmd {
  return async () => {
    await ctx.client.sendRequest(ra.collectGarbage, null);
  };
}

export function showReferences(): Cmd {
  return (uri: string, position: Position, locations: Location[]) => {
    if (!uri) {
      return;
    }
    commands.executeCommand('editor.action.showReferences', Uri.parse(uri), position, locations);
  };
}

export function upgrade(ctx: Ctx) {
  return async () => {
    await ctx.checkUpdate(false);
  };
}

export function toggleInlayHints(ctx: Ctx) {
  return async () => {
    if (!ctx.config.inlayHints.chainingHints) {
      workspace.showMessage(`Inlay hints for method chains is disabled. Toggle action does nothing;`, 'warning');
      return;
    }
    for (const sub of ctx.subscriptions) {
      // @ts-ignore
      if (typeof sub.toggle === 'function') sub.toggle();
    }
  };
}

export async function applySnippetWorkspaceEdit(edit: WorkspaceEdit) {
  if (!edit.documentChanges?.length) {
    return;
  }

  let selection: Range | undefined = undefined;
  let lineDelta = 0;
  const change = edit.documentChanges[0];
  if (TextDocumentEdit.is(change)) {
    for (const indel of change.edits) {
      const wsEdit: WorkspaceEdit = {};
      const parsed = parseSnippet(indel.newText);
      if (parsed) {
        const [newText, [placeholderStart, placeholderLength]] = parsed;
        const prefix = newText.substr(0, placeholderStart);
        const lastNewline = prefix.lastIndexOf('\n');

        const startLine = indel.range.start.line + lineDelta + countLines(prefix);
        const startColumn = lastNewline === -1 ? indel.range.start.character + placeholderStart : prefix.length - lastNewline - 1;
        const endColumn = startColumn + placeholderLength;
        selection = Range.create(startLine, startColumn, startLine, endColumn);

        const newChange = TextDocumentEdit.create(change.textDocument, [TextEdit.replace(indel.range, newText)]);
        wsEdit.documentChanges = [newChange];
      } else {
        lineDelta = countLines(indel.newText) - (indel.range.end.line - indel.range.start.line);
        wsEdit.documentChanges = [change];
      }

      await workspace.applyEdit(wsEdit);
    }

    if (selection) {
      const current = await workspace.document;
      if (current.uri !== change.textDocument.uri) {
        await workspace.loadFile(change.textDocument.uri);
        await workspace.jumpTo(change.textDocument.uri);
        // FIXME
        return;
      }
      await workspace.selectRange(selection);
    }
  }
}

export function applySnippetWorkspaceEditCommand(): Cmd {
  return async (edit: WorkspaceEdit) => {
    await applySnippetWorkspaceEdit(edit);
  };
}
