import { describe, expect, it } from 'vitest';
import { truncateText } from '../src/utils/truncate';

describe('truncateText', () => {
	it('短文本不截断', () => {
		expect(truncateText('hello', 10)).toEqual({
			text: 'hello',
			truncated: false,
			totalLength: 5,
		});
	});

	it('长度恰好等于上限不截断', () => {
		expect(truncateText('abcde', 5)).toEqual({
			text: 'abcde',
			truncated: false,
			totalLength: 5,
		});
	});

	it('超长文本截断并标记', () => {
		expect(truncateText('abcdefghijk', 5)).toEqual({
			text: 'abcde',
			truncated: true,
			totalLength: 11,
		});
	});

	it('空字符串', () => {
		expect(truncateText('', 10)).toEqual({
			text: '',
			truncated: false,
			totalLength: 0,
		});
	});

	it('中文按字符数截断', () => {
		expect(truncateText('你好世界啊', 3)).toEqual({
			text: '你好世',
			truncated: true,
			totalLength: 5,
		});
	});
});
