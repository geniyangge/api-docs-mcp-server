/**
 * $ref 懒解析工具
 * 在输出接口详情时，把文档内的内部引用（#/components/schemas/X）递归展开为真实定义，
 * 供 AI 直接阅读，无需再手动查 definitions
 */

/** 检测值是否为普通对象（非数组、非 null） */
function isPlainObject(value: unknown): value is Record<string, any> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 反转义单个 pointer 片段：~1 -> /、~0 -> ~，再做百分比解码（失败则原样返回） */
function unescapeSeg(seg: string): string {
	const unescaped = seg.replace(/~1/g, '/').replace(/~0/g, '~');
	try {
		return decodeURIComponent(unescaped);
	} catch {
		return unescaped;
	}
}

/**
 * 按 JSON Pointer（如 #/components/schemas/User）在文档中定位节点
 * 兼容 springfox 等工具生成的「定义名含未转义 /」的引用（如 #/definitions/xxx新增/编辑）：
 * 按从「整段合并」到「单段」逐级尝试 key
 */
function getByPointer(root: any, pointer: string): any {
	if (!pointer.startsWith('#/')) {
		return undefined;
	}
	const segs = pointer
		.slice(2)
		.split('/')
		.map(seg => unescapeSeg(seg));
	const walk = (node: any, rest: string[]): any => {
		if (node == null) {
			return undefined;
		}
		if (rest.length === 0) {
			return node;
		}
		for (let take = rest.length; take >= 1; take--) {
			const key = rest.slice(0, take).join('/');
			if (key in Object(node)) {
				const found = walk(node[key], rest.slice(take));
				if (found !== undefined) {
					return found;
				}
			}
		}
		return undefined;
	};
	return walk(root, segs);
}

/**
 * 递归解析节点中的 $ref 引用
 * - 仅处理文档内部引用（#/ 开头），外部文件引用原样保留
 * - 深度超限或循环引用时以 { $ref-cycle } 标记，防止无限递归
 * - 不修改入参，返回新对象
 */
export function resolveRefs(
	node: any,
	root: any,
	maxDepth = 12,
	seen: Set<string> = new Set()
): any {
	if (Array.isArray(node)) {
		return node.map(item => resolveRefs(item, root, maxDepth, seen));
	}
	if (!isPlainObject(node)) {
		return node;
	}

	const ref: unknown = node.$ref;
	if (typeof ref === 'string') {
		if (!ref.startsWith('#/')) {
			return node;
		}
		if (seen.has(ref) || maxDepth <= 0) {
			return { '$ref-cycle': ref };
		}
		const target = getByPointer(root, ref);
		if (target === undefined) {
			return { '$ref-unresolved': ref };
		}
		const nextSeen = new Set(seen);
		nextSeen.add(ref);
		return resolveRefs(target, root, maxDepth - 1, nextSeen);
	}

	const result: Record<string, any> = {};
	for (const [key, value] of Object.entries(node)) {
		result[key] = resolveRefs(value, root, maxDepth, seen);
	}
	return result;
}
