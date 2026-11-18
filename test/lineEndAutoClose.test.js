const assert = require('assert');
const { shouldAddLineEnd } = require('../src/lineEndAutoClose');

suite('Line end auto-close', () => {
    test('adds ";" only for a ":" at the start of a line', () => {
        assert.strictEqual(shouldAddLineEnd(':', 0), true);
        assert.strictEqual(shouldAddLineEnd('   :', 3), true);
        assert.strictEqual(shouldAddLineEnd('  12:', 4), true);
        assert.strictEqual(shouldAddLineEnd('  12:   ', 4), true);
    });

    test('does not add ";" inside a statement or before existing text', () => {
        assert.strictEqual(shouldAddLineEnd('   1:  DO[7:', 11), false);
        assert.strictEqual(shouldAddLineEnd('   1:  R[10:', 11), false);
        assert.strictEqual(shouldAddLineEnd('  :DO[1]=ON ;', 2), false);
        assert.strictEqual(shouldAddLineEnd('DO[7:', 4), false);
    });
});
