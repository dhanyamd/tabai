import * as vscode from 'vscode'; 
import { ApiClient } from '../api/apiClient';

export class InlineCompletionProvider implements vscode.InlineCompletionItemProvider{
    private readonly outputChannel: vscode.OutputChannel | undefined;
    private readonly apiClient: ApiClient;

    constructor(outputChannel: vscode.OutputChannel) {
        this.outputChannel = outputChannel;
        this.apiClient = new ApiClient(outputChannel);
    }
    async provideInlineCompletionItems(document: vscode.TextDocument, position: vscode.Position, _context: vscode.InlineCompletionContext, token: vscode.CancellationToken): Promise<vscode.InlineCompletionItem[] | vscode.InlineCompletionList | null | undefined> {
        const prefix = document.getText(
            new vscode.Range(new vscode.Position(0,0), position)
        );
        this.log(`provideInlineCompletionItems called at ${position.line} : ${position.character}`);
        const newItem = new vscode.InlineCompletionItem(prefix + '!');
        return { 'items': [newItem]};   
    }
    private log(message: string): void {
        this.outputChannel?.appendLine(`Privider ${message}`);
    }


}

    
