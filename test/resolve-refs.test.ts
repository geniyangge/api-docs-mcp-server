import { describe, expect, it } from 'vitest';
import { resolveRefs } from '../src/utils/resolve-refs';

const doc = {
	components: {
		schemas: {
			User: {
				type: 'object',
				properties: {
					id: { type: 'integer' },
					name: { type: 'string' },
					friend: { $ref: '#/components/schemas/User' },
				},
			},
			Order: {
				type: 'object',
				properties: {
					user: { $ref: '#/components/schemas/User' },
				},
			},
		},
	},
};

describe('resolveRefs', () => {
	it('递归展开内部 $ref', () => {
		const result = resolveRefs({ $ref: '#/components/schemas/Order' }, doc);
		expect(result.properties.user.properties.name).toEqual({ type: 'string' });
	});

	it('循环引用标记为 $ref-cycle', () => {
		const result = resolveRefs({ $ref: '#/components/schemas/User' }, doc);
		expect(result.properties.friend).toEqual({ '$ref-cycle': '#/components/schemas/User' });
	});

	it('未解析的引用标记为 $ref-unresolved', () => {
		const result = resolveRefs({ $ref: '#/components/schemas/Missing' }, doc);
		expect(result).toEqual({ '$ref-unresolved': '#/components/schemas/Missing' });
	});

	it('外部文件引用原样保留', () => {
		const node = { $ref: './common.yaml#/Pet' };
		expect(resolveRefs(node, doc)).toEqual(node);
	});

	it('数组元素递归展开', () => {
		const result = resolveRefs([{ $ref: '#/components/schemas/Order' }], doc);
		expect(result[0].properties.user.properties.id).toEqual({ type: 'integer' });
	});

	it('深度超限时标记 $ref-cycle', () => {
		const deep = { a: { b: { c: { $ref: '#/components/schemas/Order' } } } };
		const result = resolveRefs(deep, doc, 2);
		// Order(深度1) -> User(深度2) 正常展开；User.friend 引用自身时深度超限
		expect(result.a.b.c.properties.user.properties.friend).toEqual({
			'$ref-cycle': '#/components/schemas/User',
		});
	});

	it('不修改入参', () => {
		const node = { $ref: '#/components/schemas/Order' };
		resolveRefs(node, doc);
		expect(node).toEqual({ $ref: '#/components/schemas/Order' });
	});

	it('非对象值原样返回', () => {
		expect(resolveRefs('string', doc)).toBe('string');
		expect(resolveRefs(42, doc)).toBe(42);
		expect(resolveRefs(null, doc)).toBeNull();
		expect(resolveRefs(undefined, doc)).toBeUndefined();
	});
});
