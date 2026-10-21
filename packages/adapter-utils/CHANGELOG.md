# @paperclipai/adapter-utils

## Unreleased

### Patch Changes

- Allow the Paperclip host to route adapter sandbox-sync full-tree Git enumeration through its process-wide bounded scheduler.
- Keep the primary checkout coherent after an SSH run restore: snapshot the sync-back baseline before the workspace seed sends anything (`planWorkspaceSeed`), move the Git index with the integrated HEAD on the paths the run's commits changed, and bring the tracked files the merge wrote back in line with HEAD, so a change that lands during the run is no longer reverted or deleted and a plain `git commit` no longer deletes the run's files. A run whose HEAD is still the seed head leaves the local HEAD, index and branches alone. Changes staged by hand stay staged. The ref moves after the merge's preflight and goes back when the index cannot follow, and every index write waits briefly for another git process's `index.lock`. Each restore step logs its duration.

## 0.3.1

### Patch Changes

- Stable release preparation for 0.3.1

## 0.3.0

### Minor Changes

- Stable release preparation for 0.3.0

## 0.2.7

### Patch Changes

- Version bump (patch)

## 0.2.6

### Patch Changes

- Version bump (patch)

## 0.2.5

### Patch Changes

- Version bump (patch)

## 0.2.4

### Patch Changes

- Version bump (patch)

## 0.2.3

### Patch Changes

- Version bump (patch)

## 0.2.2

### Patch Changes

- Version bump (patch)

## 0.2.1

### Patch Changes

- Version bump (patch)
