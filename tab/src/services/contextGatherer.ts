import * as vscode from 'vscode';
import { IntentTracker } from './intenttracker';
import { PrefixStage } from './contextStages/prefixStage';
import { LSPService } from './lspService';
import { ReplacementRegionStage } from './contextStages/replacementRegionStage';
import { ASTService } from './astService';
import { SuffixStage } from './contextStages/suffixStage';
import { CrossFileService } from './crossFile/crossFileService';
import { CompletionContext } from '../utils/types';

export class ContextGatherer implements vscode.Disposable {
    private readonly intentTracker: IntentTracker;
    private readonly lspService: LSPService;
    private readonly prefixStage: PrefixStage;
    private readonly suffixStage: SuffixStage;
    private readonly replacementRegionStage: ReplacementRegionStage;
    private readonly crossFileService: CrossFileService;

    constructor(astService: ASTService, intentTracker: IntentTracker, private readonly outputChannel: vscode.OutputChannel,) {
        this.intentTracker = intentTracker;
        this.lspService = new LSPService();
        this.prefixStage = new PrefixStage(this.lspService, this.outputChannel,);
        this.suffixStage = new SuffixStage();
        this.replacementRegionStage = new ReplacementRegionStage(
            astService,
        )
        this.crossFileService = new CrossFileService(this.lspService, astService);
    }

    async gatherContext(
        document: vscode.TextDocument,
        position: vscode.Position,
    ): Promise<CompletionContext> {
        const replacementRegion = this.replacementRegionStage.compute(
            document,
            position,
        )

        const prefix = await this.prefixStage.buildPrefix(
            document,
            position,
        ) ?? '';

        const suffix = this.suffixStage.buildSuffixAfterRegion(
            document,
            replacementRegion.range.end,
        )

        const crossFileSymbols = await this.crossFileService.getRelevantSymbols(document, prefix);


        const editHistory = this.intentTracker.serialize();

        return {
            prefix,
            replacementRegion,
            suffixAfterRegion: suffix,
            crossFileSymbols,
            cursorPosition: position,
            filePath: vscode.workspace.asRelativePath(document.uri),
            editHistory,
            languageId: document.languageId,
        }
    }

    dispose(): void {
        // No-op for now.
    }
}