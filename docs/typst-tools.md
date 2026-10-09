# typst-tools

Drives Typst compilation from another package: start and interrupt builds, read their status, and follow build events.

|             |                                                             |
| ----------- | ----------------------------------------------------------- |
| Version     | `1.0.0`                                                     |
| Provided by | `provideTypstTools()` returning the build service           |
| Consumed by | `consumeTypstTools(typstTools)`                             |
| Owner       | [`typst-tools`](https://github.com/lumine-code/typst-tools) |

Consumed by `pdf-view`, to keep the rendered PDF in step with the source. Deliberately parallel to `latex-tools` so a consumer can treat the two almost interchangeably — see Behavior for where they differ.

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
  getOutputPath(filePath: string): string | null;
  isCompileOnSaveEnabled(editor: TextEditor): boolean;

  // Control
  compile(filePath: string): boolean;
  interrupt(filePath: string): boolean;
  interruptAll(): number;
  toggleCompileOnSave(): void;
  openPdf(filePath: string): Promise<boolean>;
};
```

| Group   | Notes                                                                                                |
| ------- | ---------------------------------------------------------------------------------------------------- |
| Events  | All return a `Disposable`. `onDidChangeBuildStatus` is the coarse one for an indicator.              |
| Status  | `getStatus()` returns the build inventory. Message readers default to the active Typst editor.       |
| Control | `compile` returns whether the build started. `toggleCompileOnSave` toggles the active editor's file. |

## Minimal example

```js
const { CompositeDisposable, Disposable } = require("lumine");

module.exports = {
  consumeTypstTools(typstTools) {
    this.typst = typstTools;
    const disposables = new CompositeDisposable();
    disposables.add(
      typstTools.onDidFinishBuild(({ file }) => {
        const output = typstTools.getOutputPath(file);
        if (output) this.showPdf(output);
      }),
      new Disposable(() => (this.typst = null)),
    );
    return disposables;
  },
};
```

## Behavior

A Typst document compiles from the supplied source path. `compile(filePath)` returns immediately with `true` when the build starts, or `false` when it cannot start; subscribe to build events to learn the result. Compile-on-save is tracked per file. `toggleCompileOnSave()` toggles the active editor's file, and `isCompileOnSaveEnabled(editor)` reads the supplied editor's state.

`getOutputPath` uses the configured output format and returns the output path only when that file exists, or `null` otherwise. `openPdf(filePath)` opens an existing output in the workspace and resolves to whether it succeeded.

`onDidFinishBuild` and `onDidFailBuild` are mutually exclusive per build; `onDidChangeBuildStatus` covers both and the transitions between, which is what an indicator should follow.

Diagnostics reach the linter panel on their own, so a consumer does not need to republish `getMessages`.

The diagnostic store holds the most recently completed current build. `getMessages(root)` and `getMessageStatistics(root)` return its diagnostics only for that compilation root; omitting the root resolves the active Typst editor. Diagnostics for imported sources remain part of their owning root's result. A clean build replaces the snapshot with no messages; the service does not keep a build history.

A compile command waiting for a document save stops if its target editor or package retires, while the accepted save still finishes. Running builds are interrupted on deactivation. Old interrupted process callbacks cannot replace a newer build, and a retained service declines new work after its package retires.

`compile` on a file already building is not queued — check `isBuilding(filePath)` first if that matters.

## Teardown

Return a `Disposable` that unsubscribes and drops your reference. Do **not** call `interruptAll` or `toggleCompileOnSave` on teardown: both change state the user owns.

## Versioning

`1.0.0` provided, `^1.0.0` consumed. Backward-compatible additions stay within version 1; incompatible contract changes require a new major service version.
