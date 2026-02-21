import assert from 'node:assert/strict';
import { describe, it, beforeEach, afterEach } from 'node:test';
import { access, unlink, constants as fsConstants, openSync, writeSync, closeSync, unlinkSync, rename, writeFileSync, appendFileSync, truncateSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Tail, TailOptions } from '../src/tail.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_FILE = join(__dirname, 'example.txt');

const lineEndings = [{ le: '\r\n', desc: 'CRLF' }, { le: '\n', desc: 'LF' }];

for (const impl of ['watch', 'watchFile']) describe(`Tail (${impl})`, () => {
    const TEST_DEFAULT_TAIL_OPTS: TailOptions = {};
    if (impl === 'watch') TEST_DEFAULT_TAIL_OPTS.polling = false;
    if (impl === 'watchFile') {
        TEST_DEFAULT_TAIL_OPTS.polling = true;
        TEST_DEFAULT_TAIL_OPTS.pollingInterval = 100;
    }

    beforeEach(() => {
        writeFileSync(TEST_FILE, '');
    });
    afterEach((t, done) => {
        access(TEST_FILE, fsConstants.F_OK, (err) => {
            if (!err) unlink(TEST_FILE, done);
            else done();
        });
    });

    lineEndings.forEach(({ le, desc }) => {
        it(`should read a file with ${desc} line ending`, { timeout: 5000 }, (t, done) => {
            const text = `This is a ${desc} line ending  ${le}`;
            const nbOfLineToWrite = 100;
            let nbOfReadLines = 0;

            const fd = openSync(TEST_FILE, 'w+');
            const tailedFile = new Tail(TEST_FILE, { ...TEST_DEFAULT_TAIL_OPTS });

            tailedFile.on('line', (line) => {
                assert.strictEqual(line, text.replace(/[\r\n]/g, ''));
                nbOfReadLines++;

                if (nbOfReadLines === nbOfLineToWrite) {
                    tailedFile.unwatch();
                    done();
                }
            });

            setTimeout(() => {
                for (let index = 0; index < nbOfLineToWrite; index++) writeSync(fd, text);
                closeSync(fd);
            }, 50);
        });
    });

    it('should respect fromBeginning flag', { timeout: 5000 }, (t, done) => {
        const fd = openSync(TEST_FILE, 'w+');
        const lines = ['line  0', 'line  1', 'line  2', 'line  3'];
        for (const l of lines) writeSync(fd, l + '\n');
        closeSync(fd);

        const readLines: string[] = [];

        const tailedFile = new Tail(TEST_FILE, { ...TEST_DEFAULT_TAIL_OPTS, nLines: -1 });
        tailedFile.on('line', (line: string) => {
            readLines.push(line);
            if (readLines.length === lines.length) {
                const match = readLines.every((val, idx) => val === lines[idx]);
                if (match) {
                    tailedFile.unwatch();
                    done();
                }
            }
        });
    });

    it('should respect fromBeginning from even the first appended line', { timeout: 5000 }, (t, done) => {
        const fd = openSync(TEST_FILE, 'w+');
        const lines = ['line0', 'line1'];
        for (const l of lines) writeSync(fd, l + '\n');
        closeSync(fd);

        const readLines: string[] = [];
        const tailedFile = new Tail(TEST_FILE, { ...TEST_DEFAULT_TAIL_OPTS, nLines: -1 });

        tailedFile.on('line', (line) => {
            readLines.push(line);
            if (readLines.length === lines.length) {
                const match = readLines.every((val, idx) => val === lines[idx]);
                if (match) {
                    tailedFile.unwatch();
                    done();
                }
            }
        });
    });

    it('should throw exception if file is missing', { timeout: 5000 }, () => {
        try {
            new Tail('missingFile.txt', { ...TEST_DEFAULT_TAIL_OPTS });
            assert.fail('Should have thrown an error');
        } catch (error: any) {
            assert.strictEqual(error.code, 'ENOENT');
        }
    });

    it('should throw exception if file is directory', { timeout: 5000 }, () => {
        try {
            new Tail(__dirname, { ...TEST_DEFAULT_TAIL_OPTS });
            assert.fail('Should have thrown an error');
        } catch (error: any) {
            assert.strictEqual(error.message.split(':')[0], 'Cannot Tail a folder');
        }
    });

    it('should send error event on deletion of watched file', { timeout: 5000 }, (t, done) => {
        const fd = openSync(TEST_FILE, 'w+');
        const tailedFile = new Tail(TEST_FILE, { ...TEST_DEFAULT_TAIL_OPTS });

        tailedFile.on('error', (error) => {
            assert.strictEqual(error.cause.code, 'ENOENT');
            done();
        });
        tailedFile.on('line', () => unlinkSync(TEST_FILE));

        setTimeout(() => {
            writeSync(fd, 'This is a line\n');
            closeSync(fd);
        }, 50);
    });

    it('should send error event on rename of watched file', { timeout: 5000 }, (t, done) => {
        const text = 'This is a line\n';
        const tailedFile = new Tail(TEST_FILE, { ...TEST_DEFAULT_TAIL_OPTS });
        const newName = join(__dirname, 'example2.txt');

        tailedFile.on('error', (error) => {
            tailedFile.unwatch();
            unlinkSync(newName);
            assert.strictEqual(error.cause.code, 'ENOENT');
            done();
        });
        tailedFile.on('line', () => assert.fail('should not fire line event'));

        // This must be async or it will block Tail from detecting it happen and crash
        setTimeout(() => rename(TEST_FILE, newName, () => { }), 150);
        setTimeout(() => {
            const fdNew = openSync(newName, 'w+');
            writeSync(fdNew, text);
            closeSync(fdNew);
        }, 200);
    });

    it('should emit lines in the right order', { timeout: 5000 }, (t, done) => {
        const fd = openSync(TEST_FILE, 'w+');
        const linesNo = 50_000;
        const tailedFile = new Tail(TEST_FILE, { ...TEST_DEFAULT_TAIL_OPTS, nLines: -1 });
        let count = 0;

        tailedFile.on('line', (line: string) => {
            assert.strictEqual(line, count.toString());
            count++;
            if (count === linesNo) {
                tailedFile.unwatch();
                done();
            }
        });

        setTimeout(() => {
            for (let i = 0; i < linesNo; i++) writeSync(fd, `${i}\n`);
            closeSync(fd);
        });
    });

    it('should handle truncation correctly', { timeout: 5000 }, (t, done) => {
        writeFileSync(TEST_FILE, 'totally long string of data\r\n'); // Initial data
        const tailedFile = new Tail(TEST_FILE, { ...TEST_DEFAULT_TAIL_OPTS, nLines: 0 });

        tailedFile.on('line', (line) => {
            assert.strictEqual(line, 'totally newer content'); // by design, previous data will print again after a truncation
            tailedFile.unwatch();
            done();
        });

        setTimeout(() => { // Partially truncate to something shorter
            truncateSync(TEST_FILE, 8);
            appendFileSync(TEST_FILE, 'newer content\r\n');
        }, 50);
    });

    it('should handle overwrite correctly', { timeout: 5000 }, (t, done) => {
        writeFileSync(TEST_FILE, 'long string of data\r\n'); // Initial data
        const tailedFile = new Tail(TEST_FILE, { ...TEST_DEFAULT_TAIL_OPTS, nLines: 0 });

        tailedFile.on('line', (line) => {
            assert.strictEqual(line, 'short');
            tailedFile.unwatch();
            done();
        });
        // Partially truncate to something shorter
        setTimeout(() => writeFileSync(TEST_FILE, 'short\r\n'));
    });

    it('should handle incomplete line writes (flush: true) correctly', { timeout: 5000 }, (t, done) => {
        const tailedFile = new Tail(TEST_FILE, { ...TEST_DEFAULT_TAIL_OPTS, flushIncomplete: true });
        let lineNo = 0;
        tailedFile.on('line', (line) => {
            lineNo++;
            if (lineNo === 1) return assert.strictEqual(line, 'begin line');
            if (lineNo === 2) return assert.strictEqual(line, '-end line');
            assert.strictEqual(lineNo, 3);
            assert.strictEqual(line, 'normal line');
            tailedFile.unwatch();
            done();
        });
        setTimeout(() => appendFileSync(TEST_FILE, 'begin line'), 50);
        setTimeout(() => appendFileSync(TEST_FILE, '-end line\n'), 250);
        setTimeout(() => appendFileSync(TEST_FILE, 'normal line\n'), 450);
    });
    it('should handle incomplete line writes (flush: false) correctly', { timeout: 5000 }, (t, done) => {
        const tailedFile = new Tail(TEST_FILE, { ...TEST_DEFAULT_TAIL_OPTS, flushIncomplete: false });
        let lineNo = 0;
        tailedFile.on('line', (line) => {
            lineNo++;
            if (lineNo === 1) return assert.strictEqual(line, 'begin line-end line');
            assert.strictEqual(lineNo, 2);
            assert.strictEqual(line, 'normal line');
            tailedFile.unwatch();
            done();
        });
        setTimeout(() => appendFileSync(TEST_FILE, 'begin line'), 50);
        setTimeout(() => appendFileSync(TEST_FILE, '-end line\n'), 250);
        setTimeout(() => appendFileSync(TEST_FILE, 'normal line\n'), 450);
    });

    it('should correctly handle multi-byte UTF-8 characters', { timeout: 5000 }, (t, done) => {
        const fd = openSync(TEST_FILE, 'w+');
        const tailedFile = new Tail(TEST_FILE, { ...TEST_DEFAULT_TAIL_OPTS, flushIncomplete: false }); // this will never be able to work in flushIncomplete: true mode

        // The Fire Emoji (🔥) is 4 bytes: [0xF0, 0x9F, 0x94, 0xA5]
        const part1 = Buffer.concat([Buffer.from('Emoji: '), Buffer.from([0xf0, 0x9f])]);
        const part2 = Buffer.concat([Buffer.from([0x94, 0xa5]), Buffer.from('!\n')]);

        tailedFile.on('line', (line) => {
            assert.strictEqual(line, 'Emoji: 🔥!');
            tailedFile.unwatch();
            closeSync(fd);
            done();
        });
        // Step 1: Write the first half of the emoji
        setTimeout(() => {
            writeSync(fd, part1);
            // Step 2: Write the second half and the newline to trigger the 'line' event
            setTimeout(() => writeSync(fd, part2), 50);
        }, 50);
    });

    describe('nLines', () => {
        it('should gracefully handle an empty file', { timeout: 5000 }, (t, done) => {
            const tailedFile = new Tail(TEST_FILE, { ...TEST_DEFAULT_TAIL_OPTS, nLines: 3, flushIncomplete: true });
            tailedFile.unwatch();
            done();
        });

        lineEndings.forEach(({ le, desc }) => {
            it(`should respect nLines when ${desc} line endings ends with a newline`, { timeout: 5000 }, (t, done) => {
                const fd = openSync(TEST_FILE, 'w+');
                const tokens = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
                const input = tokens.join(le) + le;
                writeSync(fd, input);

                const n = 3;
                const tailedFile = new Tail(TEST_FILE, { ...TEST_DEFAULT_TAIL_OPTS, nLines: n, flushIncomplete: true });
                let counter = 1;
                const toBePrinted = tokens.slice(tokens.length - n);

                tailedFile.on('line', (line: string) => {
                    assert.strictEqual(parseInt(line), toBePrinted[counter - 1]);
                    if (counter === toBePrinted.length) {
                        closeSync(fd);
                        tailedFile.unwatch();
                        done();
                    }
                    counter++;
                });
            });

            it(`should respect nLines when ${desc} line endings does not end with newline`, { timeout: 5000 }, (t, done) => {
                const fd = openSync(TEST_FILE, 'w+');
                const tokens = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
                const input = tokens.join(le);
                writeSync(fd, input);

                const n = 3;
                const tailedFile = new Tail(TEST_FILE, { ...TEST_DEFAULT_TAIL_OPTS, nLines: n, flushIncomplete: true });
                const toBePrinted = tokens.slice(tokens.length - n);
                let counter = 1;

                tailedFile.on('line', (line: string) => {
                    assert.strictEqual(parseInt(line), toBePrinted[counter - 1]);
                    if (counter === toBePrinted.length) {
                        closeSync(fd);
                        tailedFile.unwatch();
                        done();
                    }
                    counter++;
                });
            });
        });
    });
});
