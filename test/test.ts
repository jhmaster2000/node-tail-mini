import assert from 'node:assert/strict';
import { describe, it, beforeEach, afterEach } from 'node:test';
import { access, unlink, writeFile, constants as fsConstants, openSync, writeSync, closeSync, unlinkSync, rename } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Tail } from '../src/tail.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fileToTest = join(__dirname, 'example.txt');

describe('Tail', () => {
    beforeEach((t, done) => {
        writeFile(fileToTest, '', done);
    });

    afterEach((t, done) => {
        access(fileToTest, fsConstants.F_OK, (err) => {
            if (!err) {
                unlink(fileToTest, done);
            } else {
                done();
            }
        });
    });

    const lineEndings = [{ le: '\r\n', desc: "Windows" }, { le: '\n', desc: "Linux" }];
    
    lineEndings.forEach(({ le, desc }) => {
        it(`should read a file with ${desc} line ending`, (t, done) => {
            const text = `This is a ${desc} line ending  ${le}`;
            const nbOfLineToWrite = 100;
            let nbOfReadLines = 0;

            const fd = openSync(fileToTest, 'w+');
            const tailedFile = new Tail(fileToTest, { fsWatchOptions: { interval: 100 } });

            tailedFile.on('line', (line) => {
                assert.strictEqual(line, text.replace(/[\r\n]/g, ''));
                nbOfReadLines++;

                if (nbOfReadLines === nbOfLineToWrite) {
                    tailedFile.unwatch();
                    done();
                }
            });

            for (let index = 0; index < nbOfLineToWrite; index++) {
                writeSync(fd, text);
            }
            closeSync(fd);
        });
    });

    it('should handle null separator option to not split chunks', (t, done) => {
        const text = "This is \xA9test and 22\xB0 C";
        const fd = openSync(fileToTest, 'w+');
        const tailedFile = new Tail(fileToTest, { separator: null, fsWatchOptions: { interval: 100 } });

        tailedFile.on('line', (line) => {
            assert.strictEqual(line, `${text}${text}`);
            tailedFile.unwatch();
            done();
        });

        writeSync(fd, text);
        writeSync(fd, text);
        closeSync(fd);
    });

    it('should respect fromBeginning flag', { timeout: 10000 }, (t, done) => {
        const fd = openSync(fileToTest, 'w+');
        const lines = ['line  0', 'line  1', 'line  2', 'line  3'];
        for (const l of lines) {
            writeSync(fd, l + '\n');
        }
        closeSync(fd);

        const readLines: string[] = [];

        setTimeout(() => {
            const tailedFile = new Tail(fileToTest, { fromBeginning: true });
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
        }, 3000);
    });

    it('should respect fromBeginning from even the first appended line', (t, done) => {
        const fd = openSync(fileToTest, 'w+');
        const lines = ['line0', 'line1'];
        for (const l of lines) {
            writeSync(fd, l + '\n');
        }
        closeSync(fd);

        const readLines: string[] = [];
        const tailedFile = new Tail(fileToTest, { fromBeginning: true, fsWatchOptions: { interval: 100 } });
        
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

    it('should send error event on deletion of file while watching', (t, done) => {
        const fd = openSync(fileToTest, 'w+');
        const tailedFile = new Tail(fileToTest, { fsWatchOptions: { interval: 100 } });

        tailedFile.on('error', () => {
            tailedFile.unwatch();
            done();
        });
        tailedFile.on('line', () => {
            unlinkSync(fileToTest);
        });

        writeSync(fd, "This is a line\n");
        closeSync(fd);
    });

    it('should throw exception if file is missing', () => {
        try {
            new Tail("missingFile.txt", { fsWatchOptions: { interval: 100 } });
            assert.fail('Should have thrown an error');
        } catch (ex: any) {
            assert.strictEqual(ex.code, 'ENOENT');
        }
    });

    it('should deal with file rename', { timeout: 5000 }, (t, done) => {
        const text = "This is a line\n";
        const tailedFile = new Tail(fileToTest, { fsWatchOptions: { interval: 100 } });
        const newName = join(__dirname, 'example2.txt');

        tailedFile.on('line', () => {
            tailedFile.unwatch();
            try { unlinkSync(newName); } catch {}
            done();
        });

        //! This must be async or it will block Tail from detecting it happen and crash
        rename(fileToTest, newName, () => {});

        setTimeout(() => {
            const fdNew = openSync(newName, 'w+');
            writeSync(fdNew, text);
            closeSync(fdNew);
        }, 1500);
    });

    it('should emit lines in the right order', (t, done) => {
        const fd = openSync(fileToTest, 'w+');
        const linesNo = 250000;
        const tailedFile = new Tail(fileToTest, { fromBeginning: true, fsWatchOptions: { interval: 100 } });
        let count = 0;

        tailedFile.on('line', (line: string) => {
            assert.strictEqual(line, count.toString());
            count++;
            if (count === linesNo) {
                tailedFile.unwatch();
                done();
            }
        });

        for (let i = 0; i < linesNo; i++) {
            writeSync(fd, `${i}\n`);
        }
        closeSync(fd);
    });

    it('should not lose data between rename events', { timeout: 10000 }, (t, done) => {
        const fd = openSync(fileToTest, 'w+');
        const newName = join(__dirname, 'example2.txt');

        const tailedFile = new Tail(fileToTest, { fromBeginning: true, fsWatchOptions: { interval: 100 } });
        let readNo = 0;

        tailedFile.on('line', (line: string) => {
            assert.strictEqual(line, readNo.toString());
            readNo++;
            
            if (readNo === 30) {
                closeSync(fd);
                clearInterval(id);
                tailedFile.unwatch();
                try { unlinkSync(newName); } catch {}
                done();
            }
        });

        let writeNo = 0;
        const id = setInterval(() => {
            writeSync(fd, `${writeNo}\n`);
            writeNo++;
        }, 50);

        setTimeout(() => rename(fileToTest, newName, () => {}), 250);
    });

    describe('nLines', () => {
        it('should gracefully handle an empty file', (t, done) => {
            const tailedFile = new Tail(fileToTest, { nLines: 3, flushAtEOF: true, fsWatchOptions: { interval: 100 } });
            tailedFile.unwatch();
            done();
        });

        lineEndings.forEach(({ le, desc }) => {
            it(`should respect nLines when ${desc} line endings ends with a newline`, (t, done) => {
                const fd = openSync(fileToTest, 'w+');
                const tokens = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
                const input = tokens.reduce((acc, n) => `${acc}${n}${le}`, "");
                writeSync(fd, input);

                const n = 3;
                const tailedFile = new Tail(fileToTest, { nLines: n, flushAtEOF: true, fsWatchOptions: { interval: 100 } });
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

            it(`should respect nLines when ${desc} line endings does not end with newline`, (t, done) => {
                const fd = openSync(fileToTest, 'w+');
                const tokens = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
                const input = tokens.reduce((acc, n, i) => {
                    const t = (i === tokens.length - 1) ? n : `${n}${le}`;
                    return `${acc}${t}`;
                }, "");
                writeSync(fd, input);

                const n = 3;
                const tailedFile = new Tail(fileToTest, { nLines: n, flushAtEOF: true, fsWatchOptions: { interval: 100 } });
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

    it('should throw a catchable exception if tailed file disappears', (t, done) => {
        const fd = openSync(fileToTest, 'w+');
        const lines = ['line0', 'line1'];
        for (const l of lines) { writeSync(fd, l + '\n'); }
        closeSync(fd);

        const tailedFile = new Tail(fileToTest, { flushAtEOF: true, fsWatchOptions: { interval: 100 } });
        tailedFile.on('error', (e: any) => {
            assert.strictEqual(e.code, "ENOENT");
            done();
        });

        setTimeout(() => {
            try { unlinkSync(fileToTest); } catch {}
        }, 2000);
    });
});
