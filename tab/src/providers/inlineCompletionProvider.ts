import * as vscode from "vscode";
import { ApiClient } from "../api/apiClient";
import { ChatMessage } from "../utils/types";

const DEBOUNCE_MS = 300;

export class InlineCompletionProvider
  implements vscode.InlineCompletionItemProvider
{
  private readonly outputChannel: vscode.OutputChannel | undefined;
  private readonly apiClient: ApiClient;
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private latestRequestId = 0;

  constructor(outputChannel: vscode.OutputChannel) {
    this.outputChannel = outputChannel;
    this.apiClient = new ApiClient(outputChannel);
  }

  async provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    _context: vscode.InlineCompletionContext,
    token: vscode.CancellationToken,
  ): Promise<
    | vscode.InlineCompletionItem[]
    | vscode.InlineCompletionList
    | null
    | undefined
  > {
    const requestId = ++this.latestRequestId;

    await this.waitForDebounce(token);
    if (token.isCancellationRequested || requestId !== this.latestRequestId) {
      return null;
    }

    const prefix = document.getText(
      new vscode.Range(new vscode.Position(0, 0), position),
    );

    if (prefix.trim().length === 0) {
      return null;
    }

    this.log(
      `provideInlineCompletionItems called at ${position.line}:${position.character}`,
    );

    const cancelListener = token.onCancellationRequested(() => {
      this.apiClient.cancel();
    });

    try {
      const completion = await this.callCompletionAPI(
        [
          {
            role: "system",
            content:
              "Complete the code. Output ONLY the completion, no explanation",
          },
          { role: "user", content: prefix },
        ],
        token,
      );

      if (
        token.isCancellationRequested ||
        requestId !== this.latestRequestId ||
        !completion
      ) {
        return null;
      }

      return { items: [new vscode.InlineCompletionItem(completion)] };
    } catch (err) {
      if (this.isAbortError(err) || token.isCancellationRequested) {
        return null;
      }
      this.log(`API Error: ${err}`);
      return null;
    } finally {
      cancelListener.dispose();
    }
  }

  private waitForDebounce(
    token: vscode.CancellationToken,
  ): Promise<void> {
    return new Promise((resolve) => {
      if (this.debounceTimer) {
        clearTimeout(this.debounceTimer);
      }

      if (token.isCancellationRequested) {
        resolve();
        return;
      }

      const cancelListener = token.onCancellationRequested(() => {
        clearTimeout(this.debounceTimer);
        cancelListener.dispose();
        resolve();
      });

      this.debounceTimer = setTimeout(() => {
        cancelListener.dispose();
        resolve();
      }, DEBOUNCE_MS);
    });
  }

  private async callCompletionAPI(
    messages: ChatMessage[],
    token: vscode.CancellationToken,
  ): Promise<string | null> {
    const generator = await this.apiClient.complete(messages);
    let result = "";

    try {
      for await (const chunk of generator) {
        if (token.isCancellationRequested) {
          this.apiClient.cancel();
          return null;
        }
        result += chunk;
      }
    } catch (err) {
      if (this.isAbortError(err)) {
        return null;
      }
      throw err;
    }

    return result;
  }

  private isAbortError(err: unknown): boolean {
    return err instanceof Error && err.name === "AbortError";
  }

  private log(message: string): void {
    this.outputChannel?.appendLine(`Provider ${message}`);
  }
}
