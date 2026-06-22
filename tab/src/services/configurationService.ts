import * as vscode from 'vscode';

export interface TabCompletionConfig {
    fireworksApiKey: string;
    groqApiKey: string;
    openrouterApiKey: string;
    groqModel: string;
    openrouterModel: string;
    fireworksModel: string;
    maxTokens: number;
    completionCacheMaxEntries: number;
    completionCacheTtlMs: number;
    lspCacheMaxEntries: number;
}

const DEFAULTS: TabCompletionConfig = {
    fireworksApiKey: '',
    groqApiKey: '',
    openrouterApiKey: '',

    groqModel: 'llama-3.1-8b-instant',
    openrouterModel: 'meta-llama/llama-3.3-70b-instruct:free',
    fireworksModel: 'accounts/fireworks/models/llama-v3p1-8b-instruct',

    maxTokens: 500,

    completionCacheMaxEntries: 100,
    completionCacheTtlMs: 30000,
    lspCacheMaxEntries: 100,
}

export class ConfigurationService implements vscode.Disposable {
    private static instance: ConfigurationService | null = null;
    private cachedConfig: TabCompletionConfig;
    private readonly disposables: vscode.Disposable[] = [];
    private readonly changeListeners: Set<(config: TabCompletionConfig) => void> = new Set();

    private constructor() {
        this.cachedConfig = this.loadConfig();
        this.registerConfigChangeListener();
    }

    static getInstance(): ConfigurationService {
        if (!ConfigurationService.instance) {
            ConfigurationService.instance = new ConfigurationService();
        }

        return ConfigurationService.instance;
    }

    private registerConfigChangeListener(): void {
        this.disposables.push(
            vscode.workspace.onDidChangeConfiguration((e) => {
                if (e.affectsConfiguration('tabai')) {
                    this.cachedConfig = this.loadConfig();
                    this.notifyListeners();
                }
            })
        )
    }

    private loadConfig(): TabCompletionConfig {
        const config = vscode.workspace.getConfiguration('tabai');

        return {
            fireworksApiKey: config.get<string>('fireworksApiKey', DEFAULTS.fireworksApiKey),
            groqApiKey: config.get<string>('groqApiKey', DEFAULTS.groqApiKey),
            openrouterApiKey: config.get<string>('openrouterApiKey', DEFAULTS.openrouterApiKey),
            groqModel: config.get<string>('groqModel', DEFAULTS.groqModel),
            openrouterModel: config.get<string>('openrouterModel', DEFAULTS.openrouterModel),
            fireworksModel: config.get<string>('fireworksModel', DEFAULTS.fireworksModel),
            maxTokens: config.get<number>('maxTokens', DEFAULTS.maxTokens),
            completionCacheMaxEntries: config.get<number>('completionCacheMaxEntries', DEFAULTS.completionCacheMaxEntries),
            completionCacheTtlMs: config.get<number>('completionCacheTtlMs', DEFAULTS.completionCacheTtlMs),
            lspCacheMaxEntries: config.get<number>('lspCacheMaxEntries', DEFAULTS.lspCacheMaxEntries),
        };
    }

    private notifyListeners(): void {
        for (const listener of this.changeListeners) {
            try {
                listener(this.cachedConfig);
            } catch {
                // Ignoring
            }
        }
    }

    get groqModel(): string { return this.cachedConfig.groqModel };
    get openrouterModel(): string { return this.cachedConfig.openrouterModel };
    get fireworksModel(): string { return this.cachedConfig.fireworksModel };
    get fireworksApiKey(): string { return this.cachedConfig.fireworksApiKey };
    get groqApiKey(): string { return this.cachedConfig.groqApiKey };
    get openrouterApiKey(): string { return this.cachedConfig.openrouterApiKey };
    get maxTokens(): number { return this.cachedConfig.maxTokens };
    get completionCacheMaxEntries(): number { return this.cachedConfig.completionCacheMaxEntries };
    get completionCacheTtlMs(): number { return this.cachedConfig.completionCacheTtlMs };
    get lspCacheMaxEntries(): number { return this.cachedConfig.lspCacheMaxEntries };

    onConfigChange(callback: (config: TabCompletionConfig) => void): vscode.Disposable {
        this.changeListeners.add(callback);
        return { dispose: () => this.changeListeners.delete(callback) };
    }

    dispose() {
        this.disposables.forEach(d => d.dispose());
        this.changeListeners.clear();
    }
}

export function getConfig(): ConfigurationService {
    return ConfigurationService.getInstance();
}
