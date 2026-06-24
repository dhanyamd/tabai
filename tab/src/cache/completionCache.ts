import * as vscode from 'vscode';
import { BoundedCache, buildCacheKey } from './boundedCache';
import { ReplacementEdit } from '../utils/types';
import { getConfig } from '../services/configurationService';
import * as crypto from 'crypto';

export class CompletionCache implements vscode.Disposable {
    private cache: BoundedCache<ReplacementEdit>;
    private readonly disposables: vscode.Disposable[] = [];
    private ttlMs: number;
    private currentMaxEntries: number;
    private contentHashByDocument: Map<string, { version: number, hash: string }> = new Map();


    constructor(){
        const configService = getConfig();
        this.currentMaxEntries = configService.completionCacheMaxEntries;
        this.ttlMs = configService.completionCacheTtlMs;
        this.cache = new BoundedCache<ReplacementEdit>(this.currentMaxEntries);
        this.disposables.push(
            configService.onConfigChange((config) => {
                if (config.completionCacheMaxEntries !== this.currentMaxEntries) {
                    this.currentMaxEntries = config.completionCacheMaxEntries;
                    this.cache = new BoundedCache<ReplacementEdit>(this.currentMaxEntries);
                }

                if (config.completionCacheMaxEntries !== this.currentMaxEntries) {
                    this.ttlMs = config.completionCacheTtlMs;
                }
            })
        );
        this.disposables.push(
            vscode.workspace.onDidCloseTextDocument(document => {
                const uri = document.uri.toString();

                this.cache.invalidateGroup(uri);
                this.contentHashByDocument.delete(uri);
            })
        );
    }
    computeContentHash(content: string): string {
        return crypto.createHash('md5').update(content).digest('hex').slice(0, 16);
    }
    private getContentHash(document: vscode.TextDocument): string {
        const uri = document.uri.toString();
        const cached = this.contentHashByDocument.get(uri);

        if (cached && cached.version === document.version) {
            return cached.hash;
        }

        const hash = this.computeContentHash(document.getText());
        this.contentHashByDocument.set(uri, { version: document.version, hash });
        return hash;
    }
    get(
        document: vscode.TextDocument,
        position: vscode.Position,
        editHistoryHash: string,
    ): ReplacementEdit | undefined {
        const documentUri = document.uri.toString();
        const contentHash = this.getContentHash(document);

        const key = buildCacheKey(
            documentUri,
            contentHash,
            position.line,
            position.character,
            editHistoryHash
        );

        return this.cache.get(key);
    }

    set(
        document: vscode.TextDocument,
        position: vscode.Position,
        editHistoryHash: string,
        completion: ReplacementEdit,
    ): void {
        const documentUri = document.uri.toString();
        const contentHash = this.getContentHash(document);

        const key = buildCacheKey(
            documentUri,
            contentHash,
            position.line,
            position.character,
            editHistoryHash
        );
        this.cache.set(key, completion, { ttlMs: this.ttlMs, groupKey: documentUri });
    }

    dispose() {
        this.disposables.forEach(d => d.dispose());
        this.cache.clear();
        this.contentHashByDocument.clear();
    }

}