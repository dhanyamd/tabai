interface CacheEntry<V> {
    value: V;
    expiresAt: number | null;
    groupKey: string | null; 
    lastAccessed: number;
    accessCount: number;
}

export class BoundedCache<V>{
    private cache: Map<string, CacheEntry<V>> = new Map();
    private groupIndex: Map<string, Set<string>> = new Map();
    constructor(private readonly maxSize: number){
        if (maxSize < 1){
            throw new Error('maxSize must be atleast 1');
        }
    }

    get(key: string): V | undefined {

    }

    set(key: string, value: V, options? : {
        ttlMs?: number | null;
        groupKey?: string | null;
    }): void {
        const existing = this.cache.get(key);
        if(existing){
            this.deleteEntry(key, existing);
        }
        while(this.cache.size >= this.maxSize){
            this.evictLeastUsed();
        }
    }

    private deleteEntry(key: string, entry: CacheEntry<V>): void {
        this.cache.delete(key);
        // groupkey? 
        if(entry.groupKey !== null){
            const keys = this.groupIndex.get(entry.groupKey);
            if(keys){
                keys.delete(key);
                if(keys.size === 0){
                    this.groupIndex.delete(entry.groupKey);
                }
            }
        }

    }
}