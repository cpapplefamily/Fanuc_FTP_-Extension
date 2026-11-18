const assert = require('assert');
const http = require('http');
const {
    comSetTarget,
    planDescriptionPush,
    comSetUrl,
    comSetError,
    sendComment
} = require('../src/pushDescriptions');

suite('Push Descriptions Test Suite', () => {
    test('maps description keys to ComSet function codes', () => {
        assert.deepStrictEqual(comSetTarget('DI[2]'), { type: 'DI', index: 2, code: 8 });
        assert.strictEqual(comSetTarget('DO[1]').code, 9);
        assert.strictEqual(comSetTarget('R[5]').code, 1);
        assert.strictEqual(comSetTarget('PR[5]').code, 3);
        assert.strictEqual(comSetTarget('SR[5]').code, 14);
        assert.strictEqual(comSetTarget('F[5]').code, 19);
        assert.strictEqual(comSetTarget('UI[1]'), undefined);
        assert.strictEqual(comSetTarget('UO[1]'), undefined);
    });

    test('plans only changed or new rows, and lists UI/UO separately', () => {
        const local = new Map([['DI[1]', 'Air'], ['DI[2]', 'Test Update'], ['R[1]', 'Count'], ['UI[1]', 'IMSTP']]);
        const robot = new Map([['DI[1]', 'Air'], ['DI[2]', 'Spare'], ['DO[9]', 'Robot only']]);
        const plan = planDescriptionPush(local, robot);
        assert.deepStrictEqual(plan.send.map(item => [item.key, item.current, item.text, item.code, item.index]), [
            ['DI[2]', 'Spare', 'Test Update', 8, 2],
            ['R[1]', undefined, 'Count', 1, 1]
        ]);
        assert.deepStrictEqual(plan.unsupported, ['UI[1]']);
        assert.strictEqual(plan.unchanged, 1);
    });

    test('builds the ComSet URL with an encoded comment and optional port', () => {
        const item = { text: 'Part #1 & 2', index: 2, code: 8 };
        assert.strictEqual(comSetUrl('10.0.0.1', 80, item), 'http://10.0.0.1/karel/ComSet?sComment=Part%20%231%20%26%202&sIndx=2&sFc=8');
        assert.strictEqual(comSetUrl('127.0.0.1', 9000, item).startsWith('http://127.0.0.1:9000/karel/'), true);
    });

    test('treats the robot "krlerr" page and 401/403 as errors', () => {
        assert.strictEqual(comSetError(200, '<html><body bgcolor=#FFF9e3></body></html>'), undefined);
        assert.match(comSetError(200, '<HTML><TITLE>krlerr6</TITLE><P>ERROR: Protected feature, cannot issue from here!!</HTML>'), /Protected feature.*unlock KAREL/);
        assert.match(comSetError(403, ''), /HTTP 403.*Host Comm/);
        assert.match(comSetError(500, ''), /HTTP 500/);
    });

    test('sends a comment to a web server and reports the answer', async () => {
        let requested;
        const server = http.createServer((request, response) => {
            requested = request.url;
            response.end(request.url.includes('sIndx=3') ? '<title>krlerr6</title>Protected feature' : '<html></html>');
        });
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        const { port } = server.address();
        try {
            assert.strictEqual(await sendComment('127.0.0.1', port, { text: 'Test Update', index: 2, code: 8 }), undefined);
            assert.strictEqual(requested, '/karel/ComSet?sComment=Test%20Update&sIndx=2&sFc=8');
            assert.match(await sendComment('127.0.0.1', port, { text: 'x', index: 3, code: 8 }), /Protected feature/);
        } finally {
            server.close();
        }
    });
});
