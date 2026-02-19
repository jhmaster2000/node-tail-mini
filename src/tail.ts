import { EventEmitter } from 'node:events';
import { resolve } from 'node:path';
import fs from 'node:fs';

export interface TailOptions {
    separator?: string | RegExp;
    encoding?: BufferEncoding;
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
    readonly #encoding: BufferEncoding;
    readonly #queue: QueueItem[] = [];
    readonly #watcher?: fs.FSWatcher;
    readonly #internalDispatcher: EventEmitter;
    #buffer: string;
    #currentCursorPos: number = 0;
    #unwatched: boolean = false;

    // Default to native watchers on Windows, macOS and Linux, default to polling on other platforms.
    static #POLLING_PREFERRED = process.platform !== 'win32' && process.platform !== 'darwin' && process.platform !== 'linux';

    constructor(filename: string, options: TailOptions = {}) {
        super();
        this.#filename = resolve(filename);
        this.#separator = options.separator ?? /\r?\n/;
        this.#encoding = options.encoding ?? 'utf-8';
        this.#flushAtEOF = options.flushAtEOF ?? false;
        const nLines = options.nLines ?? -1;

        fs.accessSync(this.#filename, fs.constants.R_OK);

        this.#buffer = '';

        this.#internalDispatcher = new EventEmitter();
        this.#internalDispatcher.on('next', () => this.#readBlock());

        let cursor: number | null = null;

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
                fs.watchFile(this.#filename, { interval }, (curr, prev) => this.#watchFileEvent(curr, prev));
            } else {
                this.#watcher = fs.watch(this.#filename, (event) => this.#watchEvent(event));
            }
        } catch (error) { /* node:coverage ignore next 3 */
            this.unwatch();
            this.emit('error', new Error(`Tail watching for ${this.#filename} failed.`, { cause: error }));
        }
    }

    /** 
     * Grabs the index of the last line of text in the format `/.*(\n)?/`.
     * Returns null if a full line can not be found. */
    #getIndexOfLastLine(text: string): number | null {
        const endSep = text.match(this.#separator)?.at(-1);
        if (!endSep) return null;

        const endSepIndex = text.lastIndexOf(endSep);
        let lastLine: string;

        if (text.endsWith(endSep)) {
            // If the text ends with a separator, look back further to find the next separator to complete the line
            const trimmed = text.substring(0, endSepIndex);
            const startSep = trimmed.match(this.#separator)?.at(-1);

            // If there isn't another separator, the line isn't complete, so return null to get more data
            if (!startSep) return null;
            const startSepIndex = trimmed.lastIndexOf(startSep);

            // Exclude the starting separator, include the ending separator
            lastLine = text.substring(
                startSepIndex + startSep.length,
                endSepIndex + endSep.length
            );
        } else {
            // If the text does not end with a separator, grab everything after the last separator
            lastLine = text.substring(endSepIndex + endSep.length);
        }
        return text.lastIndexOf(lastLine);
    }

    /**
     * Returns the position of the start of the `nLines`th line from the bottom.
     * Returns 0 if `nLines` is greater than the total number of lines in the file. */
    #getPositionAtNthLine(nLines: number): number {
        const { size } = fs.statSync(this.#filename);
        if (size === 0) return 0;

        const fd = fs.openSync(this.#filename, 'r');
        // Start from the end of the file and work backwards in specific chunks
        let currentReadPosition = size;
        const chunkSizeBytes = Math.min(1024, size);
        const lineBytes = [];

        let remaining = '';

        while (lineBytes.length < nLines) {
            // Shift the current read position backward to the amount we're about to read
            currentReadPosition -= chunkSizeBytes;

            // If negative, we've reached the beginning of the file and we should stop and return 0, starting the stream at the beginning.
            if (currentReadPosition < 0) return 0;

            // Read a chunk of the file and prepend it to the working buffer
            const buffer = Buffer.alloc(chunkSizeBytes);
            const bytesRead = fs.readSync(
                fd,
                buffer,
                0, // position in buffer to write to
                chunkSizeBytes, // number of bytes to read
                currentReadPosition // position in file to read from
            );

            const readArray = buffer.subarray(0, bytesRead);
            remaining = readArray.toString(this.#encoding) + remaining;

            let index = this.#getIndexOfLastLine(remaining);

            while (index !== null && lineBytes.length < nLines) {
                const line = remaining.substring(index);

                lineBytes.push(Buffer.byteLength(line));
                remaining = remaining.substring(0, index);

                index = this.#getIndexOfLastLine(remaining);
            }
        }

        fs.closeSync(fd);

        return size - lineBytes.reduce((acc, cur) => acc + cur, 0);
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
            encoding: this.#encoding,
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

    #watchEvent(evtName: 'change' | 'rename') {
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

    #watchFileEvent(curr: fs.Stats, prev: fs.Stats) {
        if (curr.nlink === 0) { // rename event
            this.unwatch();
            this.emit('error', new Error('File not available anymore.', { cause: { code: 'ENOENT', syscall: 'stat', path: this.#filename } }));
            return;
        }
        if (curr.size > prev.size) { // change event
            this.#currentCursorPos = curr.size; // Update this.currentCursorPos so that a consumer can determine if entire file has been handled
            this.#queue.push({ start: prev.size, end: curr.size });
            if (this.#queue.length === 1) this.#internalDispatcher.emit('next');
        }
    }

    public unwatch() {
        if (this.#unwatched) return;

        if (this.#watcher) this.#watcher.close();
        else fs.unwatchFile(this.#filename);
        this.#queue.length = 0;
        this.#unwatched = true;
    }
}
