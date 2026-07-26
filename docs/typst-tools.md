# typst-tools

Drives Typst compilation from another package: start and interrupt builds, read their status, and follow build events.

|             |                                                             |
| ----------- | ----------------------------------------------------------- |
| Version     | `1.0.0`                                                     |
| Provided by | `provideTypstTools()` returning the build service           |
| Consumed by | `consumeTypstTools(typstTools)`                             |
| Owner       | [`typst-tools`](https://github.com/lumine-code/typst-tools) |

Consumed by `pdf-view`, to keep the rendered PDF in step with the source. Deliberately parallel to [`latex-tools`](https://lumine-code.github.io/docs.html#services/latex-tools) so a consumer can treat the two almost interchangeably — see Behavior for where they differ.

## Registration

In your `package.json`:

```json
{
  "consumedServices": {
    "typst-tools": {
      "versions": { "^1.0.0": "consumeTypstTools" }
    }
  }
}
```

## Contract

```ts
type TypstTools = {
  // Events
  onDidStartBuild(callback: (event: object) => void): Disposable;
  onDidFinishBuild(callback: (event: object) => void): Disposable;
  onDidFailBuild(callback: (event: object) => void): Disposable;
  onDidChangeBuildStatus(callback: (event: object) => void): Disposable;
  onDidUpdateMessages(callback: (event: object) => void): Disposable;

  // Status
  getStatus(filePath?: string): object;
  isBuilding(filePath: string): boolean;
  isAnyBuilding(): boolean;
  getMessages(filePath?: string): object[];
  getMessageStatistics(filePath?: string): object;
  getOutputPath(filePath: string): string;
  isCompileOnSaveEnabled(editor: TextEditor): boolean;

  // Control
  compile(filePath: string): Promise<void>;
  interrupt(filePath: string): void;
  interruptAll(): void;
  toggleCompileOnSave(): void;
};
```

| Group   | Notes                                                                                                    |
| ------- | -------------------------------------------------------------------------------------------------------- |
| Events  | All return a `Disposable`. `onDidChangeBuildStatus` is the coarse one for an indicator.                  |
| Status  | Every reader takes an **optional** `filePath`; omitting it answers for the project rather than one file. |
| Control | `compile` resolves when the build finishes. `toggleCompileOnSave` flips the setting globally.            |

## Minimal example

```js
const { CompositeDisposable, Disposable } = require("atom");

module.exports = {
  consumeTypstTools(typstTools) {
    this.typst = typstTools;
    const disposables = new CompositeDisposable();
    disposables.add(
      typstTools.onDidFinishBuild(({ filePath }) => {
        this.showPdf(typstTools.getOutputPath(filePath));
      }),
      new Disposable(() => (this.typst = null)),
    );
    return disposables;
  },
};
```

## Behavior

**Two differences from `latex-tools`, both deliberate.** There is no `resolveRoot`: a Typst document compiles from the file itself, so the path you have is the path to build. And compile-on-save is a global `toggleCompileOnSave()` rather than a per-editor setter — you can read `isCompileOnSaveEnabled(editor)` but not set it for one editor.

`getOutputPath` answers from configuration rather than the filesystem, so it is valid before any build has run and does not imply the file exists.

`onDidFinishBuild` and `onDidFailBuild` are mutually exclusive per build; `onDidChangeBuildStatus` covers both and the transitions between, which is what an indicator should follow.

Diagnostics reach the linter panel on their own, so a consumer does not need to republish `getMessages`.

`compile` on a file already building is not queued — check `isBuilding(filePath)` first if that matters.

## Teardown

Return a `Disposable` that unsubscribes and drops your reference. Do **not** call `interruptAll` or `toggleCompileOnSave` on teardown: both change state the user owns.

## Versioning

`1.0.0` provided, `^1.0.0` consumed. A change that breaks this shape gets a new service name rather than a new major version, and both sides move in the same release.
