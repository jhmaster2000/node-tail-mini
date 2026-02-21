# Tail Mini

A slimmer modern TypeScript-native rewrite of [node-tail](https://github.com/lucagrulla/node-tail/), a zero dependency Node.js module for tailing a file.

![license](https://img.shields.io/github/license/mashape/apistatus.svg)

## Installation & Use

At the time of writing, I have mainly written this fork for personal use in a project only, and am not interested in publicly maintaining this as a library for general use on `npm`, so it is not hosted there (but I may do so in the future). This is also why documentation will be scarce, if any provided, but the class should be fairly straightforward to figure out.

Since the project is a single file, I simply copy the `tail.ts` file into my relevant project's source folders.

## Important

**Tail Mini** is *not* a drop-in replacement for the original `node-tail`, while some of the original API familiarity remains, many breaking changes have been made in favour of modernizing, performance and implementation size for my specific *basic* tailing needs, including several "advanced" features/options from the original package being entirely removed.

## Documentation

### Constructor parameters
```ts
constructor(filepath: string, options?: TailOptions)
```
See JSDoc comments in `tail.ts`.

### Emitted events

#### `line`
The `data` will always be a completed well-formed UTF-8 string, unless you use the `flushIncomplete: true` option (formerly `flushAtEOF`), in which case the string may contain malformed UTF-8 characters at the ends if a multi-byte character is broken across different writes to the file for whatever reason.
```ts
tail.on('line', (data: string) => {
  console.log(data);
});
```

#### `error`
The error emitted will always be an `Error` instance from tail with an attached `cause` with the underlying error (usually also an `Error`-like object, but not guaranteed).
```ts
tail.on('error', (err) => {
  console.log(err, err.cause);
});
```
