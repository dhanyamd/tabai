import * as vscode from 'vscode';
import { InlineCompletionProvider } from './providers/inlineCompletionProvider';

export function activate(context: vscode.ExtensionContext) {
	const outputChannel = vscode.window.createOutputChannel('tabai');
	outputChannel.appendLine('tabai extension activated');
	outputChannel.show(true);

	const provider = new InlineCompletionProvider(outputChannel);

	const providerDisposable = vscode.languages.registerInlineCompletionItemProvider(
		{ pattern: '**' },
		provider
	);

	context.subscriptions.push(providerDisposable, outputChannel);
}

export function deactivate() {}
