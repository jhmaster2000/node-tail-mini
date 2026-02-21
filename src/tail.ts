import { EventEmitter } from 'node:events';
import { resolve } from 'node:path';
import fs from 'node:fs';

export interface TailOptions {
    /**
     * Whether an incomplete line (without a newline) at the end of a write should emit a "line" event.
     * 
     * When `true`, the incomplete line is flushed across multiple "line" events immediately for each chunk written to the file.
     * 
     * When `false`, the incomplete line is cached and only flushed in full once a follow-up write completes it, as a single "line" event.
     * @default false */
    flushIncomplete?: boolean;
    /** Set to override the platform default choice between native and polling methods. */
    polling?: boolean;
    /**
     * Polling interval in milliseconds. Ignored if not using polling method.
     * @default 1000 */
    pollingInterval?: number;
    /**
     * Number of existing lines to readback on tail start.
     * 
     * Set to `-1` to read from the beginning of the file (default).
     * 
     * Set to `0` for no readback.
     * @default -1 */
    nLines?: number;
}

interface QueueItem {
    readonly start: number;
    readonly end: number;
}

export class Tail extends EventEmitter {
    readonly #fd: number;
    readonly #filename: string;
    readonly #flushIncomplete: boolean;
    readonly #queue: QueueItem[] = [];
    readonly #internalDispatcher = new EventEmitter();
    readonly #watcher?: fs.FSWatcher;
    #buffer: Buffer = Buffer.alloc(0);
    #currentCursorPos: number = 0;
    #unwatched: boolean = false;

    // Default to native watchers on Windows, macOS and Linux, default to polling on other platforms.
    static #POLLING_PREFERRED = process.platform !== 'win32' && process.platform !== 'darwin' && process.platform !== 'linux';

    constructor(filename: string, options: TailOptions = {}) {
        super();
        this.#filename = resolve(filename);
        this.#fd = fs.openSync(this.#filename, 'r');

        if (fs.fstatSync(this.#fd).isDirectory()) {
            fs.closeSync(this.#fd);
            throw new Error(`Cannot Tail a folder: ${this.#filename}`);
        }

        this.#flushIncomplete = options.flushIncomplete ?? false;

        this.#internalDispatcher.on('next', () => this.#readBlock());

        let cursor: number | undefined;
        const nLines = options.nLines ?? -1;

        if (nLines < 0) cursor = 0; // read from beginning of file
        else if (nLines === 0) cursor = this.#getCurrentFilePos(); // read from current position (no readback)
        else cursor = this.#getInitialPositionAtNthLine(nLines); // readback from specific line

        if (cursor === undefined) { /* node:coverage ignore next 3 */
            fs.closeSync(this.#fd);
            throw new Error(`Tail failed to initialize for ${this.#filename}`);
        }
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

    /** Returns `undefined` on error. */
    #getCurrentFilePos() {
        try {
            return fs.fstatSync(this.#fd).size;
        } catch (error) { /* node:coverage ignore next 2 */
            this.#lostFile(error);
        }
    }

    /**
     * Returns the file position at the start of the `nLines`-th line from the bottom.
     * Returns 0 if `nLines` is greater than the total number of lines in the file. */
    #getInitialPositionAtNthLine(nLines: number): number {
        const { size } = fs.fstatSync(this.#fd);
        if (size === 0) return 0;

        const chunkSizeBytes = Math.min(1024, size);
        const buffer = Buffer.alloc(chunkSizeBytes);

        // Check if the file ends with a newline. 
        // If it DOES NOT, the text after the last newline counts as the first line.
        const lastByte = Buffer.allocUnsafe(1);
        fs.readSync(this.#fd, lastByte, 0, 1, size - 1);
        let linesFound = lastByte[0] === 0x0A ? 0 : 1;
        let currentReadPosition = size;
        
        // Start from the end of the file and work backwards in chunks
        while (currentReadPosition > 0) {
            const readSize = Math.min(chunkSizeBytes, currentReadPosition);
            currentReadPosition -= readSize;

            fs.readSync(this.#fd, buffer, 0, readSize, currentReadPosition);

            // Search backward through the chunk
            for (let i = readSize - 1; i >= 0; i--) {
                if (buffer[i] === 0x0A) { // '\n'
                    // If we've already found the requested number of lines, this newline marks the boundary.
                    if (linesFound === nLines) return currentReadPosition + i + 1;
                    linesFound++;
                }
            }
        }
        return 0; // If we exhausted the file before finding nLines, start from the beginning.

    }

    #readBlock() {
        if (this.#queue.length === 0) return;

        const block = this.#queue[0];
        if (block.end <= block.start) return;

        const stream = fs.createReadStream('', {
            start: block.start,
            end: block.end - 1,
            fd: this.#fd,
            autoClose: false,
        });
        stream.on('data', (d) => {
            const chunk = d as Buffer;
            this.#buffer = this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk]);

            let pos = 0;
            while (true) {
                const LF = this.#buffer.indexOf(0x0A, pos); // 0x0A = \n
                if (LF === -1) break;

                // Handle CRLF: check if the character before \n is \r (0x0D)
                let end = LF;
                if (end > pos && this.#buffer[end - 1] === 0x0D) end--;

                // Convert only the confirmed line to a string
                const line = this.#buffer.toString('utf8', pos, end);
                this.emit('line', line);
                pos = LF + 1;
            }
            // Keep only the trailing partial line in the class buffer
            if (pos > 0) this.#buffer = Buffer.from(this.#buffer.subarray(pos));
        });
        stream.on('end', () => {
            this.#queue.shift();
            if (this.#queue.length > 0) this.#internalDispatcher.emit('next');

            if (this.#flushIncomplete && this.#buffer.length > 0) {
                this.emit('line', this.#buffer.toString('utf8'));
                this.#buffer = Buffer.alloc(0);
            }
        });
        stream.on('error', (error) => this.emit('error', new Error('ReadStream error', { cause: error })));
    }

    #change(newPos?: number) {
        newPos ??= this.#getCurrentFilePos();
        if (newPos === undefined) return;
        // treat file truncation as overwrite/reset (matches GNU coreutils tail behavior)
        if (newPos < this.#currentCursorPos) this.#currentCursorPos = 0;
        if (newPos > this.#currentCursorPos) {
            this.#queue.push({ start: this.#currentCursorPos, end: newPos });
            this.#currentCursorPos = newPos;
            if (this.#queue.length === 1) this.#internalDispatcher.emit('next');
        }
    }

    #onWatchEvent(evtName: 'change' | 'rename') {
        // "change" event
        if (evtName === 'change') return this.#change();
        // "rename" event
        try {
            // explicitly check if rename event is real (macOS can falsely emit change events as "rename" ones)
            fs.accessSync(this.#filename, fs.constants.R_OK);
        } catch (error) {
            this.#lostFile(error);
        }
    }

    #onWatchFileEvent(curr: fs.Stats, _prev: fs.Stats) {
        // "change" event
        if (curr.nlink !== 0) return this.#change(curr.size);
        // "rename" event
        this.#lostFile({ code: 'ENOENT', syscall: 'stat', path: this.#filename }); // fake ENOENT error
    }

    #lostFile(error: unknown) {
        this.unwatch();
        this.emit('error', new Error('File not available anymore.', { cause: error }));
    }

    public unwatch() {
        if (this.#unwatched) return;
        if (this.#watcher) this.#watcher.close();
        else fs.unwatchFile(this.#filename);

        try { fs.closeSync(this.#fd); } catch {}

        this.#internalDispatcher.removeAllListeners();
        this.#buffer = Buffer.alloc(0);
        this.#queue.length = 0;
        this.#unwatched = true;
    }
}
