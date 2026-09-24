// Cerebriline sandbox — milestone 1 hook DLL (observe-only).
//
// Loaded into a launcher-started child (see launcher.cpp) and into every
// process that child spawns. It hooks the low-level file-open syscalls and
// logs each path, and it re-injects itself into child processes so the whole
// tree is covered. No redirection yet — this milestone proves the mechanism
// and lets us watch what a real `npm test` / `node` / `git` command touches.
//
// This is the Detours `withdll` + `traceapi` pattern: same technique Microsoft
// BuildXL uses to sandbox build trees in user mode, and what VFS for Git used.
// Build: see build-hook.bat (MSVC + Microsoft Detours, both MIT).

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <detours.h>
#include <cstdio>
#include <cwchar>
#include <cstdlib>  // _countof

// ---- Minimal NT types (we only touch the fields we read) -------------------

typedef LONG NTSTATUS;

typedef struct _UNICODE_STRING {
    USHORT Length;
    USHORT MaximumLength;
    PWSTR  Buffer;
} UNICODE_STRING, *PUNICODE_STRING;

typedef struct _OBJECT_ATTRIBUTES {
    ULONG           Length;
    HANDLE          RootDirectory;
    PUNICODE_STRING ObjectName;
    ULONG           Attributes;
    PVOID           SecurityDescriptor;
    PVOID           SecurityQualityOfService;
} OBJECT_ATTRIBUTES, *POBJECT_ATTRIBUTES;

typedef struct _IO_STATUS_BLOCK {
    union { NTSTATUS Status; PVOID Pointer; };
    ULONG_PTR Information;
} IO_STATUS_BLOCK, *PIO_STATUS_BLOCK;

typedef NTSTATUS(NTAPI* PFN_NtCreateFile)(
    PHANDLE FileHandle, ACCESS_MASK DesiredAccess,
    POBJECT_ATTRIBUTES ObjectAttributes, PIO_STATUS_BLOCK IoStatusBlock,
    PLARGE_INTEGER AllocationSize, ULONG FileAttributes, ULONG ShareAccess,
    ULONG CreateDisposition, ULONG CreateOptions, PVOID EaBuffer,
    ULONG EaLength);

typedef NTSTATUS(NTAPI* PFN_NtOpenFile)(
    PHANDLE FileHandle, ACCESS_MASK DesiredAccess,
    POBJECT_ATTRIBUTES ObjectAttributes, PIO_STATUS_BLOCK IoStatusBlock,
    ULONG ShareAccess, ULONG OpenOptions);

// NtSetInformationFile: we watch it for delete dispositions on a tracked
// handle, to lay a whiteout. FileDispositionInformation == 13 carries a single
// BOOLEAN DeleteFile; FileDispositionInformationEx == 64 carries a Flags ULONG
// whose bit 0 (FILE_DISPOSITION_DELETE) requests the delete.
typedef NTSTATUS(NTAPI* PFN_NtSetInformationFile)(
    HANDLE FileHandle, PIO_STATUS_BLOCK IoStatusBlock,
    PVOID FileInformation, ULONG Length, ULONG FileInformationClass);

typedef NTSTATUS(NTAPI* PFN_NtClose)(HANDLE Handle);

// Path-based metadata queries (fs.exists/stat, and most tools' pre-checks).
// Not hooking these would let a whiteouted or copied-up file be stat'd from the
// workspace. The info buffer is opaque to us; we only reroute the path.
typedef NTSTATUS(NTAPI* PFN_NtQueryAttributesFile)(POBJECT_ATTRIBUTES, PVOID);
typedef NTSTATUS(NTAPI* PFN_NtQueryFullAttributesFile)(POBJECT_ATTRIBUTES, PVOID);

// Directory enumeration (dir / readdir / glob). We take these over for a
// tracked workspace directory to serve the merged workspace+overlay listing.
typedef NTSTATUS(NTAPI* PFN_NtQueryDirectoryFile)(
    HANDLE, HANDLE, PVOID, PVOID, PIO_STATUS_BLOCK, PVOID, ULONG, ULONG,
    BOOLEAN, PUNICODE_STRING, BOOLEAN);
typedef NTSTATUS(NTAPI* PFN_NtQueryDirectoryFileEx)(
    HANDLE, HANDLE, PVOID, PVOID, PIO_STATUS_BLOCK, PVOID, ULONG, ULONG,
    ULONG, PUNICODE_STRING);

#define STATUS_OBJECT_NAME_NOT_FOUND ((NTSTATUS)0xC0000034L)
#define STATUS_NO_MORE_FILES         ((NTSTATUS)0x80000006L)
#define STATUS_BUFFER_OVERFLOW       ((NTSTATUS)0x80000005L)

// ---- Real function pointers ------------------------------------------------

static PFN_NtCreateFile         Real_NtCreateFile = nullptr;
static PFN_NtOpenFile           Real_NtOpenFile = nullptr;
static PFN_NtSetInformationFile Real_NtSetInformationFile = nullptr;
static PFN_NtClose              Real_NtClose = nullptr;
static PFN_NtQueryAttributesFile     Real_NtQueryAttributesFile = nullptr;
static PFN_NtQueryFullAttributesFile Real_NtQueryFullAttributesFile = nullptr;
static PFN_NtQueryDirectoryFile      Real_NtQueryDirectoryFile = nullptr;
static PFN_NtQueryDirectoryFileEx    Real_NtQueryDirectoryFileEx = nullptr;

static BOOL(WINAPI* Real_CreateProcessW)(
    LPCWSTR, LPWSTR, LPSECURITY_ATTRIBUTES, LPSECURITY_ATTRIBUTES, BOOL,
    DWORD, LPVOID, LPCWSTR, LPSTARTUPINFOW, LPPROCESS_INFORMATION)
    = CreateProcessW;

static BOOL(WINAPI* Real_CreateProcessA)(
    LPCSTR, LPSTR, LPSECURITY_ATTRIBUTES, LPSECURITY_ATTRIBUTES, BOOL,
    DWORD, LPVOID, LPCSTR, LPSTARTUPINFOA, LPPROCESS_INFORMATION)
    = CreateProcessA;

// ---- Our own module path, so we can re-inject into children ----------------

static wchar_t g_dllPath[MAX_PATH] = L"";
static wchar_t g_logPath[MAX_PATH] = L"";
// Milestone 2: redirect the workspace root to the agent's overlay. Both are
// Win32 paths without a trailing slash, e.g. C:\...\ws and C:\...\overlay.
static wchar_t g_wsRoot[MAX_PATH] = L"";
static wchar_t g_overlayRoot[MAX_PATH] = L"";
static CRITICAL_SECTION g_logLock;

// Per-thread reentrancy guard: our own logging opens a file, which calls the
// very syscalls we hook. Without this the first open recurses forever and the
// process dies on startup before running anything.
static __declspec(thread) int g_inHook = 0;

static void LogLine(const wchar_t* tag, const wchar_t* path, size_t len) {
    if (g_logPath[0] == L'\0' || path == nullptr || len == 0) return;
    EnterCriticalSection(&g_logLock);
    HANDLE h = CreateFileW(g_logPath, FILE_APPEND_DATA, FILE_SHARE_READ | FILE_SHARE_WRITE,
                           nullptr, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (h != INVALID_HANDLE_VALUE) {
        wchar_t line[MAX_PATH + 64];
        int n = _snwprintf_s(line, _countof(line), _TRUNCATE, L"%lu\t%s\t%.*s\r\n",
                             GetCurrentProcessId(), tag, (int)len, path);
        if (n > 0) {
            DWORD written = 0;
            WriteFile(h, line, (DWORD)(n * sizeof(wchar_t)), &written, nullptr);
        }
        CloseHandle(h);
    }
    LeaveCriticalSection(&g_logLock);
}

static void LogObjectName(const wchar_t* tag, POBJECT_ATTRIBUTES oa) {
    if (!oa || !oa->ObjectName || !oa->ObjectName->Buffer) return;
    LogLine(tag, oa->ObjectName->Buffer, oa->ObjectName->Length / sizeof(wchar_t));
}

// ---- Overlay decision: workspace root -> agent overlay ---------------------
//
// NT absolute paths look like \??\C:\dir\file. If the open targets a path under
// the workspace root, decide where it should actually go:
//   * already copied up (exists in overlay)  -> overlay
//   * pure read, only in the workspace        -> workspace (no redirect)
//   * write / create                          -> copy the workspace file up
//                                                into the overlay, then overlay
// so the real workspace is only ever read, never written. Relative-to-handle
// opens (RootDirectory set) are left alone for this spike. Directory-listing
// merge and delete whiteouts are milestone 4.

// Access bits that imply the caller may write. (Values from ntdef/winnt.)
static bool WantsWriteAccess(ACCESS_MASK a) {
    const ACCESS_MASK writeBits =
        0x0002 /*FILE_WRITE_DATA*/  | 0x0004 /*FILE_APPEND_DATA*/ |
        0x0010 /*FILE_WRITE_EA*/    | 0x0100 /*FILE_WRITE_ATTRIBUTES*/ |
        0x00010000 /*DELETE*/       | 0x40000000 /*GENERIC_WRITE*/ |
        0x10000000 /*GENERIC_ALL*/  | 0x02000000 /*MAXIMUM_ALLOWED*/;
    return (a & writeBits) != 0;
}

// CreateDisposition values that create or overwrite (so, write intent).
static bool DispositionCreates(ULONG d) {
    return d == 0 /*SUPERSEDE*/ || d == 2 /*CREATE*/ ||
           d == 4 /*OVERWRITE*/ || d == 5 /*OVERWRITE_IF*/;
}

// Create every parent directory of a full Win32 path (best effort).
static void EnsureParentDirs(const wchar_t* fullPath) {
    wchar_t tmp[1024];
    if (wcscpy_s(tmp, _countof(tmp), fullPath) != 0) return;
    wchar_t* lastSep = wcsrchr(tmp, L'\\');
    if (!lastSep) return;
    *lastSep = L'\0';                      // tmp = parent directory
    for (wchar_t* q = tmp + 3; *q; ++q) {  // skip drive "C:\"
        if (*q == L'\\') { *q = L'\0'; CreateDirectoryW(tmp, nullptr); *q = L'\\'; }
    }
    CreateDirectoryW(tmp, nullptr);
}

static bool FileExists(const wchar_t* p) {
    return GetFileAttributesW(p) != INVALID_FILE_ATTRIBUTES;
}

// ---- Directory-handle registry ---------------------------------------------
//
// Maps an open directory handle to its logical workspace path, so that a child
// opened relative to that handle (RootDirectory != NULL) can be resolved to a
// full path and routed like an absolute one, and so the directory-listing merge
// (milestone 4b) knows which overlay directory to fold in.
struct DirReg { HANDLE h; bool isDir; wchar_t logical[1024]; };
static DirReg g_reg[1024];
static CRITICAL_SECTION g_regLock;

static void RegisterHandle(HANDLE h, bool isDir, const wchar_t* logical) {
    if (!h || h == INVALID_HANDLE_VALUE) return;
    EnterCriticalSection(&g_regLock);
    int slot = -1;
    for (int i = 0; i < 1024; ++i) {
        if (g_reg[i].h == h) { slot = i; break; }
        if (slot < 0 && g_reg[i].h == nullptr) slot = i;
    }
    if (slot >= 0) {
        g_reg[slot].h = h;
        g_reg[slot].isDir = isDir;
        wcscpy_s(g_reg[slot].logical, _countof(g_reg[slot].logical), logical);
    }
    LeaveCriticalSection(&g_regLock);
}

// Look up a handle's logical workspace path; only directory handles satisfy
// dirsOnly (used for relative-open resolution).
static bool LookupDir(HANDLE h, wchar_t* out, size_t cap) {
    bool found = false;
    EnterCriticalSection(&g_regLock);
    for (int i = 0; i < 1024; ++i) {
        if (g_reg[i].h == h && g_reg[i].isDir) {
            wcscpy_s(out, cap, g_reg[i].logical); found = true; break;
        }
    }
    LeaveCriticalSection(&g_regLock);
    return found;
}

static bool LookupHandle(HANDLE h, wchar_t* out, size_t cap) {
    bool found = false;
    EnterCriticalSection(&g_regLock);
    for (int i = 0; i < 1024; ++i) {
        if (g_reg[i].h == h) { wcscpy_s(out, cap, g_reg[i].logical); found = true; break; }
    }
    LeaveCriticalSection(&g_regLock);
    return found;
}

static void UnregisterDir(HANDLE h) {
    EnterCriticalSection(&g_regLock);
    for (int i = 0; i < 512; ++i) {
        if (g_reg[i].h == h) { g_reg[i].h = nullptr; g_reg[i].logical[0] = L'\0'; break; }
    }
    LeaveCriticalSection(&g_regLock);
}

// ---- Whiteouts (tombstones for deleted files) ------------------------------
//
// A delete records an AUFS-style ".wh.<name>" marker in the overlay directory
// instead of removing the workspace file. A read of a whiteouted path reads as
// gone (not fallen through), and the listing merge (4b) hides the name.
static bool WhiteoutPath(const wchar_t* ovPath, wchar_t* out, size_t cap) {
    wchar_t tmp[1024];
    if (wcscpy_s(tmp, _countof(tmp), ovPath) != 0) return false;
    wchar_t* sep = wcsrchr(tmp, L'\\');
    if (!sep) return false;
    *sep = L'\0';
    const wchar_t* name = sep + 1;
    return _snwprintf_s(out, cap, _TRUNCATE, L"%s\\.wh.%s", tmp, name) > 0;
}

static bool HasWhiteout(const wchar_t* ovPath) {
    wchar_t wh[1024];
    return WhiteoutPath(ovPath, wh, _countof(wh)) && FileExists(wh);
}

static void MakeWhiteout(const wchar_t* ovPath) {
    wchar_t wh[1024];
    if (!WhiteoutPath(ovPath, wh, _countof(wh))) return;
    EnsureParentDirs(wh);
    HANDLE h = CreateFileW(wh, GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE,
                           nullptr, CREATE_ALWAYS, FILE_ATTRIBUTE_HIDDEN, nullptr);
    if (h != INVALID_HANDLE_VALUE) CloseHandle(h);
}

static void RemoveWhiteout(const wchar_t* ovPath) {
    wchar_t wh[1024];
    if (WhiteoutPath(ovPath, wh, _countof(wh))) DeleteFileW(wh);
}

// ---- Logical path extraction -----------------------------------------------
//
// Produce the full Win32 path an open targets. Absolute opens carry \??\C:\...;
// relative-to-handle opens (RootDirectory set) resolve against a registered
// directory. Returns false when the target cannot be placed (e.g. relative to
// a directory we do not track), meaning "leave this open alone".
static bool ExtractLogicalPath(POBJECT_ATTRIBUTES oa, wchar_t* out, size_t cap) {
    if (!oa || !oa->ObjectName || !oa->ObjectName->Buffer) return false;
    const wchar_t* nm = oa->ObjectName->Buffer;
    int nmlen = (int)(oa->ObjectName->Length / sizeof(wchar_t));

    if (oa->RootDirectory != nullptr) {
        wchar_t base[1024];
        if (!LookupDir(oa->RootDirectory, base, _countof(base))) return false;
        // Relative name has no \??\ prefix; join with a separator.
        if (nmlen > 0 && nm[0] == L'\\')
            return _snwprintf_s(out, cap, _TRUNCATE, L"%s%.*s", base, nmlen, nm) > 0;
        return _snwprintf_s(out, cap, _TRUNCATE, L"%s\\%.*s", base, nmlen, nm) > 0;
    }

    const int pref = 4;  // "\??\"
    if (nmlen < pref || _wcsnicmp(nm, L"\\??\\", pref) != 0) return false;
    return _snwprintf_s(out, cap, _TRUNCATE, L"%.*s", nmlen - pref, nm + pref) > 0;
}

// Is a full Win32 path inside the workspace root? Fills the overlay-side path.
static bool UnderWorkspace(const wchar_t* win, wchar_t* ovOut, size_t ovCap,
                           const wchar_t** relOut) {
    if (g_wsRoot[0] == L'\0' || g_overlayRoot[0] == L'\0') return false;
    size_t wsl = wcslen(g_wsRoot);
    if (_wcsnicmp(win, g_wsRoot, wsl) != 0) return false;
    if (win[wsl] != L'\0' && win[wsl] != L'\\') return false;  // component boundary
    const wchar_t* rest = win + wsl;
    if (_snwprintf_s(ovOut, ovCap, _TRUNCATE, L"%s%s", g_overlayRoot, rest) <= 0) return false;
    if (relOut) *relOut = rest;
    return true;
}

// Overlay path for a logical ws path (or false if not under the workspace).
static bool OverlayFor(const wchar_t* logicalWin, wchar_t* ovOut, size_t cap) {
    const wchar_t* rest = nullptr;
    return UnderWorkspace(logicalWin, ovOut, cap, &rest);
}

// Decide + perform overlay routing for a logical path. Returns true and fills
// ntOut/outName (an NT path) when the open should be redirected to the overlay.
// A DELETE-access open counts as a write (via wantsWrite), so it copies up and
// routes to the overlay -- a later delete then removes the overlay copy, never
// the workspace file. The whiteout tombstone is created in the SetInformation
// hook, when a delete is actually committed.
static bool DecideRedirect(const wchar_t* logicalWin, bool wantsWrite,
                           wchar_t* ntOut, size_t ntCap, UNICODE_STRING* outName) {
    wchar_t ovPath[1024];
    const wchar_t* rest = nullptr;
    if (!UnderWorkspace(logicalWin, ovPath, _countof(ovPath), &rest)) return false;

    wchar_t wsPath[1024];
    if (_snwprintf_s(wsPath, _countof(wsPath), _TRUNCATE, L"%s%s", g_wsRoot, rest) <= 0) return false;

    if (HasWhiteout(ovPath)) {
        // The agent deleted this earlier. A write re-creates it (drop the
        // tombstone, no copy-up of the old version); a read sees it as gone
        // (redirect to the overlay, which does not hold it -> ENOENT).
        if (wantsWrite) { RemoveWhiteout(ovPath); EnsureParentDirs(ovPath); }
    } else if (!FileExists(ovPath)) {
        if (!wantsWrite) return false;  // pure read: use the workspace copy
        EnsureParentDirs(ovPath);
        DWORD wsAttr = GetFileAttributesW(wsPath);
        if (wsAttr != INVALID_FILE_ATTRIBUTES) {
            if (wsAttr & FILE_ATTRIBUTE_DIRECTORY) CreateDirectoryW(ovPath, nullptr);
            else CopyFileW(wsPath, ovPath, FALSE);  // copy-up from lead's version
        }
    }

    if (_snwprintf_s(ntOut, ntCap, _TRUNCATE, L"\\??\\%s", ovPath) <= 0) return false;
    outName->Buffer = ntOut;
    outName->Length = (USHORT)(wcslen(ntOut) * sizeof(wchar_t));
    outName->MaximumLength = outName->Length + sizeof(wchar_t);
    return true;
}

// Full resolution for an open: overlay redirect, or -- for a relative open
// under the workspace that is NOT redirected -- an absolute workspace path, so
// it never resolves against a parent handle that was itself redirected.
static bool ResolveOpen(POBJECT_ATTRIBUTES oa, bool wantsWrite,
                        wchar_t* ntOut, size_t cap, UNICODE_STRING* outName,
                        wchar_t* logicalOut, size_t logicalCap) {
    if (!ExtractLogicalPath(oa, logicalOut, logicalCap)) { logicalOut[0] = L'\0'; return false; }
    if (DecideRedirect(logicalOut, wantsWrite, ntOut, cap, outName)) return true;
    if (oa->RootDirectory != nullptr) {
        wchar_t ov[1024];
        if (OverlayFor(logicalOut, ov, _countof(ov))) {
            if (_snwprintf_s(ntOut, cap, _TRUNCATE, L"\\??\\%s", logicalOut) <= 0) return false;
            outName->Buffer = ntOut;
            outName->Length = (USHORT)(wcslen(ntOut) * sizeof(wchar_t));
            outName->MaximumLength = outName->Length + sizeof(wchar_t);
            return true;
        }
    }
    return false;
}

// ---- Hooked file opens (observe + redirect) --------------------------------

static NTSTATUS NTAPI Hook_NtCreateFile(
    PHANDLE FileHandle, ACCESS_MASK DesiredAccess,
    POBJECT_ATTRIBUTES ObjectAttributes, PIO_STATUS_BLOCK IoStatusBlock,
    PLARGE_INTEGER AllocationSize, ULONG FileAttributes, ULONG ShareAccess,
    ULONG CreateDisposition, ULONG CreateOptions, PVOID EaBuffer, ULONG EaLength) {
    POBJECT_ATTRIBUTES useOA = ObjectAttributes;
    OBJECT_ATTRIBUTES localOA;
    UNICODE_STRING localName;
    wchar_t rw[1024];
    wchar_t logical[1024];
    logical[0] = L'\0';
    bool isDir = (CreateOptions & 0x00000001) != 0;  // FILE_DIRECTORY_FILE
    if (!g_inHook) {
        g_inHook = 1;
        LogObjectName(L"NtCreateFile", ObjectAttributes);
        bool wantsWrite = WantsWriteAccess(DesiredAccess) || DispositionCreates(CreateDisposition);
        if (ResolveOpen(ObjectAttributes, wantsWrite, rw, _countof(rw), &localName,
                        logical, _countof(logical))) {
            localOA = *ObjectAttributes;
            localOA.RootDirectory = nullptr;  // name is now absolute
            localOA.ObjectName = &localName;
            useOA = &localOA;
            LogLine(wantsWrite ? L"REDIRECT-W" : L"REDIRECT-R", rw, wcslen(rw));
        }
        g_inHook = 0;
    }
    NTSTATUS st = Real_NtCreateFile(FileHandle, DesiredAccess, useOA, IoStatusBlock,
                                    AllocationSize, FileAttributes, ShareAccess, CreateDisposition,
                                    CreateOptions, EaBuffer, EaLength);
    if (st == 0 && logical[0] && FileHandle && !g_inHook) {
        g_inHook = 1;
        wchar_t ov[1024];
        if (OverlayFor(logical, ov, _countof(ov))) {
            // Determine dir-ness from the object, not the open flag: libuv opens
            // directories without FILE_DIRECTORY_FILE.
            DWORD at = GetFileAttributesW(ov);
            if (at == INVALID_FILE_ATTRIBUTES) at = GetFileAttributesW(logical);
            bool realDir = (at != INVALID_FILE_ATTRIBUTES) && (at & FILE_ATTRIBUTE_DIRECTORY);
            RegisterHandle(*FileHandle, realDir || isDir, logical);
        }
        g_inHook = 0;
    }
    return st;
}

static NTSTATUS NTAPI Hook_NtOpenFile(
    PHANDLE FileHandle, ACCESS_MASK DesiredAccess,
    POBJECT_ATTRIBUTES ObjectAttributes, PIO_STATUS_BLOCK IoStatusBlock,
    ULONG ShareAccess, ULONG OpenOptions) {
    POBJECT_ATTRIBUTES useOA = ObjectAttributes;
    OBJECT_ATTRIBUTES localOA;
    UNICODE_STRING localName;
    wchar_t rw[1024];
    wchar_t logical[1024];
    logical[0] = L'\0';
    bool isDir = (OpenOptions & 0x00000001) != 0;  // FILE_DIRECTORY_FILE
    if (!g_inHook) {
        g_inHook = 1;
        LogObjectName(L"NtOpenFile", ObjectAttributes);
        bool wantsWrite = WantsWriteAccess(DesiredAccess);  // NtOpenFile never creates
        if (ResolveOpen(ObjectAttributes, wantsWrite, rw, _countof(rw), &localName,
                        logical, _countof(logical))) {
            localOA = *ObjectAttributes;
            localOA.RootDirectory = nullptr;
            localOA.ObjectName = &localName;
            useOA = &localOA;
            LogLine(wantsWrite ? L"REDIRECT-W" : L"REDIRECT-R", rw, wcslen(rw));
        }
        g_inHook = 0;
    }
    NTSTATUS st = Real_NtOpenFile(FileHandle, DesiredAccess, useOA, IoStatusBlock,
                                  ShareAccess, OpenOptions);
    if (st == 0 && logical[0] && FileHandle && !g_inHook) {
        g_inHook = 1;
        wchar_t ov[1024];
        if (OverlayFor(logical, ov, _countof(ov))) {
            DWORD at = GetFileAttributesW(ov);
            if (at == INVALID_FILE_ATTRIBUTES) at = GetFileAttributesW(logical);
            bool realDir = (at != INVALID_FILE_ATTRIBUTES) && (at & FILE_ATTRIBUTE_DIRECTORY);
            RegisterHandle(*FileHandle, realDir || isDir, logical);
        }
        g_inHook = 0;
    }
    return st;
}

// Read-only routing for a path-based metadata query. Returns 0 = leave as is,
// 1 = redirect (ntOut/outName filled), 2 = report not-found (whiteouted).
static int QueryDecide(POBJECT_ATTRIBUTES oa, wchar_t* ntOut, size_t cap,
                       UNICODE_STRING* outName) {
    wchar_t logical[1024], ov[1024];
    if (!ExtractLogicalPath(oa, logical, _countof(logical))) return 0;
    if (!OverlayFor(logical, ov, _countof(ov))) return 0;   // not under workspace
    if (HasWhiteout(ov)) return 2;                           // deleted: gone
    const wchar_t* target = FileExists(ov) ? ov : nullptr;   // copied up?
    if (!target && oa->RootDirectory == nullptr) return 0;   // absolute read: query ws
    // Copied up, or a relative query we must pin to an absolute workspace path.
    if (_snwprintf_s(ntOut, cap, _TRUNCATE, L"\\??\\%s", target ? target : logical) <= 0) return 0;
    outName->Buffer = ntOut;
    outName->Length = (USHORT)(wcslen(ntOut) * sizeof(wchar_t));
    outName->MaximumLength = outName->Length + sizeof(wchar_t);
    return 1;
}

static NTSTATUS NTAPI Hook_NtQueryAttributesFile(POBJECT_ATTRIBUTES oa, PVOID info) {
    POBJECT_ATTRIBUTES useOA = oa;
    OBJECT_ATTRIBUTES localOA;
    UNICODE_STRING localName;
    wchar_t rw[1024];
    if (!g_inHook) {
        g_inHook = 1;
        int d = QueryDecide(oa, rw, _countof(rw), &localName);
        g_inHook = 0;
        if (d == 2) return STATUS_OBJECT_NAME_NOT_FOUND;
        if (d == 1) {
            localOA = *oa; localOA.RootDirectory = nullptr; localOA.ObjectName = &localName;
            useOA = &localOA;
        }
    }
    return Real_NtQueryAttributesFile(useOA, info);
}

static NTSTATUS NTAPI Hook_NtQueryFullAttributesFile(POBJECT_ATTRIBUTES oa, PVOID info) {
    POBJECT_ATTRIBUTES useOA = oa;
    OBJECT_ATTRIBUTES localOA;
    UNICODE_STRING localName;
    wchar_t rw[1024];
    if (!g_inHook) {
        g_inHook = 1;
        int d = QueryDecide(oa, rw, _countof(rw), &localName);
        g_inHook = 0;
        if (d == 2) return STATUS_OBJECT_NAME_NOT_FOUND;
        if (d == 1) {
            localOA = *oa; localOA.RootDirectory = nullptr; localOA.ObjectName = &localName;
            useOA = &localOA;
        }
    }
    return Real_NtQueryFullAttributesFile(useOA, info);
}

// ---- Directory-listing merge (milestone 4b) --------------------------------
//
// For a tracked workspace directory whose overlay side exists, we serve the
// union of the two directories: overlay entries first, then workspace entries
// not shadowed by them, with ".wh.*" tombstones removed and the names they
// hide dropped. Per handle we build the merged name list once and pack it into
// the caller's buffer across successive queries, in the info class it asked for.

struct NameList { wchar_t* buf; int cap; int count; };  // fixed 260-wchar rows

static void NL_Add(NameList* nl, const wchar_t* name) {
    if (nl->count >= nl->cap) {
        int cap = nl->cap ? nl->cap * 2 : 128;
        wchar_t* nb = (wchar_t*)HeapReAlloc(GetProcessHeap(), 0, nl->buf ? nl->buf : nullptr,
                                            (SIZE_T)cap * 260 * sizeof(wchar_t));
        if (!nb) {
            wchar_t* alt = (wchar_t*)HeapAlloc(GetProcessHeap(), 0, (SIZE_T)cap * 260 * sizeof(wchar_t));
            if (!alt) return;
            if (nl->buf) { memcpy(alt, nl->buf, (SIZE_T)nl->count * 260 * sizeof(wchar_t)); HeapFree(GetProcessHeap(), 0, nl->buf); }
            nb = alt;
        }
        nl->buf = nb; nl->cap = cap;
    }
    wcscpy_s(nl->buf + (size_t)nl->count * 260, 260, name);
    nl->count++;
}

static bool NL_Has(const NameList* nl, const wchar_t* name) {
    for (int i = 0; i < nl->count; ++i)
        if (_wcsicmp(nl->buf + (size_t)i * 260, name) == 0) return true;
    return false;
}

static void EnumDir(const wchar_t* dir, void (*cb)(const wchar_t*, void*), void* ctx) {
    wchar_t pat[1024];
    if (_snwprintf_s(pat, _countof(pat), _TRUNCATE, L"%s\\*", dir) <= 0) return;
    WIN32_FIND_DATAW fd;
    HANDLE h = FindFirstFileW(pat, &fd);
    if (h == INVALID_HANDLE_VALUE) return;
    do {
        if (wcscmp(fd.cFileName, L".") == 0 || wcscmp(fd.cFileName, L"..") == 0) continue;
        cb(fd.cFileName, ctx);
    } while (FindNextFileW(h, &fd));
    FindClose(h);
}

struct BuildCtx { NameList* out; NameList* whiteout; };
static void CbOverlay(const wchar_t* name, void* p) {
    BuildCtx* c = (BuildCtx*)p;
    if (_wcsnicmp(name, L".wh.", 4) == 0) NL_Add(c->whiteout, name + 4);
    else NL_Add(c->out, name);
}
static void CbWorkspace(const wchar_t* name, void* p) {
    BuildCtx* c = (BuildCtx*)p;
    if (NL_Has(c->out, name) || NL_Has(c->whiteout, name)) return;
    NL_Add(c->out, name);
}

// Build the merged listing for a workspace directory into out.
static void BuildMergedNames(const wchar_t* wsDir, const wchar_t* ovDir, NameList* out) {
    NameList wh = { nullptr, 0, 0 };
    BuildCtx ctx = { out, &wh };
    EnumDir(ovDir, CbOverlay, &ctx);
    EnumDir(wsDir, CbWorkspace, &ctx);
    if (wh.buf) HeapFree(GetProcessHeap(), 0, wh.buf);
}

// Per-handle enumeration cursor over a merged name list.
struct EnumState { HANDLE h; NameList names; int idx; };
static EnumState g_enum[256];
static CRITICAL_SECTION g_enumLock;

static EnumState* EnumGet(HANDLE h, bool create) {
    EnumState* found = nullptr;
    EnterCriticalSection(&g_enumLock);
    for (int i = 0; i < 256; ++i) if (g_enum[i].h == h) { found = &g_enum[i]; break; }
    if (!found && create)
        for (int i = 0; i < 256; ++i) if (g_enum[i].h == nullptr) {
            g_enum[i].h = h; g_enum[i].names = { nullptr, 0, 0 }; g_enum[i].idx = 0;
            found = &g_enum[i]; break;
        }
    LeaveCriticalSection(&g_enumLock);
    return found;
}

static void EnumFree(HANDLE h) {
    EnterCriticalSection(&g_enumLock);
    for (int i = 0; i < 256; ++i) if (g_enum[i].h == h) {
        if (g_enum[i].names.buf) HeapFree(GetProcessHeap(), 0, g_enum[i].names.buf);
        g_enum[i].h = nullptr; g_enum[i].names = { nullptr, 0, 0 }; g_enum[i].idx = 0; break;
    }
    LeaveCriticalSection(&g_enumLock);
}

// Layout of a directory-info class: where FileNameLength and FileName sit, and
// whether the fixed metadata block is present. Returns false for classes we do
// not synthesize (the query then passes through unmerged).
static bool ClassLayout(ULONG cls, int* fnLenOff, int* nameOff, bool* hasMeta) {
    switch (cls) {
        case 1:  *fnLenOff = 60; *nameOff = 64;  *hasMeta = true;  return true;  // Directory
        case 2:  *fnLenOff = 60; *nameOff = 68;  *hasMeta = true;  return true;  // FullDir
        case 3:  *fnLenOff = 60; *nameOff = 94;  *hasMeta = true;  return true;  // BothDir
        case 12: *fnLenOff = 8;  *nameOff = 12;  *hasMeta = false; return true;  // Names
        case 37: *fnLenOff = 60; *nameOff = 104; *hasMeta = true;  return true;  // IdBothDir
        case 38: *fnLenOff = 60; *nameOff = 76;  *hasMeta = true;  return true;  // IdFullDir
        default: return false;
    }
}

static void Put64(BYTE* p, int off, LONGLONG v) { *reinterpret_cast<LONGLONG*>(p + off) = v; }
static void Put32(BYTE* p, int off, ULONG v)    { *reinterpret_cast<ULONG*>(p + off) = v; }

// Fill one entry for `name` in class `cls`; returns the entry size (name incl.).
static int PackEntry(BYTE* dst, ULONG cls, const wchar_t* name,
                     const wchar_t* wsDir, const wchar_t* ovDir) {
    int fnLenOff, nameOff; bool hasMeta;
    if (!ClassLayout(cls, &fnLenOff, &nameOff, &hasMeta)) return 0;
    int nameBytes = (int)(wcslen(name) * sizeof(wchar_t));
    memset(dst, 0, nameOff);
    if (hasMeta) {
        wchar_t path[1024];
        WIN32_FILE_ATTRIBUTE_DATA fad = {};
        if (_snwprintf_s(path, _countof(path), _TRUNCATE, L"%s\\%s", ovDir, name) > 0 &&
            GetFileAttributesExW(path, GetFileExInfoStandard, &fad)) {
        } else if (_snwprintf_s(path, _countof(path), _TRUNCATE, L"%s\\%s", wsDir, name) > 0) {
            GetFileAttributesExW(path, GetFileExInfoStandard, &fad);
        }
        LONGLONG size = ((LONGLONG)fad.nFileSizeHigh << 32) | fad.nFileSizeLow;
        Put64(dst, 8,  *reinterpret_cast<LONGLONG*>(&fad.ftCreationTime));
        Put64(dst, 16, *reinterpret_cast<LONGLONG*>(&fad.ftLastAccessTime));
        Put64(dst, 24, *reinterpret_cast<LONGLONG*>(&fad.ftLastWriteTime));
        Put64(dst, 32, *reinterpret_cast<LONGLONG*>(&fad.ftLastWriteTime));  // ChangeTime
        Put64(dst, 40, size);
        Put64(dst, 48, size);
        Put32(dst, 56, fad.dwFileAttributes ? fad.dwFileAttributes : FILE_ATTRIBUTE_NORMAL);
    }
    Put32(dst, fnLenOff, (ULONG)nameBytes);
    memcpy(dst + nameOff, name, nameBytes);
    return nameOff + nameBytes;
}

// Serve the merged listing into the caller's buffer. Returns the NT status and
// sets *info to the bytes written. `handled` is false when we do not take over.
static NTSTATUS MergedServe(HANDLE h, PVOID buffer, ULONG length, ULONG cls,
                            bool restart, bool singleEntry, PUNICODE_STRING pattern,
                            ULONG_PTR* info, bool* handled) {
    *handled = false;
    int fnLenOff, nameOff; bool hasMeta;
    if (!ClassLayout(cls, &fnLenOff, &nameOff, &hasMeta)) return 0;

    wchar_t logical[1024], ovDir[1024];
    if (!LookupDir(h, logical, _countof(logical))) return 0;      // not a tracked ws dir
    if (!OverlayFor(logical, ovDir, _countof(ovDir))) return 0;
    if (!FileExists(ovDir)) return 0;                             // nothing to merge
    if (pattern && pattern->Buffer && pattern->Length &&
        !(pattern->Length == sizeof(wchar_t) && pattern->Buffer[0] == L'*')) return 0;  // specific query

    *handled = true;
    EnumState* st = EnumGet(h, true);
    if (!st) { *info = 0; return STATUS_NO_MORE_FILES; }
    if (restart || (st->names.buf == nullptr && st->idx == 0)) {
        if (st->names.buf) { HeapFree(GetProcessHeap(), 0, st->names.buf); st->names = { nullptr, 0, 0 }; }
        st->idx = 0;
        BuildMergedNames(logical, ovDir, &st->names);
    }

    BYTE* base = (BYTE*)buffer;
    ULONG used = 0;
    int packed = 0;
    BYTE* prev = nullptr;
    while (st->idx < st->names.count) {
        const wchar_t* name = st->names.buf + (size_t)st->idx * 260;
        int need = nameOff + (int)(wcslen(name) * sizeof(wchar_t));
        ULONG start = (used + 7) & ~7u;
        if (start + (ULONG)need > length) break;   // no room for this entry
        BYTE* dst = base + start;
        int wrote = PackEntry(dst, cls, name, logical, ovDir);
        if (wrote <= 0) { st->idx++; continue; }
        Put32(dst, 0, 0);                          // NextEntryOffset: 0 = last
        if (prev) Put32(prev, 0, (ULONG)(dst - prev));  // link previous -> this
        prev = dst;
        used = start + (ULONG)wrote;
        packed++;
        st->idx++;
        if (singleEntry) break;
    }

    *info = used;
    if (packed == 0)
        return (st->idx < st->names.count) ? STATUS_BUFFER_OVERFLOW : STATUS_NO_MORE_FILES;
    return 0;  // STATUS_SUCCESS
}

static NTSTATUS NTAPI Hook_NtQueryDirectoryFile(
    HANDLE FileHandle, HANDLE Event, PVOID Apc, PVOID ApcCtx,
    PIO_STATUS_BLOCK IoStatusBlock, PVOID FileInformation, ULONG Length,
    ULONG FileInformationClass, BOOLEAN ReturnSingleEntry,
    PUNICODE_STRING FileName, BOOLEAN RestartScan) {
    if (!g_inHook) {
        g_inHook = 1;
        ULONG_PTR info = 0; bool handled = false;
        NTSTATUS st = MergedServe(FileHandle, FileInformation, Length, FileInformationClass,
                                  RestartScan != 0, ReturnSingleEntry != 0, FileName, &info, &handled);
        g_inHook = 0;
        if (handled) {
            if (IoStatusBlock) { IoStatusBlock->Status = st; IoStatusBlock->Information = info; }
            return st;
        }
    }
    return Real_NtQueryDirectoryFile(FileHandle, Event, Apc, ApcCtx, IoStatusBlock,
                                     FileInformation, Length, FileInformationClass,
                                     ReturnSingleEntry, FileName, RestartScan);
}

static NTSTATUS NTAPI Hook_NtQueryDirectoryFileEx(
    HANDLE FileHandle, HANDLE Event, PVOID Apc, PVOID ApcCtx,
    PIO_STATUS_BLOCK IoStatusBlock, PVOID FileInformation, ULONG Length,
    ULONG FileInformationClass, ULONG QueryFlags, PUNICODE_STRING FileName) {
    if (!g_inHook) {
        g_inHook = 1;
        ULONG_PTR info = 0; bool handled = false;
        bool restart = (QueryFlags & 0x1) != 0;       // SL_RESTART_SCAN
        bool single  = (QueryFlags & 0x2) != 0;       // SL_RETURN_SINGLE_ENTRY
        NTSTATUS st = MergedServe(FileHandle, FileInformation, Length, FileInformationClass,
                                  restart, single, FileName, &info, &handled);
        g_inHook = 0;
        if (handled) {
            if (IoStatusBlock) { IoStatusBlock->Status = st; IoStatusBlock->Information = info; }
            return st;
        }
    }
    return Real_NtQueryDirectoryFileEx(FileHandle, Event, Apc, ApcCtx, IoStatusBlock,
                                       FileInformation, Length, FileInformationClass,
                                       QueryFlags, FileName);
}

// FILE_RENAME_INFORMATION on x64: Flags/ReplaceIfExists @0 (4 + 4 pad),
// RootDirectory @8, FileNameLength @16, FileName @20. Reroute the target into
// the overlay and whiteout the source, so a rename never writes the workspace.
// Returns a heap buffer the caller must free, or nullptr to use the original.
static PVOID RerouteRename(HANDLE h, PVOID info, ULONG len, ULONG* newLen) {
    if (len < 20) return nullptr;
    BYTE* p = (BYTE*)info;
    ULONG flags = *reinterpret_cast<ULONG*>(p + 0);
    HANDLE rootDir = *reinterpret_cast<HANDLE*>(p + 8);
    ULONG fnLen = *reinterpret_cast<ULONG*>(p + 16);
    if ((ULONG)20 + fnLen > len) return nullptr;
    const wchar_t* name = reinterpret_cast<const wchar_t*>(p + 20);
    int nameChars = (int)(fnLen / sizeof(wchar_t));

    // Source moves away: whiteout its overlay path.
    wchar_t srcLogical[1024], srcOv[1024];
    if (LookupHandle(h, srcLogical, _countof(srcLogical)) &&
        OverlayFor(srcLogical, srcOv, _countof(srcOv))) {
        MakeWhiteout(srcOv);
        LogLine(L"RENAME-SRC", srcLogical, wcslen(srcLogical));
    }

    // Resolve the target to a logical Win32 path.
    wchar_t targetLogical[1024];
    bool haveTarget = false;
    if (rootDir == nullptr) {
        if (nameChars >= 4 && _wcsnicmp(name, L"\\??\\", 4) == 0) {
            _snwprintf_s(targetLogical, _countof(targetLogical), _TRUNCATE,
                         L"%.*s", nameChars - 4, name + 4);
            haveTarget = true;
        }
    } else {
        wchar_t base[1024];
        if (LookupDir(rootDir, base, _countof(base))) {
            if (nameChars > 0 && name[0] == L'\\')
                _snwprintf_s(targetLogical, _countof(targetLogical), _TRUNCATE, L"%s%.*s", base, nameChars, name);
            else
                _snwprintf_s(targetLogical, _countof(targetLogical), _TRUNCATE, L"%s\\%.*s", base, nameChars, name);
            haveTarget = true;
        }
    }
    if (!haveTarget) return nullptr;

    wchar_t ovTarget[1024];
    if (!OverlayFor(targetLogical, ovTarget, _countof(ovTarget))) return nullptr;  // outside ws: leave

    EnsureParentDirs(ovTarget);
    RemoveWhiteout(ovTarget);  // the target now exists

    wchar_t ntTarget[1100];
    if (_snwprintf_s(ntTarget, _countof(ntTarget), _TRUNCATE, L"\\??\\%s", ovTarget) <= 0) return nullptr;
    ULONG tBytes = (ULONG)(wcslen(ntTarget) * sizeof(wchar_t));
    ULONG sz = 20 + tBytes;
    BYTE* out = (BYTE*)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, sz);
    if (!out) return nullptr;
    *reinterpret_cast<ULONG*>(out + 0) = flags;
    *reinterpret_cast<HANDLE*>(out + 8) = nullptr;   // absolute target: no root
    *reinterpret_cast<ULONG*>(out + 16) = tBytes;
    memcpy(out + 20, ntTarget, tBytes);
    *newLen = sz;
    LogLine(L"RENAME-DST", ntTarget, wcslen(ntTarget));
    return out;
}

// A delete or rename committed on a tracked (overlay) handle. A delete lays a
// whiteout; a rename reroutes its target into the overlay and whiteouts the
// source. Either way the workspace is never written.
static NTSTATUS NTAPI Hook_NtSetInformationFile(
    HANDLE FileHandle, PIO_STATUS_BLOCK IoStatusBlock,
    PVOID FileInformation, ULONG Length, ULONG FileInformationClass) {
    if (!g_inHook && FileInformation) {
        // Rename: FileRenameInformation == 10, FileRenameInformationEx == 65.
        if (FileInformationClass == 10 || FileInformationClass == 65) {
            g_inHook = 1;
            ULONG nl = 0;
            PVOID ni = RerouteRename(FileHandle, FileInformation, Length, &nl);
            g_inHook = 0;
            if (ni) {
                NTSTATUS st = Real_NtSetInformationFile(FileHandle, IoStatusBlock, ni, nl,
                                                        FileInformationClass);
                HeapFree(GetProcessHeap(), 0, ni);
                return st;
            }
        }
        bool deleting = false;
        if (FileInformationClass == 13 && Length >= 1) {          // Disposition
            deleting = *reinterpret_cast<BYTE*>(FileInformation) != 0;
        } else if (FileInformationClass == 64 && Length >= 4) {   // DispositionEx
            deleting = (*reinterpret_cast<ULONG*>(FileInformation) & 0x1) != 0;
        }
        if (deleting) {
            g_inHook = 1;
            wchar_t logical[1024], ov[1024];
            if (LookupHandle(FileHandle, logical, _countof(logical)) &&
                OverlayFor(logical, ov, _countof(ov))) {
                MakeWhiteout(ov);
                LogLine(L"WHITEOUT", logical, wcslen(logical));
            }
            g_inHook = 0;
        }
    }
    return Real_NtSetInformationFile(FileHandle, IoStatusBlock, FileInformation,
                                     Length, FileInformationClass);
}

// Forget a handle when it closes, so the registry does not confuse a reused
// handle value with the directory or file it used to name.
static NTSTATUS NTAPI Hook_NtClose(HANDLE Handle) {
    if (!g_inHook) {
        g_inHook = 1;
        UnregisterDir(Handle);
        EnumFree(Handle);
        g_inHook = 0;
    }
    return Real_NtClose(Handle);
}

// ---- Child propagation: inject ourselves into any spawned process ----------

static BOOL WINAPI Hook_CreateProcessW(
    LPCWSTR appName, LPWSTR cmdLine, LPSECURITY_ATTRIBUTES pa, LPSECURITY_ATTRIBUTES ta,
    BOOL inherit, DWORD flags, LPVOID env, LPCWSTR cwd, LPSTARTUPINFOW si,
    LPPROCESS_INFORMATION pi) {
    LPCSTR dll = nullptr;
    char dllA[MAX_PATH];
    if (WideCharToMultiByte(CP_ACP, 0, g_dllPath, -1, dllA, sizeof(dllA), nullptr, nullptr) > 0) {
        dll = dllA;
    }
    // DetourCreateProcessWithDllExW starts the child with our DLL already loaded,
    // so the child's own CreateProcess calls are hooked in turn -> whole tree.
    return DetourCreateProcessWithDllExW(appName, cmdLine, pa, ta, inherit, flags, env, cwd,
                                         si, pi, dll, Real_CreateProcessW);
}

static BOOL WINAPI Hook_CreateProcessA(
    LPCSTR appName, LPSTR cmdLine, LPSECURITY_ATTRIBUTES pa, LPSECURITY_ATTRIBUTES ta,
    BOOL inherit, DWORD flags, LPVOID env, LPCSTR cwd, LPSTARTUPINFOA si,
    LPPROCESS_INFORMATION pi) {
    char dllA[MAX_PATH];
    LPCSTR dll = nullptr;
    if (WideCharToMultiByte(CP_ACP, 0, g_dllPath, -1, dllA, sizeof(dllA), nullptr, nullptr) > 0) {
        dll = dllA;
    }
    return DetourCreateProcessWithDllExA(appName, cmdLine, pa, ta, inherit, flags, env, cwd,
                                         si, pi, dll, Real_CreateProcessA);
}

// ---- Attach / detach -------------------------------------------------------

static void AttachHooks() {
    HMODULE ntdll = GetModuleHandleW(L"ntdll.dll");
    Real_NtCreateFile = (PFN_NtCreateFile)GetProcAddress(ntdll, "NtCreateFile");
    Real_NtOpenFile   = (PFN_NtOpenFile)GetProcAddress(ntdll, "NtOpenFile");
    Real_NtSetInformationFile = (PFN_NtSetInformationFile)GetProcAddress(ntdll, "NtSetInformationFile");
    Real_NtClose = (PFN_NtClose)GetProcAddress(ntdll, "NtClose");
    Real_NtQueryAttributesFile = (PFN_NtQueryAttributesFile)GetProcAddress(ntdll, "NtQueryAttributesFile");
    Real_NtQueryFullAttributesFile = (PFN_NtQueryFullAttributesFile)GetProcAddress(ntdll, "NtQueryFullAttributesFile");
    Real_NtQueryDirectoryFile = (PFN_NtQueryDirectoryFile)GetProcAddress(ntdll, "NtQueryDirectoryFile");
    Real_NtQueryDirectoryFileEx = (PFN_NtQueryDirectoryFileEx)GetProcAddress(ntdll, "NtQueryDirectoryFileEx");

    DetourTransactionBegin();
    DetourUpdateThread(GetCurrentThread());
    if (Real_NtCreateFile) DetourAttach(&(PVOID&)Real_NtCreateFile, Hook_NtCreateFile);
    if (Real_NtOpenFile)   DetourAttach(&(PVOID&)Real_NtOpenFile, Hook_NtOpenFile);
    if (Real_NtSetInformationFile) DetourAttach(&(PVOID&)Real_NtSetInformationFile, Hook_NtSetInformationFile);
    if (Real_NtClose)      DetourAttach(&(PVOID&)Real_NtClose, Hook_NtClose);
    if (Real_NtQueryAttributesFile) DetourAttach(&(PVOID&)Real_NtQueryAttributesFile, Hook_NtQueryAttributesFile);
    if (Real_NtQueryFullAttributesFile) DetourAttach(&(PVOID&)Real_NtQueryFullAttributesFile, Hook_NtQueryFullAttributesFile);
    if (Real_NtQueryDirectoryFile) DetourAttach(&(PVOID&)Real_NtQueryDirectoryFile, Hook_NtQueryDirectoryFile);
    if (Real_NtQueryDirectoryFileEx) DetourAttach(&(PVOID&)Real_NtQueryDirectoryFileEx, Hook_NtQueryDirectoryFileEx);
    DetourAttach(&(PVOID&)Real_CreateProcessW, Hook_CreateProcessW);
    DetourAttach(&(PVOID&)Real_CreateProcessA, Hook_CreateProcessA);
    DetourTransactionCommit();
}

static void DetachHooks() {
    DetourTransactionBegin();
    DetourUpdateThread(GetCurrentThread());
    if (Real_NtCreateFile) DetourDetach(&(PVOID&)Real_NtCreateFile, Hook_NtCreateFile);
    if (Real_NtOpenFile)   DetourDetach(&(PVOID&)Real_NtOpenFile, Hook_NtOpenFile);
    if (Real_NtSetInformationFile) DetourDetach(&(PVOID&)Real_NtSetInformationFile, Hook_NtSetInformationFile);
    if (Real_NtClose)      DetourDetach(&(PVOID&)Real_NtClose, Hook_NtClose);
    if (Real_NtQueryAttributesFile) DetourDetach(&(PVOID&)Real_NtQueryAttributesFile, Hook_NtQueryAttributesFile);
    if (Real_NtQueryFullAttributesFile) DetourDetach(&(PVOID&)Real_NtQueryFullAttributesFile, Hook_NtQueryFullAttributesFile);
    if (Real_NtQueryDirectoryFile) DetourDetach(&(PVOID&)Real_NtQueryDirectoryFile, Hook_NtQueryDirectoryFile);
    if (Real_NtQueryDirectoryFileEx) DetourDetach(&(PVOID&)Real_NtQueryDirectoryFileEx, Hook_NtQueryDirectoryFileEx);
    DetourDetach(&(PVOID&)Real_CreateProcessW, Hook_CreateProcessW);
    DetourDetach(&(PVOID&)Real_CreateProcessA, Hook_CreateProcessA);
    DetourTransactionCommit();
}

// DetourFinishHelperProcess is implemented by the Detours lib; hook.def exports
// it at ordinal 1, as DetourCreateProcessWithDllEx requires. We do not redefine.

BOOL WINAPI DllMain(HINSTANCE hinst, DWORD reason, LPVOID) {
    if (DetourIsHelperProcess()) return TRUE;

    if (reason == DLL_PROCESS_ATTACH) {
        DetourRestoreAfterWith();
        InitializeCriticalSection(&g_logLock);
        InitializeCriticalSection(&g_regLock);
        InitializeCriticalSection(&g_enumLock);
        GetModuleFileNameW(hinst, g_dllPath, _countof(g_dllPath));
        GetEnvironmentVariableW(L"CEREBRILINE_SANDBOX_LOG", g_logPath, _countof(g_logPath));
        GetEnvironmentVariableW(L"CEREBRILINE_WS_ROOT", g_wsRoot, _countof(g_wsRoot));
        GetEnvironmentVariableW(L"CEREBRILINE_OVERLAY_ROOT", g_overlayRoot, _countof(g_overlayRoot));
        AttachHooks();
    } else if (reason == DLL_PROCESS_DETACH) {
        DetachHooks();
        DeleteCriticalSection(&g_logLock);
    }
    return TRUE;
}
