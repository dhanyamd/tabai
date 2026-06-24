import * as vscode from 'vscode';
import { ApiClient } from '../api/apiClient';
import { ChatMessage, PendingCompletion, ReplacementEdit } from '../utils/types';


export class InlineCompletionProvider implements vscode.InlineCompletionItemProvider {
    private readonly outputChannel: vscode.OutputChannel;
    private readonly apiClient: ApiClient;
    private readonly intentTracker: IntentTracker;
    private readonly completionCache: CompletionCache;
    private readonly contextGatherer: ContextGatherer;
    private readonly promptBuilder: PromptBuilder;
    private readonly deduplicationService: DeduplicationService;
    private readonly deletionDecoration: DeletionDecoration;
    private pendingCompletion: PendingCompletion | null = null;
    private lastCompletionText = '';
    private lastCompletionPosition: vscode.Position | null = null;
    private lastCompletionUri: string | null = null;

    constructor(astService: ASTService, outputChannel: vscode.OutputChannel) {
        this.outputChannel = outputChannel;
        this.apiClient = new ApiClient(outputChannel);
        this.intentTracker = new IntentTracker();
        this.completionCache = new CompletionCache();
        this.promptBuilder = new PromptBuilder();
        this.contextGatherer = new ContextGatherer(
            astService,
            this.intentTracker,
            this.outputChannel,
        );
        this.deduplicationService = new DeduplicationService();
        this.deletionDecoration = new DeletionDecoration();
    }

    getIntentTracker(): IntentTracker {
        return this.intentTracker;
    }

    getPendingEdit(): ReplacementEdit | null {
        return this.pendingCompletion?.edit ?? null;
    }

    async provideInlineCompletionItems(document: vscode.TextDocument, position: vscode.Position, _context: vscode.InlineCompletionContext, token: vscode.CancellationToken): Promise<vscode.InlineCompletionList | null> {
        try {
            this.log(`provideInlineCompletionItems called at ${position.line}:${position.character}`);
            // Stage 1
            const pendingCompletionResult = this.handleExistingPendingCompletion(document, position);

            if (pendingCompletionResult !== undefined) {
                return pendingCompletionResult;
            }

            // Stage 2
            const editHistoryHash = this.intentTracker.computeHash()
            const cachedResult = this.tryCachedCompletion(
                document,
                position,
                editHistoryHash,
            )

            if (cachedResult) {
                return cachedResult;
            }

            // Stage 3
            const continuationResult = this.tryContinuePrediction(document, position);
            if (continuationResult !== undefined) {
                return continuationResult;
            }

            const completionContext = await this.contextGatherer.gatherContext(
                document,
                position,
            )

            const messages = this.promptBuilder.buildPrompt(completionContext);

            this.log(`Completion Context: ${JSON.stringify(messages)}`)

            if (token.isCancellationRequested) {
                this.log('Request cancelled');
                return null;
            }

            let completion = '';
            try {
                completion = await this.callCompletionAPI(
                    messages,
                    token,
                );

            } catch (err) {
                this.log(`API Error: ${err}`);
                return null;
            }

            completion = this.cleanCompletionText(completion)
            const dedupResult = this.deduplicationService.check(
                document,
                position,
                completion,
            )

            if (!dedupResult.proceed) {
                this.log(`Dedup rejected: ${dedupResult.reasonText ?? 'no reason provided'}`)
                return null;
            }
            completion = dedupResult.completion;

            const edit = this.computeMinimalReplacement(
                document,
                completionContext.replacementRegion.range.start,
                completionContext.replacementRegion.range.end,
                completion,
            )

            if (!edit || edit.insertText.length === 0) {
                this.log('No changed detected in completion')
                return null;
            }

            this.completionCache.set(document, position, editHistoryHash, edit);

            return this.activateCompletion(edit, document);
        } catch (error) {
            this.log(`Unexpected error: ${error}`);
            return null;
        }
    }

    private tryCachedCompletion(
        document: vscode.TextDocument,
        position: vscode.Position,
        editHistory: string
    ): vscode.InlineCompletionList | undefined {
        const cachedEdit = this.completionCache.get(
            document,
            position,
            editHistory,
        )

        if (!cachedEdit) {
            return undefined;
        }

        this.log(`Cache hit: ${cachedEdit.insertText}`)

        return this.activateCompletion(
            cachedEdit,
            document,
        )
    }

    private computeMinimalReplacement(
        document: vscode.TextDocument,
        regionStart: vscode.Position,
        regionEnd: vscode.Position,
        newText: string
    ): ReplacementEdit | null {
        // What’s in the document right now (from cursor to the end of the region we’re replacing).
        const oldText = document.getText(new vscode.Range(regionStart, regionEnd));
        if (oldText === newText) {
            return null;
        }

        // We only look at as many characters as the shorter string has, so we don’t go past the end.
        const minLength = Math.min(oldText.length, newText.length);

        // How many characters are the same at the beginning? Walk forward until they differ.
        let prefixLength = 0;
        while (prefixLength < minLength && oldText[prefixLength] === newText[prefixLength]) {
            prefixLength++;
        }

        // How many characters are the same at the end? Walk backward from the end (after the prefix).
        let suffixLength = 0;
        const maxSuffixLength = minLength - prefixLength;
        while (
            suffixLength < maxSuffixLength &&
            oldText[oldText.length - 1 - suffixLength] === newText[newText.length - 1 - suffixLength]
        ) {
            suffixLength++;
        }

        // Where does the “different part” end in oldText and in newText? (Everything between prefix and suffix.)
        const oldDiffEnd = oldText.length - suffixLength;
        const newDiffEnd = newText.length - suffixLength;
        // The bit we’re actually removing — this is what we show in red when you accept.
        const deletedText = oldText.slice(prefixLength, oldDiffEnd);

        // Turn character counts into line/column positions so we can tell the editor where to delete.
        const regionStartOffset = document.offsetAt(regionStart);
        const actualDeleteStart = document.positionAt(regionStartOffset + prefixLength);
        const actualDeleteEnd = document.positionAt(regionStartOffset + oldDiffEnd);

        return {
            // “Replace from cursor to here.” Editor needs the range to start at the cursor.
            deleteRange: new vscode.Range(regionStart, actualDeleteEnd),
            // “Insert this.” It’s the new text from the start up to the end of the changed part.
            insertText: newText.slice(0, newDiffEnd),
            deletedText,
            // “Only highlight this part in red” — just the middle we’re deleting, not the whole range.
            _actualDeleteRange: deletedText ? new vscode.Range(actualDeleteStart, actualDeleteEnd) : undefined,
        };
    }

    private activateCompletion(
        edit: ReplacementEdit,
        document: vscode.TextDocument,
    ): vscode.InlineCompletionList {
        this.lastCompletionText = edit.insertText;
        this.lastCompletionPosition = edit.deleteRange.start;
        this.lastCompletionUri = document.uri.toString();

        this.pendingCompletion = {
            documentUri: document.uri.toString(),
            edit,
        };

        if (edit.deletedText.length > 0) {
            const editor = vscode.window.activeTextEditor;
            if (editor && editor.document.uri.toString() === document.uri.toString()) {
                const decorationRange = edit._actualDeleteRange ?? edit.deleteRange;
                this.deletionDecoration.showDeletion(editor, decorationRange);
            }
        }

        return this.createInlineCompletionList(edit.insertText, edit.deleteRange);
    }

    private tryContinuePrediction(
        document: vscode.TextDocument,
        position: vscode.Position,
    ): vscode.InlineCompletionList | null | undefined {
        if (!this.lastCompletionText || !this.lastCompletionPosition || this.lastCompletionUri !== document.uri.toString()) {
            return undefined;
        }

        const charsSinceCompletion = position.character - this.lastCompletionPosition.character;
        if (position.line !== this.lastCompletionPosition.line || charsSinceCompletion <= 0) {
            return undefined;
        }

        const typedText = document.getText(
            new vscode.Range(this.lastCompletionPosition, position),
        )

        if (charsSinceCompletion <= this.lastCompletionText.length && this.lastCompletionText.startsWith(typedText)) {
            const remaining = this.lastCompletionText.slice(typedText.length);
            if (remaining) {
                this.log(`Continuing prediction: typed "${typedText}", remaining "${remaining}"`);
                return this.createInlineCompletionList(remaining, new vscode.Range(position, position));
            }
            this.log('User completed entire prediction');
            this.lastCompletionText = '';
            this.lastCompletionPosition = null;
            return null;
        }

        this.log(`Divergence detected: expected ${this.lastCompletionText}, got ${typedText}`);
        this.lastCompletionText = '';
        this.lastCompletionPosition = null;
        return undefined;
    }

    private createInlineCompletionList(text: string, range?: vscode.Range): vscode.InlineCompletionList {
        const newItem = new vscode.InlineCompletionItem(text, range);

        return { 'items': [newItem] };
    }

    private handleExistingPendingCompletion(
        document: vscode.TextDocument,
        position: vscode.Position,
    ): vscode.InlineCompletionList | null | undefined {
        if (!this.pendingCompletion) {
            return undefined;
        }

        const pendingPosition = this.pendingCompletion.edit.deleteRange.start;
        const pendingUri = this.pendingCompletion.documentUri;

        if (document.uri.toString() !== pendingUri) {
            this.clearPendingCompletion();
            return undefined;
        }

        if (position.line !== pendingPosition.line) {
            this.clearPendingCompletion();
            return undefined;
        }

        if (position.character === pendingPosition.character) {
            return this.createInlineCompletionList(this.pendingCompletion.edit.insertText);
        }

        this.clearPendingCompletion();
        return undefined;
    }

    clearPendingCompletion(): void {
        this.pendingCompletion = null;
        this.deletionDecoration.clearDecorations();
    }

    private async callCompletionAPI(
        messages: ChatMessage[],
        token: vscode.CancellationToken,
    ) {
        const generator = await this.apiClient.complete(
            messages
        )
        let result = '';

        for await (const chunk of generator) {
            if (token.isCancellationRequested) {
                this.apiClient.cancel();
                break;
            }
            result += chunk;
        }

        return result;
    }

    private cleanCompletionText(text: string): string {
        let cleaned = text.replace(/^```\w*\n?/, '').replace(/\n?```$/, '');
        const explanationPattern = /\n\n(?:\/\/|\/\*|#|Note:|Explanation:)[\s\S]*$/;
        cleaned = cleaned.replace(explanationPattern, '');
        return cleaned.trimEnd();
    }

    private log(message: string): void {
        this.outputChannel.appendLine(`[Provider] ${message}`);
    }

    dispose(): void {
        this.completionCache.dispose()
        this.apiClient.dispose()
        this.intentTracker.dispose()
        this.contextGatherer.dispose()
        this.deletionDecoration.dispose();
    }
}