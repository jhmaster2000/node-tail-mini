import { EventEmitter } from 'node:events';
import { resolve } from 'node:path';
import fs from 'node:fs';

export interface TailOptions {
    separator?: string | RegExp;
    flushAtEOF?: boolean;
    /** Set to override the platform default choice between native and polling methods. */
    polling?: boolean;
    /** Polling interval in milliseconds. Ignored if not using polling method. */
    pollingInterval?: number;
    /**
     * Number of existing lines to readback on tail start.
     * 
     * Set to `-1` to read from the beginning of the file (default).
     * 
     * Set to `0` for no readback. */
    nLines?: number;
}

interface QueueItem {
    readonly start: number;
    readonly end: number;
}

export class Tail extends EventEmitter {
    readonly #filename: string;
    readonly #separator: string | RegExp;
    readonly #flushAtEOF: boolean;
    readonly #queue: QueueItem[] = [];
    readonly #watcher?: fs.FSWatcher;
    readonly #internalDispatcher = new EventEmitter();
    #buffer: string = '';
    #currentCursorPos: number = 0;
    #unwatched: boolean = false;

    // Default to native watchers on Windows, macOS and Linux, default to polling on other platforms.
    static #POLLING_PREFERRED = process.platform !== 'win32' && process.platform !== 'darwin' && process.platform !== 'linux';

    constructor(filename: string, options: TailOptions = {}) {
        super();
        this.#filename = resolve(filename);
        fs.accessSync(this.#filename, fs.constants.R_OK);

        this.#separator = options.separator ?? /\r?\n/;
        this.#flushAtEOF = options.flushAtEOF ?? false;

        this.#internalDispatcher.on('next', () => this.#readBlock());

        let cursor: number | null = null;
        const nLines = options.nLines ?? -1;

        if (nLines < 0) cursor = 0; // read from beginning of file
        else if (nLines === 0) cursor = this.#getCurrentFilePos(); // read from current position (no readback)
        else cursor = this.#getPositionAtNthLine(nLines); // readback from specific line

        if (cursor === null) throw new Error(`Tail failed to initialize for ${this.#filename}`);
        this.#currentCursorPos = cursor;

        // force an initial file flush if backreading.
        if (nLines !== 0) this.#change();

        try {
            const useWatchFile = options.polling ?? Tail.#POLLING_PREFERRED;
            // Start watching
            if (useWatchFile) {
                const interval = options.pollingInterval ?? 1000;
                fs.watchFile(this.#filename, { interval }, (curr, prev) => this.#onWatchFileEvent(curr, prev));
            } else {
                this.#watcher = fs.watch(this.#filename, (event) => this.#onWatchEvent(event));
            }
        } catch (error) { /* node:coverage ignore next 3 */
            this.unwatch();
            this.emit('error', new Error(`Tail watching for ${this.#filename} failed.`, { cause: error }));
        }
    }

    /**
     * Returns the position of the start of the `nLines`th line from the bottom.
     * Returns 0 if `nLines` is greater than the total number of lines in the file. */
    #getPositionAtNthLine(nLines: number): number {
        const { size } = fs.statSync(this.#filename);
        if (size === 0) return 0;

        const fd = fs.openSync(this.#filename, 'r');
        // Start from the end of the file and work backwards in specific chunks
        let linesFound = 0;
        let currentReadPosition = size;
        const chunkSizeBytes = Math.min(1024, size);
        const buffer = Buffer.alloc(chunkSizeBytes);
        
        try {
            // Check if the file ends with a newline. 
            // If it DOES NOT, the text after the last newline counts as the first line.
            const lastByte = Buffer.alloc(1);
            fs.readSync(fd, lastByte, 0, 1, size - 1);
            if (lastByte[0] !== 0x0A) linesFound = 1;

            while (currentReadPosition > 0) {
                const readSize = Math.min(chunkSizeBytes, currentReadPosition);
                currentReadPosition -= readSize;

                fs.readSync(fd, buffer, 0, readSize, currentReadPosition);

                // Search backward through the chunk
                for (let i = readSize - 1; i >= 0; i--) {
                    if (buffer[i] === 0x0A) { // '\n'
                        // If we've already found the requested number of lines, this newline marks the boundary.
                        if (linesFound === nLines) return currentReadPosition + i + 1;
                        linesFound++;
                    }
                }
            }
            // If we exhausted the file before finding nLines, start from the beginning.
            return 0;
        } finally {
            fs.closeSync(fd);
        }
    }

    #getCurrentFilePos() {
        try {
            return fs.statSync(this.#filename).size;
        } catch (error) { /* node:coverage ignore next 4 */
            this.unwatch();
            this.emit('error', new Error('File not available anymore.', { cause: error }));
            return null;
        }
    }

    #readBlock() {
        if (this.#queue.length === 0) return;

        const block = this.#queue[0];
        if (block.end <= block.start) return;

        const stream = fs.createReadStream(this.#filename, {
            start: block.start,
            end: block.end - 1,
            encoding: 'utf8',
        });
        stream.on('error', (error) => this.emit('error', new Error('ReadStream error', { cause: error })));
        stream.on('end', () => {
            this.#queue.shift();
            if (this.#queue.length > 0) this.#internalDispatcher.emit('next');

            if (this.#flushAtEOF && this.#buffer.length > 0) {
                this.emit('line', this.#buffer);
                this.#buffer = '';
            }
        });
        stream.on('data', (d) => {
            this.#buffer += d;
            const parts = this.#buffer.split(this.#separator);
            this.#buffer = parts.pop() ?? '';
            for (const chunk of parts) this.emit('line', chunk);
        });

    }

    #change() {
        const pos = this.#getCurrentFilePos();
        if (!pos) return;

        if (pos < this.#currentCursorPos) { /* node:coverage ignore next 2 */
            // scenario where text is not appended but it's actually a w+
            this.#currentCursorPos = pos;
        } else if (pos > this.#currentCursorPos) {
            this.#queue.push({ start: this.#currentCursorPos, end: pos });
            this.#currentCursorPos = pos;
            if (this.#queue.length === 1) this.#internalDispatcher.emit('next');
        }
    }

    #onWatchEvent(evtName: 'change' | 'rename') {
        if (evtName === 'change') return this.#change();
        if (evtName === 'rename') {
            try {
                fs.accessSync(this.#filename, fs.constants.R_OK);
            } catch (error) {
                this.unwatch();
                this.emit('error', new Error('File not available anymore.', { cause: error }));
            }
        }
    }

    #onWatchFileEvent(curr: fs.Stats, prev: fs.Stats) {
        if (curr.nlink === 0) { // rename event
            this.unwatch();
            this.emit('error', new Error('File not available anymore.', { cause: { code: 'ENOENT', syscall: 'stat', path: this.#filename } }));
            return;
        }
        if (curr.size > prev.size) { // change event
            this.#queue.push({ start: prev.size, end: curr.size });
            this.#currentCursorPos = curr.size; // Update this.currentCursorPos so that a consumer can determine if entire file has been handled
            if (this.#queue.length === 1) this.#internalDispatcher.emit('next');
        }
    }

    public unwatch() {
        if (this.#unwatched) return;
        if (this.#watcher) this.#watcher.close();
        else fs.unwatchFile(this.#filename);

        this.#internalDispatcher.removeAllListeners();
        this.#buffer = '';
        this.#queue.length = 0;
        this.#unwatched = true;
    }
}
