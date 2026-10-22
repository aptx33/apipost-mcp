export declare function normalizedRoute(method: any, url: any): string;
export declare function contractDifferences(actual: any, expected: any, item: any): any[];
export declare function syncBatch(items: any, io: any): Promise<{
    results: {
        key: any;
        action: any;
        target_id: any;
        status: string;
        differences: never[];
    }[];
    timings: {
        preparationMs: number;
        writeMs: number;
        verificationMs: number;
    };
    success: boolean;
}>;
