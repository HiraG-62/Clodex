const TOKENS_PER_K = 1_000;
const TOKENS_PER_M = 1_000_000;

// 累計の入力は億単位になるので、100 万以上は M で短くする
export const formatTokens = (n: number): string => (n >= TOKENS_PER_M ? `${(n / TOKENS_PER_M).toFixed(1)}M` : `${Math.round(n / TOKENS_PER_K)}k`);
