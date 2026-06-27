import * as TreeSitter from 'web-tree-sitter';
import * as path from 'path';

const LANGUAGE_MAP: Record<string, string> = {
    typescript: 'tree-sitter-typescript.wasm',
    typescriptreact: 'tree-sitter-tsx.wasm',
    javascript: 'tree-sitter-javascript.wasm',
    javascriptreact: 'tree-sitter-javascript.wasm',
    python: 'tree-sitter-python.wasm',
    rust: 'tree-sitter-rust.wasm',
    go: 'tree-sitter-go.wasm',
    java: 'tree-sitter-java.wasm',
    c: 'tree-sitter-c.wasm',
    cpp: 'tree-sitter-cpp.wasm',
};

export class ASTService {
    private readonly grammarsDir: string;
    private readonly languageCache = new Map<string, TreeSitter.Language>();
    private parser: TreeSitter.Parser | null = null;
    private currentLanguageId: string | null = null;
    private _isReady = false;

    constructor(extensionPath: string) {
        this.grammarsDir = path.join(extensionPath, 'grammars');
    }

    get isReady(): boolean {
        return this._isReady;
    }

    async initialize(): Promise<void> {
        try {
            const wasmPath = path.join(this.grammarsDir, 'web-tree-sitter.wasm');
            await TreeSitter.Parser.init({
                locateFile: () => wasmPath,
            });
            this.parser = new TreeSitter.Parser();
            this._isReady = true;
        } catch {
            this._isReady = false;
        }
    }

    async ensureLanguage(languageId: string): Promise<boolean> {
        if (!this._isReady || !this.parser) return false;

        const wasmFile = LANGUAGE_MAP[languageId];
        if (!wasmFile) return false;

        if (this.languageCache.has(wasmFile)) {
            if (this.currentLanguageId !== languageId) {
                this.parser.setLanguage(this.languageCache.get(wasmFile)!);
                this.currentLanguageId = languageId;
            }
            return true;
        }

        try {
            const wasmPath = path.join(this.grammarsDir, wasmFile);
            const language = await TreeSitter.Language.load(wasmPath);
            this.languageCache.set(wasmFile, language);
            this.parser.setLanguage(language);
            this.currentLanguageId = languageId;
            return true;
        } catch {
            return false;
        }
    }

    parseSync(code: string): TreeSitter.Tree | null {
        if (!this._isReady || !this.parser) return null;

        return this.parser.parse(code);
    }

    withParsedTree<T>(code: string, fn: (tree: TreeSitter.Tree) => T): T | null {
        const tree = this.parseSync(code);
        if (!tree) return null;
        try {
            return fn(tree);
        } finally {
            tree.delete();
        }
    }

    dispose(): void {
        this.parser?.delete();
        this.parser = null;
        this.languageCache.clear();
        this._isReady = false;
    }
}