/**
 * 文本截断工具
 */

/** 文本截断结果 */
export interface TruncateResult {
	text: string;
	/** 是否发生了截断 */
	truncated: boolean;
	/** 原始总长度（字符数） */
	totalLength: number;
}

/**
 * 截断超长文本，附带截断标记与原始总长度
 */
export function truncateText(text: string, maxLength: number): TruncateResult {
	if (text.length <= maxLength) {
		return { text, truncated: false, totalLength: text.length };
	}
	return {
		text: text.slice(0, maxLength),
		truncated: true,
		totalLength: text.length,
	};
}
