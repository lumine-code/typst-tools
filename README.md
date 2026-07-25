# typst-tools

Compile Typst documents with build tools, compile-on-save, and PDF viewer integration. Includes linter diagnostics, multiple simultaneous builds, and a built-in Typst installer.

## Features

- **Compilation**: build documents using the `typst` compiler with configurable output format.
- **Compile-on-save**: automatically recompile when the file is saved.
- **PDF viewing**: open output PDFs internally via [pdf-view](https://github.com/lumine-code/pdf-view).
- **Linter integration**: error and warning reporting via `linter-indie` with clickable references to source locations.
- **Multiple builds**: compile multiple files simultaneously with independent build states.
- **Built-in installer**: download the Typst binary directly from GitHub releases.

## Installation

To install `typst-tools` search for _typst-tools_ in the Install pane of the Lumine settings or run `lumine --install lumine-code/typst-tools`.

## Usage

This package requires the `typst` binary. Run the `Typst Tools: Install Typst` command to download the latest Typst release from GitHub into the package's `bin/` directory, or install it manually:

- **Windows**: `winget install --id Typst.Typst` or download from [typst/typst releases](https://github.com/typst/typst/releases)
- **macOS**: `brew install typst`
- **Linux**: `cargo install typst-cli` or download from [typst/typst releases](https://github.com/typst/typst/releases)

If `typst` is not in your PATH, set the full path in the package settings under **Path to Typst**.

The status bar item shows the build state of the active file with a live timer (`Typ` idle, `Typ*` compile-on-save enabled). Left click compiles, alt-left click toggles compile-on-save, middle click splits PDF and Typst source, and right click interrupts the build and clears the linter. The item stays visible while viewing the output PDF, and opening a PDF during a build waits for completion before showing the updated file. Each file tracks its own build state independently, so several documents can compile at the same time.

## Commands

Commands available in `atom-workspace`:

- `typst-tools:install-typst`: download and install the Typst binary from GitHub releases.

Commands available in `atom-text-editor[data-grammar~="typst"]`:

- `typst-tools:compile`: compile the current Typst document,
- `typst-tools:watch`: toggle compile-on-save mode for the current file,
- `typst-tools:interrupt`: stop the current build process for the active file,
- `typst-tools:interrupt-all`: stop all running build processes,
- `typst-tools:clean-linter`: clear all linter messages,
- `typst-tools:open-pdf`: open the generated PDF in Lumine,
- `typst-tools:list-fonts`: list all fonts available to Typst.

## Customization

The status-bar item can be restyled from your `styles.less`, e.g.:

```less
.typst-tools-status {
  &.status-building {
    color: var(--text-color-info);
  }
}
```

## Services

- **typst-tools** (`1.0.0`): provided to let other packages drive Typst compilation — subscribe to build events (`onDidStartBuild`, `onDidFinishBuild`, `onDidFailBuild`, `onDidChangeBuildStatus`), query status (`getStatus`, `isBuilding`), and control builds (`compile`, `interrupt`, `interruptAll`, `toggleCompileOnSave`).
- **status-bar** (`^1.0.0`): consumed to show the build state and timer in the status bar.
- **linter-indie** (`2.0.0`): consumed to report Typst errors and warnings in the linter panel.

## Contributing

Got ideas to make this package better, found a bug, or want to help add new features? Just drop your thoughts on GitHub. Any feedback is welcome!
