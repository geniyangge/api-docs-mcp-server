import { describe, expect, it } from 'vitest';
import { normalizeSwagger2 } from '../src/utils/normalize-swagger2';

describe('normalizeSwagger2', () => {
	it('body 参数转换为 requestBody', () => {
		const spec = {
			swagger: '2.0',
			info: { title: 'Test', version: '1.0.0' },
			paths: {
				'/users': {
					post: {
						parameters: [{ in: 'body', name: 'body', required: true, schema: { $ref: '#/definitions/User' } }],
					},
				},
			},
			definitions: { User: { type: 'object', properties: { id: { type: 'integer' } } } },
		};
		const result = normalizeSwagger2(spec);
		expect(result.openapi).toBe('3.0.0');
		expect(result.paths['/users'].post.requestBody.required).toBe(true);
		expect(result.paths['/users'].post.requestBody.content['application/json'].schema).toEqual({
			$ref: '#/components/schemas/User',
		});
	});

	it('formData 参数转换为 form-urlencoded requestBody', () => {
		const spec = {
			swagger: '2.0',
			info: { title: 'Test', version: '1.0.0' },
			paths: {
				'/upload': {
					post: {
						parameters: [
							{ in: 'formData', name: 'file', type: 'file', required: true },
							{ in: 'formData', name: 'note', type: 'string' },
						],
					},
				},
			},
		};
		const result = normalizeSwagger2(spec);
		const rb = result.paths['/upload'].post.requestBody;
		expect(rb.content['application/x-www-form-urlencoded'].schema.type).toBe('object');
		expect(rb.content['application/x-www-form-urlencoded'].schema.required).toEqual(['file']);
		expect(result.paths['/upload'].post.parameters).toBeUndefined();
	});

	it('definitions $ref 重写为 components/schemas', () => {
		const spec = {
			swagger: '2.0',
			info: { title: 'Test', version: '1.0.0' },
			paths: {
				'/users/{id}': {
					get: {
						responses: {
							200: {
								description: 'ok',
								schema: { $ref: '#/definitions/User' },
							},
						},
					},
				},
			},
			definitions: { User: { type: 'object' } },
		};
		const result = normalizeSwagger2(spec);
		expect(result.paths['/users/{id}'].get.responses['200'].content['application/json'].schema).toEqual(
			{ $ref: '#/components/schemas/User' }
		);
		expect(result.components.schemas.User).toEqual({ type: 'object' });
	});

	it('host/basePath/schemes 转换为 servers', () => {
		const spec = {
			swagger: '2.0',
			info: { title: 'Test', version: '1.0.0' },
			host: 'api.example.com',
			basePath: '/v1',
			schemes: ['https', 'http'],
			paths: {},
		};
		const result = normalizeSwagger2(spec);
		expect(result.servers).toEqual([
			{ url: 'https://api.example.com/v1' },
			{ url: 'http://api.example.com/v1' },
		]);
	});

	it('securityDefinitions 转换为 securitySchemes', () => {
		const spec = {
			swagger: '2.0',
			info: { title: 'Test', version: '1.0.0' },
			securityDefinitions: {
				basic: { type: 'basic' },
				key: { type: 'apiKey', name: 'X-Key', in: 'header' },
				oauth: {
					type: 'oauth2',
					flow: 'accessCode',
					authorizationUrl: 'https://auth.example.com',
					tokenUrl: 'https://auth.example.com/token',
					scopes: { read: 'read access' },
				},
			},
			paths: {},
		};
		const result = normalizeSwagger2(spec);
		expect(result.components.securitySchemes.basic).toEqual({ type: 'http', scheme: 'basic' });
		expect(result.components.securitySchemes.key).toEqual({
			type: 'apiKey',
			name: 'X-Key',
			in: 'header',
		});
		expect(result.components.securitySchemes.oauth.flows.authorizationCode.tokenUrl).toBe(
			'https://auth.example.com/token'
		);
	});

	it('不修改入参', () => {
		const spec = {
			swagger: '2.0',
			info: { title: 'Test', version: '1.0.0' },
			paths: {
				'/a': {
					get: { responses: { 200: { description: 'ok' } } },
				},
			},
		};
		const before = JSON.stringify(spec);
		normalizeSwagger2(spec);
		expect(JSON.stringify(spec)).toBe(before);
	});
});
