// Copyright 2020 Google Inc. All Rights Reserved.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import type {
  FileSystemDirectoryHandle,
  FileSystemFileHandle,
  FileSystemHandle,
  FileSystemWritableFileStream,
  MyFile,
} from "@kobakazu0429/native-file-system-adapter-lite";
import { SystemError } from "./errors";
import { OpenFlags, E } from "./constants";
import type { fd_t } from "./constants";

export type Handle = FileSystemFileHandle | FileSystemDirectoryHandle;

class OpenDirectory {
  constructor(
    public readonly path: string,
    private readonly _handle: FileSystemDirectoryHandle
  ) {}

  isFile!: false;

  private _currentIter:
    | {
        pos: number;
        reverted: FileSystemHandle | undefined;
        iter: AsyncIterableIterator<FileSystemHandle>;
      }
    | undefined = undefined;

  asFile(): never {
    throw new SystemError(E.ISDIR);
  }

  asDir() {
    return this;
  }

  getEntries(start = 0): AsyncIterableIterator<FileSystemHandle> & {
    revert: (handle: FileSystemHandle) => void;
  } {
    console.debug("[getEntries]");
    if (this._currentIter?.pos !== start) {
      // We're at incorrect position and will have to skip [start] items.
      this._currentIter = {
        pos: 0,
        reverted: undefined,
        iter: this._handle.values(),
      };
    } else {
      // We are already at correct position, so zero this out.
      start = 0;
    }
    const currentIter = this._currentIter;
    return {
      next: async () => {
        // This is a rare case when the caller tries to start reading directory
        // from a different position than our iterator is on.
        //
        // This can happen e.g. with multiple iterators, or if previous iteration
        // has been cancelled.
        //
        // In those cases, we need to first manually skip [start] items from the
        // iterator, and on the next calls we'll be able to continue normally.
        for (; start; start--) {
          await currentIter.iter.next();
        }
        // If there is a handle saved by a `revert(...)` call, take and return it.
        const { reverted } = currentIter;
        if (reverted) {
          currentIter.reverted = undefined;
          currentIter.pos++;
          return {
            value: reverted,
            done: false,
          };
        }
        // Otherwise use the underlying iterator.
        const res = await currentIter.iter.next();
        if (!res.done) {
          currentIter.pos++;
        }
        return res;
      },
      // This function allows to go one step back in the iterator
      // by saving an item in an internal buffer.
      // That item will be given back on the next iteration attempt.
      //
      // This allows to avoid having to restart the underlying
      // forward iterator over and over again just to find the required
      // position.
      revert: (handle: FileSystemHandle) => {
        if (currentIter.reverted || currentIter.pos === 0) {
          throw new Error("Cannot revert a handle in the current state.");
        }
        currentIter.pos--;
        currentIter.reverted = handle;
      },
      [Symbol.asyncIterator]() {
        return this;
      },
    };
  }

  getFileOrDir(
    path: string,
    mode: FileOrDir.File,
    openFlags?: OpenFlags
  ): Promise<FileSystemFileHandle>;
  getFileOrDir(
    path: string,
    mode: FileOrDir.Dir,
    openFlags?: OpenFlags
  ): Promise<FileSystemDirectoryHandle>;
  getFileOrDir(
    path: string,
    mode: FileOrDir,
    openFlags?: OpenFlags
  ): Promise<Handle>;
  async getFileOrDir(path: string, mode: FileOrDir, openFlags: OpenFlags = 0) {
    console.debug("[getFileOrDir]");
    const { parent, name: maybeName } = await this._resolve(path);
    // Handle case when we couldn't get a parent, only direct handle
    // (this means it's a preopened directory).
    if (maybeName === undefined) {
      if (mode & FileOrDir.Dir) {
        if (openFlags & (OpenFlags.Create | OpenFlags.Exclusive)) {
          throw new SystemError(E.EXIST);
        }
        if (openFlags & OpenFlags.Truncate) {
          throw new SystemError(E.ISDIR);
        }
        return parent;
      } else {
        throw new SystemError(E.ISDIR);
      }
    }
    const name = maybeName;
    async function openWithCreate(create: boolean) {
      if (mode & FileOrDir.File) {
        try {
          return await parent.getFileHandle(name, { create });
        } catch (err: any) {
          if (err.name === "TypeMismatchError") {
            if (!(mode & FileOrDir.Dir)) {
              console.warn(err);
              throw new SystemError(E.ISDIR);
            }
          } else {
            throw err;
          }
        }
      }
      try {
        return await parent.getDirectoryHandle(name, { create });
      } catch (err: any) {
        if (err.name === "TypeMismatchError") {
          console.warn(err);
          throw new SystemError(E.NOTDIR);
        } else {
          throw err;
        }
      }
    }
    if (openFlags & OpenFlags.Directory) {
      if (mode & FileOrDir.Dir) {
        mode = FileOrDir.Dir;
      } else {
        throw new TypeError(
          `Open flags ${openFlags} require a directory but mode ${mode} doesn't allow it.`
        );
      }
    }
    let handle: Handle;
    if (openFlags & OpenFlags.Create) {
      if (openFlags & OpenFlags.Exclusive) {
        let exists = true;
        try {
          await openWithCreate(false);
        } catch {
          exists = false;
        }
        if (exists) {
          throw new SystemError(E.EXIST);
        }
      }
      handle = await openWithCreate(true);
    } else {
      handle = await openWithCreate(false);
    }
    if (openFlags & OpenFlags.Truncate) {
      if ((handle as any).isDirectory || handle.kind === "directory") {
        throw new SystemError(E.ISDIR);
      }
      const writable = await (handle as FileSystemFileHandle).createWritable({
        keepExistingData: false,
      });
      await writable.close();
    }
    return handle;
  }

  async delete(path: string) {
    console.debug("[delete]");
    const { parent, name } = await this._resolve(path);
    if (!name) {
      throw new SystemError(E.ACCES);
    }
    await parent.removeEntry(name);
  }

  // eslint-disable-next-line @typescript-eslint/no-empty-function
  close() {}

  private async _resolve(path: string) {
    console.debug("[_resolve]");
    const parts = path ? path.split("/") : [];
    const resolvedParts = [];
    for (const item of parts) {
      if (item === "..") {
        if (resolvedParts.pop() === undefined) {
          throw new SystemError(E.NOTCAPABLE);
        }
      } else if (item !== ".") {
        resolvedParts.push(item);
      }
    }
    const name = resolvedParts.pop();
    let parent = this._handle;
    for (const item of resolvedParts) {
      parent = await parent.getDirectoryHandle(item);
    }
    return {
      parent,
      name,
    };
  }
}

OpenDirectory.prototype.isFile = false;

class OpenFile {
  constructor(
    public readonly path: string,
    private readonly _handle: FileSystemFileHandle
  ) {}

  isFile!: true;

  public position = 0;
  private _writer: FileSystemWritableFileStream | undefined = undefined;

  async getFile() {
    console.debug("[getfile]");
    // TODO: do we really have to?
    await this.flush();
    return this._handle.getFile() as any as Promise<MyFile>;
  }

  async setSize(size: number) {
    console.debug("[setSize]");
    const writer = await this._getWriter();
    await writer.truncate(size);
  }

  async read(len: number) {
    console.debug("[read]");
    const file = await this.getFile();
    const slice = file.slice(this.position, this.position + len);
    const arrayBuffer = await slice.arrayBuffer();
    this.position += arrayBuffer.byteLength;
    return new Uint8Array(arrayBuffer);
  }

  async write(data: Uint8Array) {
    console.debug("[write]");
    const writer = await this._getWriter();
    await writer.write({ type: "write", position: this.position, data });
    this.position += data.length;
  }

  async flush() {
    console.debug("[flush]");
    if (!this._writer) return;
    await this._writer.close();
    this._writer = undefined;
  }

  asFile() {
    return this;
  }

  asDir(): never {
    throw new SystemError(E.NOTDIR);
  }

  close() {
    return this.flush();
  }

  private async _getWriter() {
    return (
      this._writer ||
      (this._writer = await this._handle.createWritable({
        keepExistingData: true,
      }))
    );
  }
}

OpenFile.prototype.isFile = true;

export const enum FileOrDir {
  File = 1, // 1 << 0
  Dir = 2, // 1 << 1
  Any = 3, // File | Dir
}

// 0	標準入力 (stdin)
// 1	標準出力 (stdout)
// 2	標準エラー出力 (stderr)
export const FIRST_PREOPEN_FD = 3 as fd_t;

export class OpenFiles {
  constructor(preOpen: Record<string, FileSystemDirectoryHandle>) {
    console.debug("[preOpen]", preOpen);
    for (const path in preOpen) {
      this._add(path, preOpen[path]);
    }
    this._firstNonPreopenFd = this._nextFd;
  }

  private _files = new Map<fd_t, OpenFile | OpenDirectory>();
  private _nextFd = FIRST_PREOPEN_FD;
  private readonly _firstNonPreopenFd: fd_t;

  getPreOpen(fd: fd_t): OpenDirectory {
    console.debug("[getpreopen]");
    if (fd >= FIRST_PREOPEN_FD && fd < this._firstNonPreopenFd) {
      return this.get(fd) as OpenDirectory;
    } else {
      throw new SystemError(E.BADF, true);
    }
  }

  async open(preOpen: OpenDirectory, path: string, openFlags?: OpenFlags) {
    console.debug("[open]", path);
    return this._add(
      `${preOpen.path}/${path}`,
      await preOpen.getFileOrDir(path, FileOrDir.Any, openFlags)
    );
  }

  get(fd: fd_t) {
    console.debug("[get]");
    const openFile = this._files.get(fd);
    if (!openFile) {
      throw new SystemError(E.BADF);
    }
    return openFile;
  }

  async renumber(from: fd_t, to: fd_t) {
    console.debug("[renumber]");
    await this.close(to);
    this._files.set(to, this._take(from));
  }

  async close(fd: fd_t) {
    console.debug("[close]");
    await this._take(fd).close();
  }

  private _add(path: string, handle: Handle) {
    console.debug("[_add]", path);
    this._files.set(
      this._nextFd,
      handle.kind === "file"
        ? new OpenFile(path, handle)
        : new OpenDirectory(path, handle)
    );
    return this._nextFd++ as fd_t;
  }

  private _take(fd: fd_t) {
    console.debug("[_take]");
    const handle = this.get(fd);
    this._files.delete(fd);
    return handle;
  }

  // Translation of the algorithm from __wasilibc_find_relpath.
  // eslint-disable-next-line @typescript-eslint/member-ordering
  findRelPath(path: string) {
    console.debug("[findRelPath]");
    /// Are the `prefix_len` bytes pointed to by `prefix` a prefix of `path`?
    function prefixMatches(prefix: string, path: string) {
      // Allow an empty string as a prefix of any relative path.
      if (path[0] != "/" && !prefix) {
        return true;
      }

      // Check whether any bytes of the prefix differ.
      if (!path.startsWith(prefix)) {
        return false;
      }

      // Ignore trailing slashes in directory names.
      let i = prefix.length;
      while (i > 0 && prefix[i - 1] == "/") {
        --i;
      }

      // Match only complete path components.
      const last = path[i];
      return last === "/" || !last;
    }

    // Search through the preopens table. Iterate in reverse so that more
    // recently added preopens take precedence over less recently addded ones.
    let matchLen = 0;
    let foundPre;
    for (let i = this._firstNonPreopenFd - 1; i >= FIRST_PREOPEN_FD; --i) {
      const pre = this.get(i as fd_t) as OpenDirectory;
      let prefix = pre.path;

      if (path !== "." && !path.startsWith("./")) {
        // We're matching a relative path that doesn't start with "./" and
        // isn't ".".
        if (prefix.startsWith("./")) {
          prefix = prefix.slice(2);
        } else if (prefix === ".") {
          prefix = prefix.slice(1);
        }
      }

      // If we haven't had a match yet, or the candidate path is longer than
      // our current best match's path, and the candidate path is a prefix of
      // the requested path, take that as the new best path.
      if (
        (!foundPre || prefix.length > matchLen) &&
        prefixMatches(prefix, path)
      ) {
        foundPre = pre;
        matchLen = prefix.length;
      }
    }

    if (!foundPre) {
      throw new Error(
        `Couldn't resolve the given path via preopened directories.`
      );
    }

    // The relative path is the substring after the portion that was matched.
    let computed = path.slice(matchLen);

    // Omit leading slashes in the relative path.
    computed = computed.replace(/^\/+/, "");

    // *at syscalls don't accept empty relative paths, so use "." instead.
    computed = computed || ".";

    return {
      preOpen: foundPre,
      relativePath: computed,
    };
  }
}
