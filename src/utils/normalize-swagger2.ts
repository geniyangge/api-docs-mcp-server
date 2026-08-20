/**
 * Swagger 2.0 -> OpenAPI 3.x 归一化
 * 仅覆盖「读取接口文档」所需的结构转换，未提及的字段原样保留
 * 返回全新对象，不修改入参
 */

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];

/** 检测值是否为普通对象（非数组、非 null） */
function isPlainObject(value: unknown): value is Record<string, any> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 深拷贝并重写 $ref：#/definitions/X -> #/components/schemas/X */
function rewriteRefs(node: any): any {
	if (Array.isArray(node)) {
		return node.map(item => rewriteRefs(item));
	}
	if (!isPlainObject(node)) {
		return node;
	}
	const result: Record<string, any> = {};
	for (const [key, value] of Object.entries(node)) {
		result[key] =
			key === '$ref' && typeof value === 'string' && value.startsWith('#/definitions/')
				? '#/components/schemas/' + value.slice('#/definitions/'.length)
				: rewriteRefs(value);
	}
	return result;
}

/** host/basePath/schemes -> OpenAPI 3 servers */
function toServers(spec: any): any[] {
	if (!spec.host) {
		return [];
	}
	const schemes: string[] = spec.schemes && spec.schemes.length ? spec.schemes : ['https'];
	const basePath = spec.basePath || '';
	return schemes.map(scheme => ({ url: `${scheme}://${spec.host}${basePath}` }));
}

/** securityDefinitions(2.0) -> components/securitySchemes(3.x) */
function toSecuritySchemes(defs: any): Record<string, any> | undefined {
	if (!defs) {
		return undefined;
	}
	// 2.0 flow 名 -> 3.x flow 名
	const flowMap: Record<string, string> = {
		implicit: 'implicit',
		password: 'password',
		application: 'clientCredentials',
		accessCode: 'authorizationCode',
	};
	const result: Record<string, any> = {};
	for (const [name, def] of Object.entries<any>(defs)) {
		if (def.type === 'basic') {
			result[name] = { type: 'http', scheme: 'basic', description: def.description };
		} else if (def.type === 'apiKey') {
			result[name] = {
				type: 'apiKey',
				name: def.name,
				in: def.in,
				description: def.description,
			};
		} else if (def.type === 'oauth2') {
			// Swagger 2.0 标准结构：flow 为字符串，authorizationUrl/tokenUrl/scopes 挂在 def 上
			const flows: Record<string, any> = {};
			for (const [oldFlow, newFlow] of Object.entries(flowMap)) {
				if (def.flow !== oldFlow) {
					continue;
				}
				flows[newFlow] = {
					authorizationUrl: def.authorizationUrl,
					tokenUrl: def.tokenUrl,
					scopes: def.scopes || {},
				};
			}
			result[name] = { type: 'oauth2', flows, description: def.description };
		}
	}
	return Object.keys(result).length ? result : undefined;
}

/**
 * 单个 operation 转换：
 * - in:body 参数 -> requestBody
 * - in:formData 参数 -> requestBody(application/x-www-form-urlencoded)
 * - responses 的 schema/examples -> content
 */
function convertOperation(op: any, consumes: string[], produces: string[]): any {
	if (!op) {
		return undefined;
	}
	const result: any = { ...op };
	const requestType = op.consumes || consumes;
	const responseType = op.produces || produces;
	const jsonType = requestType[0] || 'application/json';
	const respType = responseType[0] || 'application/json';

	const bodyParam = (op.parameters || []).find((p: any) => p.in === 'body');
	const formParams = (op.parameters || []).filter((p: any) => p.in === 'formData');
	const restParams = (op.parameters || []).filter(
		(p: any) => p.in !== 'body' && p.in !== 'formData'
	);

	delete result.parameters;
	delete result.consumes;
	delete result.produces;

	if (bodyParam) {
		result.requestBody = {
			description: bodyParam.description,
			required: bodyParam.required,
			content: { [jsonType]: { schema: rewriteRefs(bodyParam.schema) } },
		};
	}
	if (formParams.length) {
		const properties: Record<string, any> = {};
		const required: string[] = [];
		for (const p of formParams) {
			properties[p.name] = {
				type: p.type,
				format: p.format,
				description: p.description,
				enum: p.enum,
				default: p.default,
			};
			if (p.required) {
				required.push(p.name);
			}
		}
		result.requestBody = {
			content: {
				'application/x-www-form-urlencoded': {
					schema: rewriteRefs({
						type: 'object',
						properties,
						required: required.length ? required : undefined,
					}),
				},
			},
		};
	}
	if (restParams.length) {
		result.parameters = rewriteRefs(restParams);
	}

	if (op.responses) {
		const responses: Record<string, any> = {};
		for (const [code, resp] of Object.entries<any>(op.responses)) {
			const converted: any = { ...resp };
			delete converted.schema;
			delete converted.examples;
			if (resp.schema) {
				converted.content = {
					[respType]: {
						schema: rewriteRefs(resp.schema),
						examples: resp.examples,
					},
				};
			}
			responses[code] = converted;
		}
		result.responses = responses;
	}

	return result;
}

/**
 * Swagger 2.0 文档归一化为 OpenAPI 3.x 视图
 */
export function normalizeSwagger2(spec: any): any {
	const paths: Record<string, any> = {};
	for (const [path, pathItem] of Object.entries<any>(spec.paths || {})) {
		if (!isPlainObject(pathItem)) {
			paths[path] = pathItem;
			continue;
		}
		const newPathItem: Record<string, any> = {};
		// path 级公共参数（query/header 等，保留原样并重写 $ref）
		if (pathItem.parameters) {
			newPathItem.parameters = rewriteRefs(pathItem.parameters);
		}
		for (const method of HTTP_METHODS) {
			const op = convertOperation(pathItem[method], spec.consumes || [], spec.produces || []);
			if (op) {
				newPathItem[method] = op;
			}
		}
		// 保留 operation 之外的字段（summary/description/servers 等）
		for (const [key, value] of Object.entries(pathItem)) {
			if (!(key in newPathItem) && !HTTP_METHODS.includes(key)) {
				newPathItem[key] = value;
			}
		}
		paths[path] = newPathItem;
	}

	const result: any = {
		openapi: '3.0.0',
		info: spec.info || { title: 'Untitled', version: '' },
		paths,
	};
	const servers = toServers(spec);
	if (servers.length) {
		result.servers = servers;
	}
	if (spec.tags) {
		result.tags = spec.tags;
	}
	if (spec.security) {
		result.security = spec.security;
	}

	const components: Record<string, any> = {};
	if (spec.definitions) {
		components.schemas = rewriteRefs(spec.definitions);
	}
	const securitySchemes = toSecuritySchemes(spec.securityDefinitions);
	if (securitySchemes) {
		components.securitySchemes = securitySchemes;
	}
	if (Object.keys(components).length) {
		result.components = components;
	}

	return result;
}
