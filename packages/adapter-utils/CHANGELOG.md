# @paperclipai/adapter-utils

## Unreleased

### Patch Changes

- Allow the Paperclip host to route adapter sandbox-sync full-tree Git enumeration through its process-wide bounded scheduler.
- Keep the primary checkout coherent after an SSH run restore: snapshot the sync-back baseline before the workspace seed sends anything (`planWorkspaceSeed`), reset the Git index to the integrated HEAD, and realign tracked files with HEAD, so a change that lands during the run is no longer reverted or deleted and a plain `git commit` no longer deletes the run's files.

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
