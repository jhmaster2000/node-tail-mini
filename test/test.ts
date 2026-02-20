import assert from 'node:assert/strict';
import { describe, it, beforeEach, afterEach } from 'node:test';
import { access, unlink, constants as fsConstants, openSync, writeSync, closeSync, unlinkSync, rename, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Tail, TailOptions } from '../src/tail.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fileToTest = join(__dirname, 'example.txt');

for (const impl of ['watch', 'watchFile']) describe(`Tail (${impl})`, () => {
    const TEST_DEFAULT_TAIL_OPTS: TailOptions = {};
    if (impl === 'watch') TEST_DEFAULT_TAIL_OPTS.polling = false;
    if (impl === 'watchFile') {
        TEST_DEFAULT_TAIL_OPTS.polling = true;
        TEST_DEFAULT_TAIL_OPTS.pollingInterval = 100;
    }

    beforeEach(() => {
        writeFileSync(fileToTest, '');
    });
    afterEach((t, done) => {
        access(fileToTest, fsConstants.F_OK, (err) => {
            if (!err) unlink(fileToTest, done);
            else done();
        });
    });

    const lineEndings = [{ le: '\r\n', desc: 'Windows' }, { le: '\n', desc: 'Linux' }];

    lineEndings.forEach(({ le, desc }) => {
        it(`should read a file with ${desc} line ending`, { timeout: 5000 }, (t, done) => {
            const text = `This is a ${desc} line ending  ${le}`;
            const nbOfLineToWrite = 100;
            let nbOfReadLines = 0;

            const fd = openSync(fileToTest, 'w+');
            const tailedFile = new Tail(fileToTest, { ...TEST_DEFAULT_TAIL_OPTS });

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
        const fd = openSync(fileToTest, 'w+');
        const lines = ['line  0', 'line  1', 'line  2', 'line  3'];
        for (const l of lines) writeSync(fd, l + '\n');
        closeSync(fd);

        const readLines: string[] = [];

        const tailedFile = new Tail(fileToTest, { ...TEST_DEFAULT_TAIL_OPTS, nLines: -1 });
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
        const fd = openSync(fileToTest, 'w+');
        const lines = ['line0', 'line1'];
        for (const l of lines) writeSync(fd, l + '\n');
        closeSync(fd);

        const readLines: string[] = [];
        const tailedFile = new Tail(fileToTest, { ...TEST_DEFAULT_TAIL_OPTS, nLines: -1 });

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

    it('should send error event on deletion of watched file', { timeout: 5000 }, (t, done) => {
        const fd = openSync(fileToTest, 'w+');
        const tailedFile = new Tail(fileToTest, { ...TEST_DEFAULT_TAIL_OPTS });

        tailedFile.on('error', (error) => {
            assert.strictEqual(error.cause.code, 'ENOENT');
            done();
        });
        tailedFile.on('line', () => unlinkSync(fileToTest));

        setTimeout(() => {
            writeSync(fd, 'This is a line\n');
            closeSync(fd);
        }, 50);
    });

    it('should send error event on rename of watched file', { timeout: 5000 }, (t, done) => {
        const text = 'This is a line\n';
        const tailedFile = new Tail(fileToTest, { ...TEST_DEFAULT_TAIL_OPTS });
        const newName = join(__dirname, 'example2.txt');

        tailedFile.on('error', (error) => {
            tailedFile.unwatch();
            unlinkSync(newName);
            assert.strictEqual(error.cause.code, 'ENOENT');
            done();
        });
        tailedFile.on('line', () => assert.fail('should not fire line event'));

        // This must be async or it will block Tail from detecting it happen and crash
        setTimeout(() => rename(fileToTest, newName, () => {}), 150);
        setTimeout(() => {
            const fdNew = openSync(newName, 'w+');
            writeSync(fdNew, text);
            closeSync(fdNew);
        }, 200);
    });

    it('should emit lines in the right order', { timeout: 5000 }, (t, done) => {
        const fd = openSync(fileToTest, 'w+');
        const linesNo = 50_000;
        const tailedFile = new Tail(fileToTest, { ...TEST_DEFAULT_TAIL_OPTS, nLines: -1 });
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

    describe('nLines', () => {
        it('should gracefully handle an empty file', { timeout: 5000 }, (t, done) => {
            const tailedFile = new Tail(fileToTest, { ...TEST_DEFAULT_TAIL_OPTS, nLines: 3, flushAtEOF: true });
            tailedFile.unwatch();
            done();
        });

        lineEndings.forEach(({ le, desc }) => {
            it(`should respect nLines when ${desc} line endings ends with a newline`, { timeout: 5000 }, (t, done) => {
                const fd = openSync(fileToTest, 'w+');
                const tokens = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
                const input = tokens.join(le) + le;
                writeSync(fd, input);

                const n = 3;
                const tailedFile = new Tail(fileToTest, { ...TEST_DEFAULT_TAIL_OPTS, nLines: n, flushAtEOF: true });
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
                const fd = openSync(fileToTest, 'w+');
                const tokens = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
                const input = tokens.join(le);
                writeSync(fd, input);

                const n = 3;
                const tailedFile = new Tail(fileToTest, { ...TEST_DEFAULT_TAIL_OPTS, nLines: n, flushAtEOF: true });
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
