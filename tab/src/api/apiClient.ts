import * as vscode from 'vscode';
import { getConfig } from '../services/configurationService';
import { ChatMessage, ChatStreamChunk } from '../utils/types';

export type ApiProvider = 'openrouter' | 'groq' | 'fireworks';

export class RateLimitError extends Error {
    readonly retryAfterSeconds: number;

    constructor(message: string, retryAfterSeconds: number) {
        super(message);
        this.name = 'RateLimitError';
        this.retryAfterSeconds = retryAfterSeconds;
    }
}

interface ProviderConfig {
    endpoint: string;
    getApiKey: () => string;
    getModel: () => string;
}

const PROVIDER_CONFIGS: Record<ApiProvider, ProviderConfig> = {
    groq: {
        endpoint: 'https://api.groq.com/openai/v1/chat/completions',
        getApiKey: () => getConfig().groqApiKey,
        getModel: () => getConfig().groqModel,
    },
    openrouter: {
        endpoint: 'https://openrouter.ai/api/v1/chat/completions',
        getApiKey: () => getConfig().openrouterApiKey,
        getModel: () => getConfig().openrouterModel,
    },
    fireworks: {
        endpoint: 'https://api.fireworks.ai/inference/v1/chat/completions',
        getApiKey: () => getConfig().fireworksApiKey,
        getModel: () => getConfig().fireworksModel,
    }
};

export class ApiClient implements vscode.Disposable {
    private readonly outputChannel: vscode.OutputChannel;
    private pendingRequest: AbortController | null = null;
    private rateLimitedUntil = 0;

    constructor(outputChannel: vscode.OutputChannel) {
        this.outputChannel = outputChannel;
    }

    isRateLimited(): boolean {
        return Date.now() < this.rateLimitedUntil;
    }

    getRateLimitRemainingMs(): number {
        return Math.max(0, this.rateLimitedUntil - Date.now());
    }

    markRateLimited(retryAfterSeconds: number): void {
        this.rateLimitedUntil = Date.now() + retryAfterSeconds * 1000;
    }

    getActiveProvider(): ApiProvider | null {
        const config = getConfig();
        if (config.groqApiKey) {return 'groq';}
        if (config.openrouterApiKey) {return 'openrouter';}
        if (config.fireworksApiKey) {return 'fireworks';}

        return null;
    }

    async complete(
        messages: ChatMessage[],
    ): Promise<AsyncGenerator<string, void, unknown>> {
        const provider = this.getActiveProvider();
        if (!provider) {
            throw new Error('No API key configured');
        }

        this.cancel();
        this.pendingRequest = new AbortController();

        const configService = getConfig();

        const maxTokens = configService.maxTokens;
        const providerConfig = PROVIDER_CONFIGS[provider];

        const model = providerConfig.getModel();

        const body: Record<string, unknown> = {
            model,
            messages,
            max_tokens: maxTokens,
            stream: true,
            temperature: 0.1,
        };

        this.log(`[${provider}] Request: model=${body.model}, max_tokens=${maxTokens}`);

        return this.streamRequest(
            providerConfig.endpoint,
            body,
            providerConfig.getApiKey(),
            this.pendingRequest.signal,
        );
    }

    async completeOnce(messages: ChatMessage[], maxTokens?: number): Promise<string> {
        return this.executeCompleteOnce(messages, maxTokens);
    }

    private async executeCompleteOnce(messages: ChatMessage[], maxTokensOverride?: number): Promise<string> {
        const provider = this.getActiveProvider();
        if (!provider) {
            throw new Error('No API key configured');
        }

        const remainingMs = this.getRateLimitRemainingMs();
        if (remainingMs > 0) {
            throw new RateLimitError(
                `Rate limited — wait ${Math.ceil(remainingMs / 1000)}s`,
                Math.ceil(remainingMs / 1000),
            );
        }

        const configService = getConfig();
        const providerConfig = PROVIDER_CONFIGS[provider];
        const maxTokens = maxTokensOverride ?? configService.maxTokens;
        const body: Record<string, unknown> = {
            model: providerConfig.getModel(),
            messages,
            max_tokens: maxTokens,
            stream: false,
            temperature: 0.1,
        };

        if (provider === 'openrouter') {
            body['reasoning'] = { exclude: true };
        }

        const maxRetries = 2;

        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            this.pendingRequest = new AbortController();

            this.log(`[${provider}] Request (non-stream): model=${body.model}`);

            const response = await fetch(providerConfig.endpoint, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${providerConfig.getApiKey()}`,
                    'Content-Type': 'application/json',
                    'HTTP-Referer': 'https://github.com/dhanyamd/tabai',
                    'X-Title': 'TabAI',
                },
                body: JSON.stringify(body),
                signal: this.pendingRequest.signal,
            });

            if (response.status === 429) {
                const errorText = await response.text();
                const retryAfterSeconds = this.parseRetryAfterSeconds(errorText);
                this.rateLimitedUntil = Date.now() + retryAfterSeconds * 1000;

                if (attempt < maxRetries) {
                    this.log(
                        `[${provider}] Rate limited, retrying in ${retryAfterSeconds}s (${attempt + 1}/${maxRetries})`,
                    );
                    await this.sleep(retryAfterSeconds * 1000);
                    continue;
                }

                throw new RateLimitError(
                    `Rate limited by ${provider} for ${retryAfterSeconds}s`,
                    retryAfterSeconds,
                );
            }

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`API error ${response.status}: ${errorText}`);
            }

            const json = await response.json() as {
                choices?: Array<{
                    message?: {
                        content?: string | null;
                        reasoning?: string | null;
                        reasoning_content?: string | null;
                    };
                }>;
                error?: { message?: string };
            };

            if (json.error?.message) {
                throw new Error(json.error.message);
            }

            const message = json.choices?.[0]?.message;
            const content = this.extractResponseText(message);

            if (!content) {
                this.log(`[${provider}] Empty response body: ${JSON.stringify(message).slice(0, 300)}`);
            } else {
                this.log(`[${provider}] Response length: ${content.length}`);
            }

            this.rateLimitedUntil = 0;
            return content;
        }

        throw new Error('Request failed after retries');
    }

    private parseRetryAfterSeconds(errorText: string): number {
        try {
            const json = JSON.parse(errorText) as {
                error?: {
                    metadata?: {
                        retry_after_seconds?: number;
                        headers?: { 'Retry-After'?: string };
                    };
                };
            };
            const seconds = json.error?.metadata?.retry_after_seconds;
            if (typeof seconds === 'number' && seconds > 0) {
                return Math.ceil(seconds);
            }
            const header = json.error?.metadata?.headers?.['Retry-After'];
            if (header) {
                return Math.max(1, parseInt(header, 10) || 30);
            }
        } catch {
            // fall through
        }
        return 30;
    }

    private sleep(ms: number): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    private extractResponseText(
        message?: {
            content?: string | null;
            reasoning?: string | null;
            reasoning_content?: string | null;
        },
    ): string {
        if (!message) {
            return '';
        }

        if (message.content) {
            return message.content;
        }
        if (message.reasoning) {
            return message.reasoning;
        }
        if (message.reasoning_content) {
            return message.reasoning_content;
        }

        return '';
    }

    cancel(): void {
        if (this.pendingRequest) {
            this.pendingRequest.abort();
            this.pendingRequest = null;
        }
    }


    private async* streamRequest(
        endpoint: string,
        body: Record<string, unknown>,
        apiKey: string,
        signal: AbortSignal,
    ): AsyncGenerator<string, void, unknown> {
        const response = await fetch(endpoint, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(body),
            signal,
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`API error ${response.status}: ${errorText}`);
        }

        if (!response.body) {
            throw new Error('No response body');
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) {
                    break;
                }

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');

                buffer = lines.pop() || '';

                for (const line of lines) {
                    if (line.startsWith('data: ')) {
                        const data = line.slice(6);
                        if (data === '[DONE]') {
                            return;
                        }
                        try {
                            const chunk = JSON.parse(data) as ChatStreamChunk;
                            if (chunk.choices && chunk.choices.length > 0) {
                                const content = chunk.choices[0].delta?.content;
                                if (content) {
                                    yield content;
                                }
                            }
                        } catch (error) {
                            this.log(`Parse error: ${error}`);
                        }
                    }
                }
            }
        } finally {
            reader.releaseLock();
        }
    }


    private log(message: string): void {
        this.outputChannel.appendLine(`[ApiClient] ${message}`);
    }

    dispose() {
        this.cancel();
    }

}